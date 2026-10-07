#!/usr/bin/env bash
# Validates, type-checks and tests every mod in plugins/.
set -euo pipefail
cd "$(dirname "$0")/.."

claude plugin validate . >/dev/null
for mod in plugins/*/; do
  echo "== $mod"
  claude plugin validate "$mod" >/dev/null
  if [ ! -d "$mod.claude-plugin/types" ]; then
    # Loading the mod lays its API types; /help answers locally, so no model call is made.
    env -u CLAUDECODE claude -p --plugin-dir "$mod" --setting-sources "" --no-session-persistence /help </dev/null >/dev/null
  fi
  tsc -p "$mod"
  claude plugin test "$mod"
done
