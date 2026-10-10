---
name: review
description: Counterpart review on demand. Claude Code asks Codex (GPT 6.1 Sol, xhigh); Codex asks Claude (Opus 5.5, xhigh). Use when the user asks for a review, second opinion, counterpart review or adversarial check of a plan, a design, uncommitted changes, a branch, a diff, a file, or other work. Commits are already reviewed by the commit gate; this is for everything else.
---

# Counterpart review

The other agent reviews the work headless and read-only: it can read files in the
current directory, never change them.

1. **Pick the reviewer.** You are Claude Code: `codex`. You are Codex: `claude`.

2. **Pick what to review.** What the user named. Named nothing: the plan or design
   under discussion when there is one; otherwise the uncommitted changes (staged,
   unstaged and new files); with a clean tree, the current branch against its base
   (`git diff $(git merge-base HEAD origin/HEAD 2>/dev/null || git merge-base HEAD main)...HEAD`).
   Say in one line what you are sending, then go on without asking.

3. **Write the prompt** to a temp file. The reviewer sees nothing of this session, so
   the prompt must stand alone:
   - What to review. Paste a plan or design in full. For code, paste the diff itself
     (`git diff`, `git diff main...HEAD`) and name the files: the reviewer can read and
     search files but cannot run git or any other command.
   - The goal and constraints the work must meet, in the user's words where possible.
   - Close with: "Review adversarially: look for wrong assumptions, logic errors,
     missed cases, unhandled failures, security issues, and simpler designs that meet
     the same goal. Ignore style. Set ok=true only when nothing must change. Otherwise
     set ok=false with reason as a numbered list of 'location - problem - fix'."

4. **Run it** from the repository root, with the script two levels above this
   skill's directory:

   ```
   <skill dir>/../../scripts/review.sh <reviewer> < <prompt file>
   ```

   A review can take up to 13 minutes. Claude Code: run it in the background. Codex:
   give the command a 15-minute timeout; it needs network access, so request
   escalation if the sandbox blocks it.

5. **Read the exit code.**

   | Exit | Meaning |
   | --- | --- |
   | 0 | Pass. The output is the reviewer's summary. |
   | 1 | Findings, as a numbered list. |
   | 2 | The reviewer could not run (CLI missing, crash, timeout). Output says why. |
   | 3 | The reviewer is at its usage limit. |
   | 4 | It ran but returned no verdict. Retry once. |

6. **Verify before you act.** Check each finding against the code or the plan, then
   report one line per finding, `accepted` or `rejected` with the reason, accepted
   first. Apply accepted fixes only when the user asked for fixes; otherwise offer
   them as next steps.
