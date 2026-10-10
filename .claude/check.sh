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
    # An interactive session lays a mod's API types when it loads it (-p does not); every mod here has the same,
    # so one opened before lends them.
    laid=(plugins/*/.claude-plugin/types/claude-code)
    [ -d "${laid[0]}" ] || { echo "No API types yet: open one mod once with \`claude --plugin-dir $mod\`, then rerun." >&2; exit 1; }
    cp -R "$(dirname "${laid[0]}")" "$mod.claude-plugin/types"
  fi
  tsc -p "$mod"
  claude plugin test "$mod"
done
