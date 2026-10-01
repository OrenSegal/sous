#!/usr/bin/env bash
# sous-guard: Claude Code PreToolUse hook for the Bash tool.
#
# Hard-stops agent slips that settings.json Bash deny rules miss, because deny
# rules match the command text Claude usually writes, not the program:
#   delete   rm with recursive+force (any spelling), git clean -f, find -delete,
#            rsync --delete
#   push     --force*, -f, +ref, --mirror, --delete, -d, :ref
#   secrets  any command naming .env* (bar .example/.sample/.template/.dist),
#            ~/.ssh, ~/.aws, ~/.gnupg -- except ls / git / test / stat
#   build    decode or fetch piped into a shell, bash <(curl ...), eval of a
#            decoded or fetched string
#
# Two ways to use it:
#   executed  reads the hook JSON on stdin; exit 2 blocks, stderr goes to the model
#   sourced   `. sous-guard.sh; sous_guard "$cmd" || exit 2` from a larger hook
#
# A text matcher, not a boundary: commands assembled at runtime ($var, $(...))
# get past it. The OS sandbox (settings.json "sandbox": denyRead, write scope,
# network allowlist) is the boundary; this catches the agent's own slips and the
# common injection shapes early, with a message that says what to do instead.
# Red-team corpus and known gaps: tests/adversarial.test.sh. Runs on bash 3.2.

# Prints the block reason and returns 1 when $1 must not run; returns 0 otherwise.
# Every block appends "epoch<TAB>reason" to $SOUS_LOG (default
# ~/.claude/sous/blocks.tsv; SOUS_LOG=off disables). Reason only, never the
# command: command text can carry secrets. `sous report` reads it back so the
# rules get tuned from what fired, not from memory.
sous_guard() {
  local reason
  reason=$(_sous_match "$1") && return 0
  printf '%s\n' "$reason"
  local log="${SOUS_LOG:-$HOME/.claude/sous/blocks.tsv}"
  if [[ $log != off ]]; then
    { mkdir -p "$(dirname "$log")" && printf '%s\t%s\n' "$(date +%s)" "$reason" >>"$log"; } 2>/dev/null
  fi
  return 1
}

_sous_match() {
  # C locale: bash 3.2 string ops are many times slower under UTF-8.
  local LC_ALL=C
  local cmd="$1" scan="" line trim m norm seg first rest flags args tok

  # 1. Heredoc bodies are data (a commit message naming `rm -rf`) unless the
  #    heredoc feeds an interpreter, or its delimiter is unquoted and the body
  #    holds $(...) or backticks (bash runs those). Text after the closing
  #    delimiter still counts. Openers are found by a quote-aware scan
  #    (_sous_heredocs), so `echo "<<X"`, `# <<X`, `$((1<<X))` and `<<<X` don't
  #    hide later lines. Whenever that scan is unsure, nothing is hidden.
  if [[ $cmd == *'<<'* ]] && _sous_split_heredocs "$cmd"; then
    scan="$_sous_scan"
  else
    scan="$cmd"
  fi

  # 2. Message arguments are data too: git commit -m "...", gh pr --body/--title.
  #    Only for git/gh, and only a message that can't expand ($ or backtick
  #    inside double quotes runs code, so that text stays in the scan).
  local sq="'" dq='"' bt='`' lf=$'\n'
  local re_msg_pre="((^|[;&|(${lf}])[[:space:]]*(git|gh)[[:space:]]([^;&|${sq}${dq}${bt}\$]*[[:space:]])?)"
  local re_msg_flag='(-[[:alpha:]]*m|-[bt]|--message|--body|--title|--notes)[[:space:]]+'
  local re_msg_dq="${re_msg_pre}${re_msg_flag}${dq}[^${dq}\$${bt}\\\\]*${dq}"
  local re_msg_sq="${re_msg_pre}${re_msg_flag}${sq}[^${sq}]*${sq}"
  while [[ $scan =~ $re_msg_dq || $scan =~ $re_msg_sq ]]; do
    m="${BASH_REMATCH[0]}"
    scan="${scan/"$m"/${BASH_REMATCH[1]}MSG}"
  done

  # 2b. A jq/yq filter is a program, not a path: in `jq '.env' f`, `.env` is a key.
  #     Blank the first positional at command position. Anything that can expand
  #     ($, backtick, <, >) or a -f filter file keeps the text, so the secrets check sees it.
  local jv="([^[:space:]\$${bt}${sq}${dq}()]+|${sq}[^${sq}]*${sq}|${dq}[^${dq}\$${bt}]*${dq})"
  local jf="(${sq}[^${sq}]*${sq}|${dq}[^${dq}\$${bt}]*${dq}|[^-[:space:]${sq}${dq}|;&\$${bt}<>()][^[:space:]${sq}${dq}|;&\$${bt}<>()]*)"
  local re_jq="(^|[;&|(${bt}${lf}])[[:space:]]*(jq|yq|gojq)(([[:space:]]+(--(arg|argjson|slurpfile|rawfile)[[:space:]]+${jv}[[:space:]]+${jv}|--indent[[:space:]]+[0-9]+|-[[:alpha:]]+|--[[:alpha:]-]+))*)[[:space:]]+${jf}"
  local jout="" jrest="$scan" jm jflags jfilt
  while [[ $jrest =~ $re_jq ]]; do
    jm="${BASH_REMATCH[0]}"
    jflags=" ${BASH_REMATCH[3]} "
    jfilt="${BASH_REMATCH[$(( ${#BASH_REMATCH[@]} - 1 ))]}"
    jout+="${jrest%%"$jm"*}"
    if [[ $jflags =~ [[:space:]](-[[:alpha:]]*f[[:alpha:]]*|--from-file)[[:space:]] ]]; then
      jout+="$jm"
    else
      jout+="${jm%"$jfilt"}F"
    fi
    jrest="${jrest#*"$jm"}"
  done
  scan="$jout$jrest"

  # 3. Normalize: quotes and backslashes don't change which program runs.
  #    Past a few KB, ${var//x/} is quadratic in bash 3.2 (tens of seconds on a
  #    16KB command, past the hook timeout), so long text goes through tr.
  if (( ${#scan} > 2048 )); then
    norm=$(printf '%s' "$scan" | tr -d "\"'\\\\")
  else
    norm="${scan//\"/}"
    norm="${norm//\'/}"
    norm="${norm//\\/}"
  fi

  # 4. Recursive force delete. Collect each rm's flag run, then test the flags.
  local re_rm='(^|[^[:alnum:]_./-])(/bin/|/usr/bin/)?rm(([[:space:]]+-[-[:alnum:]]*)+)'
  rest="$norm"
  while [[ $rest =~ $re_rm ]]; do
    flags=" ${BASH_REMATCH[3]} "
    rest="${rest#*"${BASH_REMATCH[0]}"}"
    if [[ $flags =~ [[:space:]](-[[:alpha:]]*[rR]|--recursive)[[:space:]] ]] &&
       [[ $flags =~ [[:space:]](-[[:alpha:]]*f[[:alpha:]]*|--force)[[:space:]] ]] ||
       [[ $flags =~ [[:space:]]-[[:alpha:]]*[rR][[:alpha:]]*[[:space:]] && $flags =~ [[:space:]]-[[:alpha:]]*f ]]; then
      echo "BLOCKED (sous): recursive force delete. Name the files, list them first, or ask the user."
      return 1
    fi
  done
  local re_clean='git[[:space:]]+([^|;&]*[[:space:]])?clean(([[:space:]]+-[-[:alnum:]]*)+)'
  if [[ $norm =~ $re_clean ]]; then
    flags=" ${BASH_REMATCH[2]} "
    if [[ $flags =~ [[:space:]](-[[:alpha:]]*f|--force) && ! $flags =~ [[:space:]](-[[:alpha:]]*n|--dry-run) ]]; then
      echo "BLOCKED (sous): git clean deletes untracked work. Run git clean -n and show the user the list."
      return 1
    fi
  fi
  if [[ $norm =~ (^|[^[:alnum:]_])find[[:space:]][^|\;\&]*-delete ]]; then
    echo "BLOCKED (sous): find -delete. Run the same find with -print, then delete named paths."
    return 1
  fi
  if [[ $norm =~ (^|[^[:alnum:]_])rsync[[:space:]][^|\;\&]*--delete ]]; then
    echo "BLOCKED (sous): rsync --delete removes files at the destination. Ask the user."
    return 1
  fi

  # 5. Destructive push: force, mirror, remote-branch delete.
  local re_push='git[[:space:]]+([^|;&]*[[:space:]])?push([[:space:]]+[^|;&[:space:]]+)*'
  if [[ $norm =~ $re_push ]]; then
    args=" ${BASH_REMATCH[0]#*push} "
    if [[ $args =~ [[:space:]](--force|--mirror|--delete) ]] ||
       [[ $args =~ [[:space:]]-[[:alpha:]]*[fd][[:alpha:]]*[[:space:]] ]] ||
       [[ $args =~ [[:space:]][+:][^[:space:]] ]]; then
      echo "BLOCKED (sous): force, mirror or delete push. Ask the user; they run it themselves with ! if they want it."
      return 1
    fi
  fi

  # 6. Secrets: per command segment, any mention of a secrets path, unless the
  #    segment's program only lists or stats it.
  local segs="$norm" allow_re='^(ls|git|test|\[|stat)$'
  local re_env='(^|[^[:alnum:]_])(\.en[v?*][[:alnum:]_.*?-]*)'
  local re_home='(~|\$HOME|\$\{HOME\}|/Users/[^/[:space:]]+|/home/[^/[:space:]]+)/\.(ssh|aws|gnupg)([/[:space:]]|$)'
  # Separators as quoted variables: bash 3.2 can't parse `<(` or `$(` inline here.
  local nl=$'\n' sep
  if (( ${#segs} > 2048 )); then
    segs=$(printf '%s' "$segs" | awk '{ gsub(/[;|&`]|\$\(|<\(/, "\n"); print }')
  else
    for sep in '&&' '||' ';' '|' '&' '$(' '<(' '`'; do
      segs="${segs//"$sep"/$nl}"
    done
  fi
  # Word-split each segment with globbing off, so `.env*` stays text instead of
  # expanding against the cwd (bash 3.2 has no `local -`, so restore by hand).
  local had_noglob=0
  case $- in *f*) had_noglob=1 ;; esac
  set -f
  while IFS= read -r seg; do
    first=""
    for tok in $seg; do
      case "$tok" in
        *=*|sudo|command|env|nice|-n|[0-9]*|do|then|else|time|exec|'{'|'(') continue ;;
      esac
      first="$tok"; break
    done
    [[ -z $first || $first =~ $allow_re ]] && continue
    if [[ $seg =~ $re_home ]]; then
      echo "BLOCKED (sous): reading ~/.${BASH_REMATCH[2]} credentials. Ask the user."
      [ $had_noglob = 1 ] || set +f
      return 1
    fi
    rest="$seg"
    while [[ $rest =~ $re_env ]]; do
      tok="${BASH_REMATCH[2]}"
      rest="${rest#*"$tok"}"
      case "$tok" in
        *.example|*.sample|*.template|*.dist) continue ;;
      esac
      echo "BLOCKED (sous): $first touches $tok, a secrets file. Read .env.example for the key names."
      [ $had_noglob = 1 ] || set +f
      return 1
    done
  done <<< "$segs"
  [ $had_noglob = 1 ] || set +f

  # 7. Building a command out of sight: decode or fetch, then run it.
  local re_shell_pipe='\|[[:space:]]*(sudo[[:space:]]+)?(/bin/|/usr/bin/)?(ba|z|da|k)?sh([[:space:]]|$)'
  local re_procsub='((ba|z|da|k)?sh|source|\.)[[:space:]]+<\('
  local re_eval_src='eval[[:space:]].*(base64|xxd|openssl|curl|wget|printf[[:space:]]+.*x[0-9a-fA-F])'
  if [[ $norm =~ $re_shell_pipe || $norm =~ $re_procsub || $norm =~ $re_eval_src ]]; then
    echo "BLOCKED (sous): piping generated or downloaded text into a shell. Save it to a file, show it, then run it."
    return 1
  fi
  return 0
}

# Sets _sous_scan to $1 minus the heredoc bodies that are data. Returns 1 when
# the quoting is too unclear to hide anything; the caller then scans it all.
# Quote state ($ctx, a stack: n code, s '', e $'', d "", p $( or (, b ``,
# a arithmetic) carries across lines, so a `<<X` inside a multi-line string
# is text, as it is to bash.
_sous_split_heredocs() {
  local LC_ALL=C
  local line trim head d keep ctx="n" queue="" us=$'\037' budget=65536 hd
  local re_interp='(^|[;&|(`[:space:]/"'\''\\])(bash|sh|zsh|dash|ksh|fish|eval|ssh|python[0-9.]*|perl|ruby|node|php|osascript|source|\$\{?SHELL\}?|\$\{?BASH\}?)([[:space:]"'\''`)]|$|<)|(^|[;&|[:space:]])\.[[:space:]]'
  _sous_scan=""
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ -n $queue ]]; then
      head="${queue%%"$us"*}"
      d="${head:2}"
      trim="${line#"${line%%[![:space:]]*}"}"
      if [[ $trim == "$d" ]]; then queue="${queue#*"$us"}"; continue; fi
      if [[ ${head:0:1} == 1 ]] || { [[ ${head:1:1} == U ]] && [[ $line == *'$('* || $line == *'`'* ]]; }; then
        _sous_scan+="$line"$'\n'
      fi
      continue
    fi
    _sous_scan+="$line"$'\n'
    # A line with none of these characters can't change the quote state or open a heredoc.
    case $line in *[\'\"\`\(\)\<\#\\\$]*) ;; *) continue ;; esac
    budget=$((budget - ${#line}))
    (( budget > 0 )) || return 1
    _sous_heredoc_line "$line" || return 1
    [[ -z $_sous_hd ]] && continue
    keep=0
    [[ $line =~ $re_interp ]] && keep=1
    while [[ -n $_sous_hd ]]; do
      hd="${_sous_hd%%"$us"*}"
      _sous_hd="${_sous_hd#*"$us"}"
      queue+="$keep$hd$us"
    done
  done <<< "$1"
  return 0
}

# Walks one line in quote state $ctx (the caller's), appending each heredoc it
# opens to _sous_hd as <Q|U><delimiter>\037 (Q: quoted, body can't expand).
# Returns 1 on a heredoc operator without a readable delimiter.
_sous_heredoc_line() {
  local s="$1" i=0 n=${#1} c top w q rest tmp us=$'\037'
  local re_code='^[^'\''"`\\$()<#]+' re_dq='^[^"`\\$]+' re_sq="^[^'\\\\]+" re_ar='^[^()]+'
  _sous_hd=""
  while (( i < n )); do
    top="${ctx:${#ctx}-1}"
    c="${s:i:1}"
    case $top in
      s)
        rest="${s:i}"
        [[ $rest == *"'"* ]] || return 0
        tmp="${rest%%"'"*}"
        i=$((i + ${#tmp} + 1)); ctx="${ctx%?}"; continue ;;
      e)
        case $c in
          \\) i=$((i + 2)) ;;
          \') i=$((i + 1)); ctx="${ctx%?}" ;;
          *) rest="${s:i}"; if [[ $rest =~ $re_sq ]]; then i=$((i + ${#BASH_REMATCH[0]})); else i=$((i + 1)); fi ;;
        esac
        continue ;;
      a)
        case $c in
          \() ctx+="a"; i=$((i + 1)) ;;
          \)) ctx="${ctx%?}"; i=$((i + 1)) ;;
          *) rest="${s:i}"; if [[ $rest =~ $re_ar ]]; then i=$((i + ${#BASH_REMATCH[0]})); else i=$((i + 1)); fi ;;
        esac
        continue ;;
      d)
        case $c in
          \\) i=$((i + 2)) ;;
          \") ctx="${ctx%?}"; i=$((i + 1)) ;;
          \`) ctx+="b"; i=$((i + 1)) ;;
          \$)
            if [[ ${s:i:3} == '$((' ]]; then ctx+="aa"; i=$((i + 3))
            elif [[ ${s:i:2} == '$(' ]]; then ctx+="p"; i=$((i + 2))
            else i=$((i + 1)); fi ;;
          *) rest="${s:i}"; if [[ $rest =~ $re_dq ]]; then i=$((i + ${#BASH_REMATCH[0]})); else i=$((i + 1)); fi ;;
        esac
        continue ;;
    esac
    # Code: n, p, b.
    case $c in
      \\) i=$((i + 2)) ;;
      \') ctx+="s"; i=$((i + 1)) ;;
      \") ctx+="d"; i=$((i + 1)) ;;
      \`) if [[ $top == b ]]; then ctx="${ctx%?}"; else ctx+="b"; fi; i=$((i + 1)) ;;
      \$)
        if [[ ${s:i:3} == '$((' ]]; then ctx+="aa"; i=$((i + 3))
        elif [[ ${s:i:2} == '$(' ]]; then ctx+="p"; i=$((i + 2))
        elif [[ ${s:i:2} == "\$'" ]]; then ctx+="e"; i=$((i + 2))
        else i=$((i + 1)); fi ;;
      \() if [[ ${s:i:2} == '((' ]]; then ctx+="aa"; i=$((i + 2)); else ctx+="p"; i=$((i + 1)); fi ;;
      \)) [[ $top == p ]] && ctx="${ctx%?}"; i=$((i + 1)) ;;
      \#)
        if (( i == 0 )); then return 0; fi
        case ${s:i-1:1} in [[:space:]]|';'|'&'|'|'|'('|')') return 0 ;; esac
        i=$((i + 1)) ;;
      \<)
        if [[ ${s:i:3} == '<<<' ]]; then i=$((i + 3)); continue; fi
        if [[ ${s:i:2} != '<<' ]]; then i=$((i + 1)); continue; fi
        i=$((i + 2))
        [[ ${s:i:1} == - ]] && i=$((i + 1))
        while [[ ${s:i:1} == [[:blank:]] ]]; do i=$((i + 1)); done
        w="" q=U
        while (( i < n )); do
          c="${s:i:1}"
          case $c in
            [[:blank:]]|';'|'&'|'|'|'<'|'>'|'('|')') break ;;
            \\) w+="${s:i+1:1}"; q=Q; i=$((i + 2)) ;;
            \'|\")
              rest="${s:i+1}"
              [[ $rest == *"$c"* ]] || return 1
              tmp="${rest%%"$c"*}"
              w+="$tmp"; q=Q; i=$((i + ${#tmp} + 2)) ;;
            *) w+="$c"; i=$((i + 1)) ;;
          esac
        done
        [[ -n $w ]] || return 1
        _sous_hd+="$q$w$us" ;;
      *) rest="${s:i}"; if [[ $rest =~ $re_code ]]; then i=$((i + ${#BASH_REMATCH[0]})); else i=$((i + 1)); fi ;;
    esac
  done
  return 0
}

# Executed as a hook (not sourced): parse stdin, fail closed on garbage.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -uo pipefail
  input=$(cat)
  # Regex, not ${input//[[:space:]]/}: that substitution is quadratic in bash 3.2.
  [[ $input =~ [^[:space:]] ]] || exit 0
  if command -v jq >/dev/null 2>&1; then
    cmd=$(printf '%s' "$input" | jq -er '.tool_input.command // .command // ""' 2>/dev/null) ||
      { printf '%s' "$input" | jq -e . >/dev/null 2>&1 || { echo "BLOCKED (sous): hook input is not valid JSON." >&2; exit 2; }; }
  elif command -v python3 >/dev/null 2>&1; then
    cmd=$(printf '%s' "$input" | python3 -c 'import json,sys
d=json.load(sys.stdin); print((d.get("tool_input") or {}).get("command") or d.get("command") or "")' 2>/dev/null) ||
      { echo "BLOCKED (sous): hook input is not valid JSON." >&2; exit 2; }
  else
    echo "BLOCKED (sous): neither jq nor python3 found; can't read the command. Install jq." >&2
    exit 2
  fi
  [[ -z ${cmd:-} ]] && exit 0
  reason=$(sous_guard "$cmd") || { echo "$reason" >&2; exit 2; }
  exit 0
fi
