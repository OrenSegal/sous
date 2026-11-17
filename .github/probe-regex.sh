#!/bin/bash
# Temporary: which part of the tamper re_first pattern crashes this host's regcomp/regexec?
t='ruby -e File.write(.claude/settings.json, {})'
p='(\.claude/(settings(\.local)?\.json|hooks(/[^[:space:];&|<>(),]*)?)|\.mcp\.json)'
end='([^[:alnum:]_.-]|$)'
arg="([^[:space:],;]*[/(])?${p}"
w='(^|[^[:alnum:]_])'
names='(write|write_text|write_bytes|writeFile|writeFileSync|appendFile|appendFileSync|writeTextFile|writeTextFileSync|createWriteStream|outputFile|outputFileSync|writeJson|writeJsonSync|file_put_contents|truncate|truncateSync|remove|removeSync|unlink|unlinkSync|rm|rmSync|rm_f|delete|chmod|chmodSync|rename|renameSync|move|mv)'
probe() { ( [[ $t =~ $2 ]]; echo "rc=$?" ) 2>&1 | tail -1 | sed "s/^/$1: /"; echo "$1 subshell exit=${PIPESTATUS[0]}"; }
probe full "${w}${names}\\([[:space:]]*${arg}${end}"
probe names-paren "${w}${names}\\("
probe write-only "${w}(write)\\([[:space:]]*${arg}${end}"
probe paren-arg-end "\\([[:space:]]*${arg}${end}"
probe arg-end "${arg}${end}"
probe arg "${arg}"
probe p "${p}"
probe p-no-hooks '(\.claude/(settings(\.local)?\.json)|\.mcp\.json)'
probe bracket-paren '[/(]'
probe hooks-class '(/[^[:space:];&|<>(),]*)?'
