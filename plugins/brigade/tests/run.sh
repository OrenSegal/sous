#!/usr/bin/env bash
# Static checks for brigade: routing.md and agents/ agree, vendored skills are pinned, scripts parse.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $1"; }

for f in agents/*.md; do
  name=$(sed -n 's/^name: *//p' "$f" | head -1)
  model=$(sed -n 's/^model: *//p' "$f" | head -1)
  case "$model" in haiku|sonnet|opus) ok ;; *) bad "$f: model '$model' is not haiku, sonnet or opus (fable is a leader tier)" ;; esac
  row=$(grep -E "^\| \`$name\` \|" routing.md || true)
  [ -n "$row" ] || { bad "$f: no row for \`$name\` in the routing.md roles table"; continue; }
  tier=$(printf '%s' "$row" | awk -F'|' '{gsub(/ /,"",$3); print $3}')
  want=$(grep -E "^\| $tier \|" routing.md | awk -F'|' '{gsub(/ /,"",$3); print $3}')
  if [ "$want" = "$model" ]; then ok; else bad "$f: model $model, but routing.md puts \`$name\` on $tier ($want)"; fi
done

# shellcheck disable=SC2016
for name in $(grep -oE '^\| `[a-z-]+` \|' routing.md | tr -d '|` '); do
  if [ -f "agents/$name.md" ]; then ok; else bad "routing.md names \`$name\` but agents/$name.md is missing"; fi
done

for s in retro compound writing-skills; do
  if grep -q "skills/$s" NOTICE; then ok; else bad "NOTICE does not credit skills/$s"; fi
done
for sha in fcb5e3adc1890db34f482f73e2449f3c57a2f423 22f0b463e7a5e579904dd6211a520321035526f7; do
  if grep -q "$sha" NOTICE; then ok; else bad "NOTICE does not pin $sha"; fi
done

if grep -rnE '\bce-(setup|plan|noslop|retro|compound)\b|superpowers:writing-skills|\.compound-engineering' skills >/dev/null; then
  bad "a vendored skill still names an upstream-only skill or path"
else
  ok
fi

for d in skills/*/; do
  if [ -f "$d/SKILL.md" ]; then ok; else bad "$d has no SKILL.md"; fi
done

while IFS= read -r profile; do
  if [ -f "stacks/$profile.md" ]; then ok; else bad "templates/config.yaml names profile $profile but stacks/$profile.md is missing"; fi
done < <(sed -n 's/^ *profile: *//p' templates/config.yaml | sort -u)

if find skills -name '*.py' -print0 | xargs -0 python3 -m py_compile 2>/dev/null; then ok; else bad "a vendored Python script does not compile"; fi
find skills -name '__pycache__' -type d -prune -exec rm -r {} + 2>/dev/null

echo "brigade: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
