# claude-plugins

Personal Claude Code mods (function-hook plugins) and one plugin for both Claude Code
and Codex, shipped as one marketplace.

| Mod | What it does |
| --- | --- |
| `next-steps` | Reads the "Next steps" section that ends each reply and lists the steps in the band above the prompt. With the prompt empty, press `1`-`9` (or click a step) to put that step in the prompt. The band hides while a turn runs and when the steps are "none". |
| `assumptions` | Collects every `ASSUMPTION:` line Claude writes into an **Assumptions** pane. The status line shows how many are open. Mark each one `holds` (`y`) or `wrong` (`n`); `wrong` fills the prompt with a correction to finish. Open the pane with `/assumptions`. On a wide fullscreen terminal it docks by itself when a new assumption arrives. |
| `tips` | A proactive cheat sheet. When a prompt or turn fits a Claude Code command (a research question, a full context window, five changed files, an interrupted turn, an opened PR), the hint line under the prompt suggests it once, e.g. `✦ /compact · context 81% full`. Tips stay rare (three prompts apart), and a command you have run twice stops being suggested. `/tips` opens the whole cheat sheet; `/tips <word>` filters it. |
| `tutor` | `/tutor <question>` opens a **Tutor** pane and answers there as a lesson: in plain words, with a concrete example, starting from what you already know and from the session you are in. Ask about a term, a concept or a pasted passage; select text in the transcript first and `/tutor` explains it. Every concept it explains goes into a knowledge base on this machine. Under an answer, `g` marks its concepts known and `s`, `d` and `q` ask for it simpler, deeper or as a quiz. The **Knowledge** tab lists what you know by field. Next time the tutor builds on what you know instead of explaining it again. Set your background and the model (`opus` by default) in `/config`. |
| `counterpart-review` | Claude Code and Codex review each other. Every `git commit` an agent runs first passes a secrets scan (gitleaks), the project check, and a headless read-only review by the other agent: Codex (GPT 6.1 Sol, xhigh) in Claude Code, Claude (Opus 5.5, xhigh) in Codex. Findings block the commit. A reviewer that cannot run blocks in Claude Code (a usage limit asks you instead) and warns in Codex, which has no "ask". The `review` skill gets the same reviewer on demand for a plan, a diff or a branch: `/counterpart-review:review` in Claude Code, `$counterpart-review:review` in Codex. Needs the other agent's CLI, logged in. |

The conventions themselves (end each reply with "Next steps", prefix
unverified assumptions with `ASSUMPTION:`) stay in `AGENTS.md`, so Codex keeps
following them too. The mods only read and present them.

## Install

From GitHub (repo is private; needs GitHub access on that machine):

```
/plugin install next-steps --marketplace <github-user>/claude-plugins
/plugin install assumptions --marketplace <github-user>/claude-plugins
/plugin install tips --marketplace <github-user>/claude-plugins
/plugin install tutor --marketplace <github-user>/claude-plugins
```

From a local checkout, so `/reload-plugins` picks up your edits without a new version:

```
claude plugin marketplace add ~/Documents/Projects/Personal/claude-plugins
claude plugin install next-steps@personal-plugins
claude plugin install assumptions@personal-plugins
claude plugin install tips@personal-plugins
claude plugin install tutor@personal-plugins
claude plugin install counterpart-review@personal-plugins
```

Codex reads the same checkout through `.agents/plugins/marketplace.json`:

```
codex plugin marketplace add ~/Documents/Projects/Personal/claude-plugins
codex plugin add counterpart-review@personal-plugins
```

`counterpart-review` needs `jq` and `perl` (without `jq` the gate cannot parse the
command and checks nothing); `gitleaks` is optional and the secrets scan is
skipped without it. Codex asks you to trust the plugin's hook before it runs it. Remove any
hand-wired commit gate from `~/.claude/settings.json` or `~/.codex/hooks.json`
first, or every commit is reviewed twice.

## Develop

Each mod is `plugins/<name>/` with `.claude-plugin/plugin.json`,
`hooks/register.tsx`, its state contract in `types/index.d.ts`, and tests in
`tests/`. `counterpart-review` is shell: `scripts/`, two hook files
(`hooks/claude.json`, `hooks/codex.json`) that pass the reviewer to the shared
`commit-gate.sh`, and `tests/run.sh` with fake `codex`, `claude` and `gitleaks`
binaries. `.claude/check.sh` validates every plugin, type-checks and tests the
mods, and runs `tests/run.sh` where a plugin has one.

The test kit has no stand-in for the transcript store, so the `session.append`
path in `assumptions` is checked in a live session, not in `check.sh`.
