#!/bin/bash
# Runs the counterpart reviewer headless and read-only on the prompt from stdin.
# Usage: review.sh codex|claude
#   codex  -> GPT 6.1 Sol / xhigh through Codex's read-only sandbox (the reviewer for Claude Code)
#   claude -> Claude Opus 5.5 / xhigh with Read, Grep and Glob only (the reviewer for Codex)
# Reads files from the current directory for context. Prints the verdict text and exits:
#   0 pass, 1 findings, 2 could not run, 3 could not run (usage limit), 4 ran but gave no verdict.
# The commit gate maps these to allow/deny/ask; the review skill relays them as they are.
export PATH="$PATH:$HOME/.local/bin"
set -u
REVIEWER=${1:-}
TIMEOUT=${REVIEW_TIMEOUT:-780}
case "$REVIEWER" in codex|claude) ;; *) echo "Usage: review.sh codex|claude < prompt" >&2; exit 2;; esac
command -v "$REVIEWER" >/dev/null 2>&1 || { echo "The $REVIEWER CLI is not on PATH, so the counterpart review cannot run. Install and log in to it, or disable the counterpart-review plugin."; exit 2; }
PROMPT=$(cat)
WORK=$(mktemp -d) || { echo "Reviewer could not allocate a temp directory."; exit 2; }
trap 'rm -rf "$WORK"' EXIT
SCHEMA='{"type":"object","properties":{"ok":{"type":"boolean"},"reason":{"type":"string"}},"required":["ok","reason"],"additionalProperties":false}'

rate_limited() { printf '%s' "$1" | grep -Eqi '(session|usage|weekly|rate) limit'; }

# perl alarm survives exec: hard cap on the reviewer (default 780 s, inside the 900 s hook timeout).
if [ "$REVIEWER" = codex ]; then
  printf '%s' "$SCHEMA" > "$WORK/schema.json"
  printf '%s' "$PROMPT" | perl -e 'alarm shift; exec @ARGV' "$TIMEOUT" \
    codex exec - --model gpt-6.1-sol -c 'model_reasoning_effort="xhigh"' \
    --ignore-user-config -c features.hooks=false --ignore-rules \
    --sandbox read-only -c 'approval_policy="never"' \
    --skip-git-repo-check --ephemeral --json \
    --output-schema "$WORK/schema.json" -o "$WORK/verdict.json" \
    >"$WORK/events.jsonl" 2>"$WORK/log"
  RC=$?
  # Only a terminal native error classifies a failure; retry notices and model text do not.
  ERRORS=$(jq -sr 'last | select(.type == "error" or .type == "turn.failed") | (.message // .error.message // empty)' "$WORK/events.jsonl" 2>/dev/null)
  DETAILS=${ERRORS:-$(tail -n 5 "$WORK/log")}
  LIMITED=$([ $RC -eq 1 ] && rate_limited "$ERRORS" && echo 1)
else
  # Safe mode disables custom hooks/plugins while preserving subscription authentication.
  # Restricted file tools and dontAsk keep the reviewer from changing the project.
  printf '%s' "$PROMPT" | perl -e 'alarm shift; exec @ARGV' "$TIMEOUT" \
    env -u CLAUDECODE -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_EFFORT_LEVEL \
    claude -p --safe-mode --restricted \
      --model claude-opus-5-5 --effort xhigh \
      --tools Read,Grep,Glob --permission-mode dontAsk \
      --no-session-persistence --max-turns 25 \
      --output-format json --json-schema "$SCHEMA" \
      >"$WORK/out.json" 2>"$WORK/log"
  RC=$?
  DETAILS="$(jq -r '.result // empty' "$WORK/out.json" 2>/dev/null | tail -n 5)
$(tail -n 5 "$WORK/log")"
  LIMITED=$(rate_limited "$DETAILS" && echo 1)
  jq 'select(.is_error != true) | .structured_output' "$WORK/out.json" > "$WORK/verdict.json" 2>/dev/null
fi

if [ $RC -ne 0 ]; then
  printf 'Review did not complete (exit %d):\n%s\n' "$RC" "$DETAILS"
  [ -n "$LIMITED" ] && exit 3
  exit 2
fi
# `//` would turn ok:false into empty, so test the key explicitly.
case "$(jq -r 'if type == "object" and (.ok | type) == "boolean" and (.reason | type) == "string" then (.ok | tostring) else "" end' "$WORK/verdict.json" 2>/dev/null)" in
  true)  jq -r '.reason' "$WORK/verdict.json"; exit 0;;
  false) jq -r '.reason' "$WORK/verdict.json"; exit 1;;
  *)     printf 'Review returned no verdict:\n%s\n' "$DETAILS"; exit 4;;
esac
