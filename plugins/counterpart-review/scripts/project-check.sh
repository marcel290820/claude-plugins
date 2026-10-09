#!/bin/bash
# Runs the project's check command in the current repository root. Used by the commit gate.
# Check command, first found: .claude/check.sh > .codex/check.sh > make check > package.json "check".
# None found, clean tree, or unchanged since the last green run -> exit 0 without running it.
# Failure -> exit 1 with the tail of the output.
# The fingerprint and its state file match ~/.claude/hooks/stop-check.sh, so a tree the Stop check
# already passed is not checked again at commit time.
set -u
[ -z "$(git status --porcelain)" ] && exit 0
if [ -x .claude/check.sh ]; then CHECK=".claude/check.sh"
elif [ -x .codex/check.sh ]; then CHECK=".codex/check.sh"
elif [ -f Makefile ] && grep -qE '^check:' Makefile; then CHECK="make check"
elif [ -f package.json ] && jq -e '.scripts.check' package.json >/dev/null 2>&1; then
  if [ -f pnpm-lock.yaml ]; then CHECK="pnpm run check"
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then CHECK="bun run check"
  else CHECK="npm run check"; fi
else exit 0; fi
# Fingerprint of HEAD, the working tree diff, the staged diff and untracked file contents. Same as the
# last green run -> skip.
# Before the first commit there is no HEAD, so diff against the empty tree.
BASE=$(git rev-parse -q --verify HEAD) || BASE=$(git hash-object -t tree /dev/null)
FP=$( { echo "$BASE"; git diff "$BASE"; git diff --cached "$BASE"; git ls-files --others --exclude-standard -z | xargs -0 shasum 2>/dev/null; } | shasum | cut -c1-40)
STATE="$(git rev-parse --git-dir)/claude-check-ok"
[ -f "$STATE" ] && [ "$(cat "$STATE")" = "$FP" ] && exit 0
OUT=$($CHECK 2>&1 </dev/null); RC=$?
if [ $RC -eq 0 ]; then printf '%s' "$FP" > "$STATE"; exit 0; fi
rm -f "$STATE"
printf 'Project check failed in %s (%s, exit %d). Fix before committing:\n%s\n' "$PWD" "$CHECK" "$RC" "$(printf '%s' "$OUT" | tail -n 60)"
exit 1
