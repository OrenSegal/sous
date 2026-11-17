#!/bin/bash
# Temporary: why does the guard die silently on the ruby File.write row on macOS 26?
ulimit -s; locale | head -3
t='ruby -e File.write(.claude/settings.json, {})'
re=$(sed -n 's/^    local re_first="\(.*\)"$/\1/p' hooks/sous-guard.sh)
p='(\.claude/(settings(\.local)?\.json|hooks(/[^[:space:];&|<>(),]*)?)|\.mcp\.json)'
end='([^[:alnum:]_.-]|$)'
arg="([^[:space:],;]*[/(])?${p}"
w='(^|[^[:alnum:]_])'
eval "re=\"$re\""
echo "re length ${#re}"
try() { bash -c "$1" _ "$t" "$re"; echo "$2 exit=$?"; }
try '[[ $1 =~ $2 ]]; echo rc=$?' default-locale
try 'LC_ALL=C; [[ $1 =~ $2 ]]; echo rc=$?' LC_ALL=C-global
try 'f() { local LC_ALL=C; [[ $1 =~ $2 ]]; echo rc=$?; }; f "$1" "$2"' LC_ALL=C-local
try 'f() { local LC_ALL=C; [[ $1 =~ $2 ]]; echo rc=$?; }; x=$(f "$1" "$2"); echo "sub=$? out=$x"' LC_ALL=C-local-cmdsub
payload='{"tool_input":{"command":"ruby -e \"File.write('"'"'.claude/settings.json'"'"', '"'"'{}'"'"')\""}}'
printf '%s' "$payload" | bash hooks/sous-guard.sh; echo "hook exit=$?"
src='source hooks/sous-guard.sh; _sous_tamper "$1" 1; echo tamper_rc=$?'
bash -c "$src" _ "$t"; echo "direct exit=$?"
