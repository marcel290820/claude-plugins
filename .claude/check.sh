#!/usr/bin/env bash
# Validates every plugin in plugins/; type-checks and tests the mods, runs tests/run.sh for shell plugins.
set -euo pipefail
cd "$(dirname "$0")/.."

claude plugin validate . >/dev/null
for mod in plugins/*/; do
  echo "== $mod"
  claude plugin validate "$mod" >/dev/null
  if [ -x "${mod}tests/run.sh" ]; then
    "${mod}tests/run.sh"
    continue
  fi
  if [ ! -d "$mod.claude-plugin/types" ]; then
    # Loading the mod lays its API types; /help answers locally, so no model call is made.
    env -u CLAUDECODE claude -p --plugin-dir "$mod" --setting-sources "" --no-session-persistence /help </dev/null >/dev/null
  fi
  tsc -p "$mod"
  claude plugin test "$mod"
done
