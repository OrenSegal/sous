#!/bin/bash
# Temporary: why does the guard die silently on the ruby File.write row on macOS 26?
cmd="ruby -e \"File.write('.claude/settings.json', '{}')\""
bash -c 'source hooks/sous-guard.sh; _sous_match "$1"; echo "match_rc=$?"' _ "$cmd"; echo "outer exit=$?"
bash -c 'source hooks/sous-guard.sh; x=$(_sous_match "$1"); echo "cmdsub_rc=$? out=$x"' _ "$cmd"; echo "outer exit=$?"
PS4='+${LINENO}: ' bash -xc 'source hooks/sous-guard.sh; _sous_match "$1"; echo "match_rc=$?"' _ "$cmd" 2>&1 | tail -12 | cat -v | cut -c1-300
