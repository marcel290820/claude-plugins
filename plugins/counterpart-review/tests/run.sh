#!/bin/bash
# Checks the commit gate and the reviewer wrapper in both directions without model calls or real
# commits: fake codex, claude and gitleaks binaries on PATH, steered by FAKE_MODE and FAKE_SCAN.
# Usage: plugins/counterpart-review/tests/run.sh   (exit 0 = all pass)
set -u
S="$(cd "$(dirname "$0")/../scripts" && pwd)"
T=$(mktemp -d "${TMPDIR:-/tmp}/crtest.XXXXXX") || exit 1; trap 'rm -rf "$T"' EXIT
unset CLAUDE_PROJECT_DIR
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }
# expect NAME EXPECTED_SUBSTRING ACTUAL  (empty EXPECTED = expect no output)
expect() {
  if [ -z "$2" ]; then [ -z "$3" ] && ok || bad "$1: expected no output, got: $3"
  else printf '%s' "$3" | grep -qF -- "$2" && ok || bad "$1: expected '$2', got: $3"; fi
}

mkdir -p "$T/bin"
cat > "$T/bin/fake" <<'FAKE'
#!/bin/bash
name=$(basename "$0")
cat > "$FAKE_LOG.prompt"
printf '%s\n' "$@" > "$FAKE_LOG.args"
env > "$FAKE_LOG.env"
echo "$name" >> "$FAKE_LOG"
mode=${FAKE_MODE:-pass}
if [ "$name" = codex ]; then
  out=; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
  echo '{"type":"item.completed","item":{"type":"agent_message","text":"Reviewing rate limit handling."}}'
  case $mode in
    retry_timeout) echo '{"type":"error","message":"Rate limit reached, retrying"}'; exit 142;;
    recovered) echo '{"type":"error","message":"Rate limit reached, retrying"}'
               echo '{"type":"item.completed","item":{"type":"agent_message","text":"Retry succeeded"}}'; exit 1;;
    limit)   echo '{"type":"error","message":"You have hit your usage limit"}'; exit 1;;
    crash)   echo '{"type":"error","message":"review crashed"}'; exit 7;;
    missing) exit 0;;
    invalid) echo '{"ok":"true","reason":"x"}' > "$out";;
    block)   echo '{"ok":false,"reason":"x.txt:1 - fake finding - fix it"}' > "$out";;
    *)       echo '{"ok":true,"reason":"fine"}' > "$out";;
  esac
else
  case $mode in
    crash)   echo '{"is_error":true,"result":"review crashed"}'; exit 1;;
    limit)   echo '{"is_error":true,"result":"You have hit your usage limit"}'; exit 1;;
    missing) echo '{"structured_output":{}}';;
    invalid) echo '{"structured_output":{"ok":"true","reason":"x"}}';;
    block)   echo '{"structured_output":{"ok":false,"reason":"x.txt:1 - fake finding - fix it"}}';;
    *)       echo '{"structured_output":{"ok":true,"reason":"fine"}}';;
  esac
fi
FAKE
chmod +x "$T/bin/fake"
ln -s fake "$T/bin/codex" && ln -s fake "$T/bin/claude"
# FAKE_SCAN fails the staged scan, FAKE_SCAN_UNSTAGED the unstaged one.
printf '#!/bin/sh\necho "leak: fake finding"\ncase " $* " in *" --staged "*) exit "${FAKE_SCAN:-0}";; *) exit "${FAKE_SCAN_UNSTAGED:-0}";; esac\n' \
  > "$T/bin/gitleaks" && chmod +x "$T/bin/gitleaks"
export PATH="$T/bin:$PATH" FAKE_LOG="$T/calls" ANTHROPIC_API_KEY=test-only CLAUDE_CODE_EFFORT_LEVEL=low
calls() { [ -f "$FAKE_LOG" ] && wc -l < "$FAKE_LOG" | tr -d ' ' || echo 0; }
arg_after() { grep -A1 -Fx -- "$1" "$FAKE_LOG.args" | tail -n 1; }

newrepo() { git init -q "$1" && git -C "$1" config core.hooksPath /dev/null && git -C "$1" config user.email t@t && git -C "$1" config user.name t \
  && git -C "$1" commit -q --allow-empty -m init; }
# Everything below writes relative to the test repo; stop if it is not there.
newrepo "$T/repo" && cd "$T/repo" && echo x > x.txt && git add x.txt || { echo "test setup failed"; exit 1; }
# gate REVIEWER COMMAND: the hook input as Claude Code and Codex send it, run from the repo.
gate() { printf '{"cwd":"%s","tool_name":"Bash","tool_input":{"command":%s}}' "$T/repo" "$(jq -Rn --arg c "$2" '$c')" \
  | "$S/commit-gate.sh" "$1"; }
decision() { jq -r '.hookSpecificOutput.permissionDecision // empty'; }

for r in codex claude; do
  expect "$r: non-commit ignored" "" "$(gate $r 'ls -la')"
  n=$(calls)
  expect "$r: leak denied" 'gitleaks' "$(FAKE_SCAN=1 gate $r 'git commit -m x')"
  [ "$(calls)" = "$n" ] && ok || bad "$r: review must not run when gitleaks fails"
  expect "$r: unstaged leak denied" 'gitleaks' "$(FAKE_SCAN_UNSTAGED=1 gate $r 'git commit -am x')"
  expect "$r: clean passes" "" "$(gate $r 'git commit -m x')"
  [ "$(tail -n 1 "$FAKE_LOG")" = "$r" ] && ok || bad "$r: wrong reviewer binary ran"
  expect "$r: rtk prefix gated" "" "$(gate $r 'rtk git commit -m x')"
  [ "$(calls)" = "$((n+2))" ] && ok || bad "$r: review should run on both commits, ran $(($(calls)-n))"
  out=$(FAKE_MODE=block gate $r 'git commit -m x')
  expect "$r: findings deny" 'fake finding' "$out"
  expect "$r: findings decision" deny "$(printf '%s' "$out" | decision)"
  expect "$r: no verdict denies" 'no verdict' "$(FAKE_MODE=missing gate $r 'git commit -m x')"
  expect "$r: invalid verdict denies" 'no verdict' "$(FAKE_MODE=invalid gate $r 'git commit -m x')"
  for c in 'cd ../wt && git commit -m x' 'git -C "$WT" commit -m x' 'git -c user.name=x commit -m x' 'git --no-pager commit -m x'; do
    expect "$r: denies $c" 'with no cd before it' "$(gate $r "$c")"
  done
done

# Claude Code host (reviewer codex): fail closed, ask on a usage limit.
gate codex 'git commit -m x' >/dev/null
expect "codex: model" 'gpt-6.1-sol' "$(arg_after --model)"
grep -Fxq 'model_reasoning_effort="xhigh"' "$FAKE_LOG.args" && ok || bad "codex: effort must be xhigh"
grep -Fxq 'features.hooks=false' "$FAKE_LOG.args" && grep -Fxq -- '--ignore-user-config' "$FAKE_LOG.args" \
  && ok || bad "codex: reviewer must run without user config and hooks"
expect "codex: sandbox" 'read-only' "$(arg_after --sandbox)"
expect "codex: crash denies" 'did not complete' "$(FAKE_MODE=crash gate codex 'git commit -m x')"
expect "codex: retry then timeout denies" deny "$(FAKE_MODE=retry_timeout gate codex 'git commit -m x' | decision)"
expect "codex: recovered retry then failure denies" deny "$(FAKE_MODE=recovered gate codex 'git commit -m x' | decision)"
out=$(FAKE_MODE=limit gate codex 'git commit -m x')
expect "codex: usage limit asks" ask "$(printf '%s' "$out" | decision)"
expect "codex: usage limit says why" 'usage limit' "$out"

# Codex host (reviewer claude): warn and allow when the reviewer cannot run.
gate claude 'git commit -m x' >/dev/null
expect "claude: model" 'claude-opus-5-5' "$(arg_after --model)"
expect "claude: effort" 'xhigh' "$(arg_after --effort)"
expect "claude: tools" 'Read,Grep,Glob' "$(arg_after --tools)"
expect "claude: permission mode" 'dontAsk' "$(arg_after --permission-mode)"
for f in --safe-mode --restricted --no-session-persistence; do
  grep -Fxq -- "$f" "$FAKE_LOG.args" && ok || bad "claude: missing $f"
done
grep -Eq '^(ANTHROPIC_API_KEY|CLAUDE_CODE_EFFORT_LEVEL|CLAUDECODE)=' "$FAKE_LOG.env" \
  && bad "claude: API key, effort and CLAUDECODE must not reach the reviewer" || ok
out=$(FAKE_MODE=crash gate claude 'git commit -m x')
expect "claude: crash warns" 'review crashed' "$(printf '%s' "$out" | jq -r '.systemMessage')"
expect "claude: crash allows" "" "$(printf '%s' "$out" | decision)"
expect "claude: usage limit warns" 'usage limit' "$(FAKE_MODE=limit gate claude 'git commit -m x' | jq -r '.systemMessage')"

# The prompt carries the command and the unstaged diff that -a also commits.
echo UNSTAGED_MARK > x.txt
gate codex 'git commit -am x' >/dev/null
grep -q UNSTAGED_MARK "$FAKE_LOG.prompt" && grep -q 'git commit -am x' "$FAKE_LOG.prompt" \
  && ok || bad "prompt must carry the command and the unstaged diff"
git add x.txt

# Project check: a red check denies before the review; an unchanged green tree is not checked again.
mkdir -p .claude && printf '#!/bin/sh\necho repo-red; exit 3\n' > .claude/check.sh && chmod +x .claude/check.sh
n=$(calls)
expect "red check denied" 'repo-red' "$(gate codex 'git commit -m x')"
[ "$(calls)" = "$n" ] && ok || bad "review must not run when the project check fails"
printf '#!/bin/sh\necho ran >> %s; exit 0\n' "$T/runs" > .claude/check.sh
gate codex 'git commit -m x' >/dev/null; gate codex 'git commit -m x' >/dev/null
[ "$(wc -l < "$T/runs" | tr -d ' ')" = "1" ] && ok || bad "unchanged green tree must not rerun the check"

# The gate checks the repository it commits to, not the session's project dir.
newrepo "$T/wt"
mkdir -p "$T/wt/.codex" && printf '#!/bin/sh\necho wt-red; exit 3\n' > "$T/wt/.codex/check.sh" && chmod +x "$T/wt/.codex/check.sh"
echo y > "$T/wt/y.txt" && git -C "$T/wt" add y.txt
expect "-C runs that repo's check" 'wt-red' "$(CLAUDE_PROJECT_DIR="$T/repo" gate codex 'git -C ../wt commit -m x')"
expect "-C ~/ runs that repo's check" 'wt-red' "$(HOME="$T" CLAUDE_PROJECT_DIR="$T/repo" gate claude 'git -C ~/wt commit -m x')"
expect "-C in a message ignored" "" "$(gate codex 'git commit -m "see git -C ../wt commit"')"
expect "cd in a message allowed" "" "$(gate codex 'git commit -m "docs: cd into wt"')"

# Codex runs a command in tool_input.workdir when set; that is the repository to check.
expect "workdir is the repo checked" 'wt-red' "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x","workdir":"%s"}}' "$T/repo" "$T/wt" | "$S/commit-gate.sh" claude)"

# A new file staged in the same command is not in the index yet; the reviewer gets its name.
echo NEW_FILE_MARK > "$T/repo/new.txt"
gate codex 'git add new.txt && git commit -m x' >/dev/null
grep -qx new.txt "$FAKE_LOG.prompt" && ! grep -q NEW_FILE_MARK "$FAKE_LOG.prompt" && ok \
  || bad "the reviewer must get untracked file names, not their content"
rm "$T/repo/new.txt"

# Lockfiles stay out of the diff but a lockfile-only commit is still reviewed.
newrepo "$T/lk" && echo '{}' > "$T/lk/yarn.lock" && git -C "$T/lk" add yarn.lock
n=$(calls)
printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$T/lk" | "$S/commit-gate.sh" codex >/dev/null
[ "$(calls)" = "$((n+1))" ] && grep -q yarn.lock "$FAKE_LOG.prompt" && ok || bad "lockfile-only commit must be reviewed"

# Before the first commit, staged content still counts toward the green-check fingerprint.
git init -q "$T/unborn" && mkdir -p "$T/unborn/.claude" && echo a > "$T/unborn/a.txt" && git -C "$T/unborn" add a.txt
printf '#!/bin/sh\necho ran >> %s; exit 0\n' "$T/unborn-runs" > "$T/unborn/.claude/check.sh" && chmod +x "$T/unborn/.claude/check.sh"
(cd "$T/unborn" && "$S/project-check.sh" && echo b > a.txt && git add a.txt && "$S/project-check.sh")
[ "$(wc -l < "$T/unborn-runs" | tr -d ' ')" = "2" ] && ok || bad "unborn HEAD: a changed staged file must rerun the check"
# Same working tree, different staged content: a different commit, so the check runs again.
(cd "$T/unborn" && echo c > a.txt && git add a.txt && echo b > a.txt && "$S/project-check.sh")
[ "$(wc -l < "$T/unborn-runs" | tr -d ' ')" = "3" ] && ok || bad "a changed index alone must rerun the check"
# Same dirty patch on a new HEAD: other files may differ, so the check runs again.
(cd "$T/unborn" && git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -qm one && echo d > a.txt \
  && "$S/project-check.sh" && git -c core.hooksPath=/dev/null -c user.email=t@t -c user.name=t commit -q --allow-empty -m two \
  && "$S/project-check.sh")
[ "$(wc -l < "$T/unborn-runs" | tr -d ' ')" = "5" ] && ok || bad "a new HEAD must rerun the check"

# review.sh on its own, as the skill runs it.
out=$(echo plan | "$S/review.sh" claude); rc=$?
[ $rc -eq 0 ] && [ "$out" = fine ] && ok || bad "review.sh: pass should exit 0 with the summary (rc=$rc): $out"
out=$(echo plan | FAKE_MODE=block "$S/review.sh" codex); rc=$?
[ $rc -eq 1 ] && printf '%s' "$out" | grep -q 'fake finding' && ok || bad "review.sh: findings should exit 1 (rc=$rc): $out"
out=$(echo plan | FAKE_MODE=limit "$S/review.sh" claude); rc=$?
[ $rc -eq 3 ] && ok || bad "review.sh: usage limit should exit 3 (rc=$rc): $out"
out=$(echo plan | PATH=/usr/bin:/bin HOME="$T" "$S/review.sh" codex); rc=$?
[ $rc -eq 2 ] && printf '%s' "$out" | grep -q 'not on PATH' && ok || bad "review.sh: missing CLI should exit 2 (rc=$rc): $out"
echo plan | "$S/review.sh" gemini >/dev/null 2>&1; [ $? -eq 2 ] && ok || bad "review.sh: unknown reviewer must fail"

echo "passed=$pass failed=$fail"
[ $fail -eq 0 ]
