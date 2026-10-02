#!/usr/bin/env bash
# sous-guard: Claude Code PreToolUse hook for the Bash tool.
#
# Hard-stops agent slips that settings.json Bash deny rules miss, because deny
# rules match the command text Claude usually writes, not the program:
#   delete   rm with recursive+force (any spelling or path, $'\x..', ${IFS},
#            line continuations), rimraf, git clean -f, find -delete,
#            rsync --delete, rmtree/rm_rf/rmSync-recursive under an interpreter
#   push     --force*, -f, +ref, --mirror, --delete, -d, --prune, :ref, and
#            the same behind -c alias/remote.*.mirror, for every push in the line
#   secrets  any command naming .env* (bar .example/.sample/.template/.dist, any
#            case) or a dot-glob reaching it, ~/.ssh, ~/.aws, ~/.gnupg (any
#            user's home) -- except ls / test / stat, and git short of
#            show/cat-file/diff/grep/log -p/-c that print contents
#   build    decode or fetch piped into a shell (through sudo/env/VAR=) or an
#            interpreter reading stdin, sh -c "$(curl ...)", bash <(curl ...),
#            <<< "$(curl ...)", eval of a decoded or fetched string
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

# `sous doctor` compares this stamp between the plugin's guard and a project's
# copy to report drift; `sous-guard.sh --version` prints it.
SOUS_GUARD_VERSION=0.3.0

# Prints the block reason and returns 1 when $1 must not run; returns 0 otherwise.
# Every block appends "epoch<TAB>reason<TAB>project dir" to $SOUS_LOG (default
# ~/.claude/sous/blocks.tsv; SOUS_LOG=off disables). Reason only, never the
# command: command text can carry secrets. `sous report` reads it back so the
# rules get tuned from what fired, not from memory; the directory
# ($CLAUDE_PROJECT_DIR, else the hook's cwd) lets `sous gate` and `sous fleet`
# tell worktrees apart.
sous_guard() {
  local reason
  reason=$(_sous_match "$1") && return 0
  printf '%s\n' "$reason"
  local log="${SOUS_LOG:-$HOME/.claude/sous/blocks.tsv}" where="${CLAUDE_PROJECT_DIR:-$PWD}"
  if [[ $log != off ]]; then
    where=${where//$'\t'/ }; where=${where//$'\n'/ }
    { mkdir -p "$(dirname "$log")" && printf '%s\t%s\t%s\n' "$(date +%s)" "$reason" "$where" >>"$log"; } 2>/dev/null
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

  # 2c. Spellings bash undoes before running. Done after the message and jq
  #     steps, so decoded text can't open or close a span those steps hide.
  #     $'\x72\x6d' is "rm" (decoded in place), and backslash-newline joins
  #     lines (the joined text is appended, so a stray join hides nothing).
  local re_ansi='\$'"'"'(([^'"'"'\\]|\\.)*)'"'"'' dec n=0
  while (( n < 32 )) && [[ $scan =~ $re_ansi ]]; do
    m="${BASH_REMATCH[0]}"
    printf -v dec '%b' "${BASH_REMATCH[1]}"
    scan="${scan/"$m"/$dec}"
    n=$((n + 1))
  done
  if [[ $scan == *\\"$lf"* ]]; then
    scan+="$lf$(printf '%s\n' "$scan" | awk '{ if (sub(/\\$/, "")) printf "%s", $0; else print }')"
  fi

  # 3. Normalize: quotes and backslashes don't change which program runs, and
  #    ${IFS} is a space. Past a few KB, ${var//x/} is quadratic in bash 3.2
  #    (tens of seconds on a 16KB command, past the hook timeout), so long text
  #    goes through tr.
  if (( ${#scan} > 2048 )); then
    norm=$(printf '%s' "$scan" | tr -d "\"'\\\\")
  else
    norm="${scan//\"/}"
    norm="${norm//\'/}"
    norm="${norm//\\/}"
  fi
  local re_ifs='\$\{IFS[^}]*\}|\$IFS'
  n=0
  while (( n < 32 )) && [[ $norm =~ $re_ifs ]]; do
    norm="${norm/"${BASH_REMATCH[0]}"/ }"
    n=$((n + 1))
  done

  # 4. Recursive force delete. Collect each rm's flag run, then test the flags.
  #    Any path to rm (or GNU grm), and commas count as separators so brace
  #    expansion ({rm,-rf,x}) and argv lists ([rm, -rf, x]) are read as flags.
  local re_rm='(^|[^[:alnum:]_./-])([^[:space:];&|(){}<>]*/)?g?rm(([[:space:],]+-[-[:alnum:]]*)+)'
  rest="$norm"
  while [[ $rest =~ $re_rm ]]; do
    flags=" ${BASH_REMATCH[3]//,/ } "
    rest="${rest#*"${BASH_REMATCH[0]}"}"
    if [[ $flags =~ [[:space:]](-[[:alpha:]]*[rR]|--recursive)[[:space:]] ]] &&
       [[ $flags =~ [[:space:]](-[[:alpha:]]*f[[:alpha:]]*|--force)[[:space:]] ]] ||
       [[ $flags =~ [[:space:]]-[[:alpha:]]*[rR][[:alpha:]]*[[:space:]] && $flags =~ [[:space:]]-[[:alpha:]]*f ]]; then
      echo "BLOCKED (sous): recursive force delete. Name the files, list them first, or ask the user."
      return 1
    fi
  done
  # rimraf is rm -rf as a package: run directly or through npx/pnpm dlx/yarn dlx/bunx.
  local re_rimraf="(^|[;&|(${bt}${lf}])[[:space:]]*((sudo|env|command|exec)[[:space:]]+)*((npx|bunx|pnpx)([[:space:]]+-[^[:space:]]*)*[[:space:]]+|(pnpm|yarn|bun)[[:space:]]+(dlx|x)[[:space:]]+|npm[[:space:]]+exec([[:space:]]+--)?[[:space:]]+)?([^[:space:]]*/)?rimraf(@[^[:space:]]*)?([[:space:]]|\$)"
  if [[ $norm =~ $re_rimraf ]]; then
    echo "BLOCKED (sous): rimraf is a recursive force delete. Name the files, list them first, or ask the user."
    return 1
  fi
  local re_clean='git[[:space:]]+([^|;&]*[[:space:]])?clean(([[:space:]]+-[-[:alnum:]]*)+)'
  rest="$norm"
  while [[ $rest =~ $re_clean ]]; do
    flags=" ${BASH_REMATCH[2]} "
    rest="${rest#*"${BASH_REMATCH[0]}"}"
    if [[ $flags =~ [[:space:]](-[[:alpha:]]*f|--force) && ! $flags =~ [[:space:]](-[[:alpha:]]*n|--dry-run) ]]; then
      echo "BLOCKED (sous): git clean deletes untracked work. Run git clean -n and show the user the list."
      return 1
    fi
  done
  if [[ $norm =~ (^|[^[:alnum:]_])find[[:space:]][^|\;\&]*-delete ]]; then
    echo "BLOCKED (sous): find -delete. Run the same find with -print, then delete named paths."
    return 1
  fi
  if [[ $norm =~ (^|[^[:alnum:]_])rsync[[:space:]][^|\;\&]*--delete ]]; then
    echo "BLOCKED (sous): rsync --delete removes files at the destination. Ask the user."
    return 1
  fi

  # 5. Destructive push: force, mirror, prune, remote-branch delete. Every push
  #    in the command, including one behind an alias or -c remote.*.mirror.
  local re_push='git[[:space:]]+([^|;&]*[[:space:]=])?push(([[:space:]]+[^|;&[:space:]]+)*)'
  local pre
  rest="$norm"
  while [[ $rest =~ $re_push ]]; do
    pre=" ${BASH_REMATCH[1]} "
    args=" ${BASH_REMATCH[2]} "
    rest="${rest#*"${BASH_REMATCH[0]}"}"
    if [[ $args =~ [[:space:]](--force|--mirror|--delete|--prune) ]] ||
       [[ $args =~ [[:space:]]-[[:alpha:]]*[fd][[:alpha:]]*[[:space:]] ]] ||
       [[ $args =~ [[:space:]][+:][^[:space:]] ]] ||
       [[ $pre =~ mirror=([tT]|1|[yY]|[oO][nN])|\.push=[+:] ]]; then
      echo "BLOCKED (sous): force, mirror or delete push. Ask the user; they run it themselves with ! if they want it."
      return 1
    fi
  done

  # 6. Secrets: per command segment, any mention of a secrets path, unless the
  #    segment's program only lists or stats it. Case-insensitive (macOS and
  #    Windows filesystems are), and globs are tested against the real names.
  local segs="$norm" allow_re='^(ls|git|test|\[|stat)$'
  local re_env='(^|[^[:alnum:]_])(\.[eE][nN][vV?*][[:alnum:]_.*?-]*)'
  local re_home='(~[[:alnum:]_.-]*|\$HOME|\$\{HOME\}|/Users/[^/[:space:]]+|/home/[^/[:space:]]+|/root|/var/root)/(\.[^/[:space:]]+)'
  local re_interp_cmd='(^|[;&|(`[:space:]/])(python[0-9.]*|perl|ruby|node|deno|bun|php)([[:space:]]|$)'
  local re_api='(^|[^[:alnum:]_])(rmtree|remove_tree|rm_rf|rm_r|remove_dir|remove_entry_secure|RemoveAll)([[:space:]]*\(|[[:space:]]+[^[:space:]=])|\.(rmSync|rmdirSync|rm|rmdir)\([^)]*recursive'
  local has_interp=0 low comp cand gsub skip
  [[ $norm =~ $re_interp_cmd ]] && has_interp=1
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
  # Each block below sets $reason and breaks out, so -f is restored in one place.
  local had_noglob=0 reason=""
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
    [[ -z $first ]] && continue
    # git is allowlisted for status/add/rm/log, not for the subcommands that
    # print a file's contents (show HEAD:.env) or run a configured program (-c).
    if [[ $first == git ]]; then
      gsub="" skip=0 n=0
      for tok in $seg; do
        if (( n == 0 )); then [[ $tok == git ]] && n=1; continue; fi
        if (( skip )); then skip=0; continue; fi
        case $tok in
          -C|--git-dir|--work-tree|--namespace) skip=1 ;;
          -c|-c*|--config-env*|--exec-path*) gsub=-c; break ;;
          -*) ;;
          *) gsub=$tok; break ;;
        esac
      done
      case $gsub in
        -c|show|cat-file|blame|annotate|grep|diff|difftool|archive|format-patch|whatchanged) first="git $gsub" ;;
        log) [[ $seg =~ [[:space:]](-p|--patch|-L[^[:space:]]*|-u)([[:space:]]|$) ]] && first="git log -p" ;;
      esac
    fi
    if (( has_interp )) && [[ $seg =~ $re_api ]]; then
      case $first in
        grep|egrep|fgrep|rg|ag|ack|git|echo|printf|sed|awk|cat|less|head|tail|wc|ls|find) ;;
        *) reason="recursive delete through an interpreter (rmtree, rm_rf, rmSync recursive). Name the files, or ask the user."
           break ;;
      esac
    fi
    [[ $first =~ $allow_re ]] && continue
    rest="$seg"
    while [[ $rest =~ $re_home ]]; do
      rest="${rest#*"${BASH_REMATCH[0]}"}"
      low=$(printf '%s' "${BASH_REMATCH[2]}" | tr '[:upper:]' '[:lower:]')
      for cand in .ssh .aws .gnupg; do
        # shellcheck disable=SC2053  # $low is a pattern on purpose: ~/.s* reaches .ssh
        if [[ $cand == $low ]]; then
          reason="reading ~/$cand credentials. Ask the user."
          break 3
        fi
      done
    done
    rest="$seg"
    while [[ $rest =~ $re_env ]]; do
      tok="${BASH_REMATCH[2]}"
      rest="${rest#*"$tok"}"
      low=$(printf '%s' "$tok" | tr '[:upper:]' '[:lower:]')
      case "$low" in
        *.example|*.sample|*.template|*.dist) continue ;;
      esac
      reason="$first touches $tok, a secrets file. Read .env.example for the key names."
      break 2
    done
    # A glob that starts with a dot reaches dotfiles: .e*, .[e]nv, .?nv, .*
    for tok in $seg; do
      case $tok in *[\*\?\[]*) ;; *) continue ;; esac
      comp="${tok##*/}"
      comp="${comp#[<>]}"
      case $comp in .*|'[.]'*) ;; *) continue ;; esac
      low=$(printf '%s' "$comp" | tr '[:upper:]' '[:lower:]')
      for cand in .env .env.local .envrc .env.production .env.development; do
        # shellcheck disable=SC2053  # $low is the user's glob, matched on purpose
        if [[ $cand == $low ]]; then
          reason="$first $tok reaches $cand, a secrets file. Read .env.example for the key names."
          break 3
        fi
      done
    done
  done <<< "$segs"
  [ $had_noglob = 1 ] || set +f
  if [[ -n $reason ]]; then
    echo "BLOCKED (sous): $reason"
    return 1
  fi

  # 7. Building a command out of sight: decode or fetch, then run it.
  #    A pipe (not ||) into a shell, through sudo/env/VAR=, or a fetch piped into
  #    an interpreter reading stdin; a shell fed $(fetch), <(fetch) or <<<.
  local wrap='(([^[:space:]]*/)?(sudo|env|command|exec|nohup|time|doas)([[:space:]]+-[^[:space:]]*)*[[:space:]]+|[[:alpha:]_][[:alnum:]_]*=[^[:space:]]*[[:space:]]+)*'
  local shells='([^[:space:]]*/)?(ba|z|da|k|fi|c|tc)?sh'
  local interp='([^[:space:]]*/)?(python[0-9.]*|perl|ruby|node|deno|bun|php)'
  local fetch='(curl|wget|base64|xxd|openssl|fetch|nc|ncat|gunzip|zcat|aria2c|http|xh)'
  local re_shell_pipe="(^|[^|])\\|&?[[:space:]]*${wrap}${shells}([[:space:]]|\$)"
  local re_interp_pipe="(^|[^[:alnum:]_])${fetch}[[:space:]][^;&${lf}]*[^|]\\|&?[[:space:]]*${wrap}${interp}(([[:space:]]+(-|-[[:alpha:]]{1,3}|--))*)[[:space:]]*(\$|[;&|)${lf}])"
  local re_shell_subst="(^|[^[:alnum:]_])((ba|z|da|k|fi)?sh|eval|source)[[:space:]]+([^;&|${lf}]*[[:space:]])?(\\\$\\(|${bt})[[:space:]]*${wrap}${fetch}([[:space:]]|\$)"
  local re_procsub="(^|[^[:alnum:]_.])((ba|z|da|k|fi)?sh|source|\\.|${interp})([[:space:]]+-[^[:space:]]*)*[[:space:]]+(<[[:space:]]*)?<\\("
  local re_herestr="(^|[^[:alnum:]_.])((ba|z|da|k|fi)?sh|${interp})([[:space:]]+-[^[:space:]]*)*[[:space:]]*<<<[^;&|${lf}]*${fetch}"
  local re_eval_src='eval[[:space:]].*(base64|xxd|openssl|curl|wget|printf[[:space:]]+.*x[0-9a-fA-F])'
  if [[ $norm =~ $re_shell_pipe || $norm =~ $re_interp_pipe || $norm =~ $re_shell_subst ||
        $norm =~ $re_procsub || $norm =~ $re_herestr || $norm =~ $re_eval_src ]]; then
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
  if [[ ${1:-} == --version ]]; then echo "sous-guard $SOUS_GUARD_VERSION"; exit 0; fi
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
