#!/bin/bash
# PreToolUse gate on Bash. Usage: commit-gate.sh codex|claude (the reviewer; the host is the other one).
# Acts when the command runs `git commit` (also `rtk git commit` and `git -C <dir> commit`) and checks
# the repository that commit lands in:
# 1. gitleaks scans the staged diff for secrets (skipped when gitleaks is missing).
# 2. The project check (project-check.sh) must be green for that repository.
# 3. The counterpart reviews the commit headless and read-only (review.sh).
# Pass -> allowed, the reviewer's summary shown to the person (systemMessage).
# Findings or a missing verdict -> permissionDecision deny; the findings go to the next review of that repository.
# Reviewer could not run: in Claude Code (reviewer codex) a usage limit asks and anything else denies
# (fail closed). Codex rejects permissionDecision "ask", so there (reviewer claude) it warns through
# systemMessage and lets the commit through rather than locking every commit.
# Not a git repo, not a commit, or nothing to commit -> exit 0.
# Text matching covers commits as agents normally write them. Only the first commit in a command is
# checked (later matches are usually commit message text), and forms that could commit elsewhere
# (cd before the commit, other git options, a -C path with variables or quotes) are denied with a
# hint. The git-level backstop (~/.claude/git-hooks) reruns gitleaks and the project check inside
# every agent commit, whatever the command looked like.
# Hook runners (e.g. the VPS Codex daemon) can start with a minimal PATH; user-installed tools live here.
export PATH="$PATH:$HOME/.local/bin"
set -u
REVIEWER=${1:-}
case "$REVIEWER" in codex|claude) ;; *) echo "Usage: commit-gate.sh codex|claude" >&2; exit 1;; esac
INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}
ask() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}
# Shows the person a line and lets the commit through.
note_and_allow() {
  jq -n --arg m "$1" '{systemMessage:$m}'
  exit 0
}

# git, then options (each with at most one argument), then commit.
[[ $CMD =~ (^|[^[:alnum:]_-])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$) ]] || exit 0
HIT=${BASH_REMATCH[0]}
HINT="Run the commit as \`git commit\` or \`git -C <path> commit\`, with no cd before it and no other git options, so the commit gate checks the repository that is committed."
[[ ${CMD%%"$HIT"*} =~ (^|[^[:alnum:]_-])(cd|pushd)[[:space:]] ]] && deny "$HINT"
[[ $HIT =~ ^[^[:alnum:]_-]?git[[:space:]]+(-C[[:space:]]+([[:alnum:]_./~@%+=:,-]+)[[:space:]]+)?commit ]] || deny "$HINT"
GIT_C=${BASH_REMATCH[2]/#\~/$HOME}
# The command runs in its workdir (Codex, when set) or the hook's cwd, so a relative -C resolves there.
BASE=$(printf '%s' "$INPUT" | jq -r '.tool_input.workdir // .cwd // empty')
cd "${BASE:-${CLAUDE_PROJECT_DIR:-.}}" || exit 0
cd "${GIT_C:-.}" 2>/dev/null || exit 0
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$ROOT" || exit 0
H="$(cd "$(dirname "$0")" && pwd)"

# 1. secrets
if command -v gitleaks >/dev/null 2>&1; then
  # Staged changes, then unstaged tracked ones, which -a or paths also commit.
  for STAGE in --staged ""; do
    OUT=$(gitleaks git --pre-commit $STAGE --no-banner --redact 2>&1) \
      || deny "Secrets in the changes this commit may take (gitleaks). Remove them, then commit:
$(printf '%s' "$OUT" | tail -n 30)"
  done
fi

# 2. project check, in this repository only
OUT=$("$H/project-check.sh") || deny "$OUT"

# 3. review. Which changes the commit takes (-a, paths, a `git add` before it) is left to the
# reviewer: it gets the command, the file lists, the staged diff, the unstaged tracked diff and the
# names of new untracked files, which it reads itself when the command adds them. Lockfiles,
# snapshots and minified files show in the file lists only.
NEW=$(git ls-files --others --exclude-standard)
git diff --cached --quiet && git diff --quiet && [ -z "$NEW" ] && exit 0
EXCL=(':(exclude)*.lock' ':(exclude)package-lock.json' ':(exclude)*.min.js' ':(exclude)*.min.css' ':(exclude)*.snap')
STAGED=$(git diff --cached -- . "${EXCL[@]}")
UNSTAGED=$(git diff -- . "${EXCL[@]}")
DIFF="Command: $CMD

Files changed, staged:
$(git diff --cached --stat)

Files changed, unstaged tracked:
$(git diff --stat)

Staged diff (what a plain commit takes):
${STAGED:-(none)}

Unstaged tracked diff (also committed with -a or paths):
${UNSTAGED:-(none)}

Untracked files (committed only when the command adds them; read them when it does):
${NEW:-(none)}"
MAX=150000
[ ${#DIFF} -gt $MAX ] && DIFF="${DIFF:0:$MAX}
[diff truncated at $MAX bytes]"

# The findings of the last review that blocked a commit here, so the next review checks those fixes rather than
# starting over (a fresh reviewer tends to raise new points each round). Kept six hours; a pass clears them.
FINDINGS="$(git rev-parse --git-dir)/counterpart-review-findings"
EARLIER=""
if [ -n "$(find "$FINDINGS" -mmin -360 2>/dev/null)" ]; then
  EARLIER="

An earlier review of this work blocked a commit with the findings below. Check first whether each is fixed now. Raise anything else only when it is a real defect in these changes, not a matter of taste.
<earlier-findings>
$(cat "$FINDINGS")
</earlier-findings>"
fi

PROMPT="You are a strict pre-commit reviewer. Below is a git commit command and the changes it may commit in $ROOT; judge only the changes this command commits. Read files in the repository for context when needed. Look for: logic errors, race conditions, unhandled error paths or swallowed exceptions, secrets or credentials, a bugfix or non-trivial logic change (a branch, loop, parser, money or security path) with no matching test change - a trivial helper, one-liner, or pure type/doc change needs no test and missing coverage alone is never grounds to fail a commit, and changed signatures whose other call sites were not updated (grep for callers). Ignore style and formatting. Docs-only or comment-only diffs pass. Set ok=true when the commit is safe. Set ok=false with reason as a numbered list of 'file:line - problem - fix' when it must not go in. Strict on correctness, lenient on taste.$EARLIER

$DIFF"

OUT=$(printf '%s' "$PROMPT" | "$H/review.sh" "$REVIEWER")
RC=$?
NAME=$([ "$REVIEWER" = codex ] && echo "Codex" || echo "Claude")
case $RC in
  0) rm -f "$FINDINGS"
     note_and_allow "$NAME reviewed the commit: $(printf '%s' "$OUT" | head -c 600)";;
  1) printf '%s\n' "$OUT" > "$FINDINGS"
     deny "$NAME's commit review found issues:
$OUT

Fix them and commit again; the next review checks these fixes first. If a finding is wrong, do not work around the gate: tell the user why and let them decide.";;
  4) deny "Commit review returned no verdict. Retry the commit:
$OUT";;
esac
# 2 or 3: the reviewer failing is not the same as the reviewer objecting.
UNREVIEWED="The staged changes passed the secrets scan and the project check, but the commit reviewer could not run. Nothing was found wrong with this commit - it simply was not reviewed.
$OUT"
[ "$REVIEWER" = claude ] && note_and_allow "$UNREVIEWED"
# A usage limit would lock every commit until it resets, so hand the call to the user.
[ $RC -eq 3 ] && ask "$UNREVIEWED
Approve to commit unreviewed, or deny and retry after the limit resets."
deny "Commit review did not complete. Retry the commit:
$OUT"
