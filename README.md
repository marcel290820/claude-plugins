# claude-plugins

Personal Claude Code mods (function-hook plugins) and one plugin for both Claude Code
and Codex, shipped as one marketplace.

| Plugin | What it does |
| --- | --- |
| `debrief` | After each turn, the band above the prompt shows Claude's debrief with one number per row. A bare digit in the empty prompt presses a row. **Claude's next steps** go into the prompt (`0` for all of them). **Your steps** (the ones Claude marks `You:`) tick off. **Assumptions** (`ASSUMPTION:` lines) step through *holds* on the first press and *wrong* on the second, which opens a correction in the prompt. Your next prompt tells Claude what you confirmed, corrected and finished, so you never retype it. Assumptions show as soon as Claude writes them, so a wrong one can be caught mid-turn, and they stay until you answer them. Nothing waits on you: steps follow Claude's latest reply, so a step you ignore just goes away. One more row asks Claude to check the open assumptions itself and report each as holding, wrong or unsure. `/assumptions` opens the session's full ledger. |
| `tips` | A proactive cheat sheet. When a prompt or turn fits a Claude Code command (a research question, a full context window, five changed files, an interrupted turn, an opened PR), the hint line under the prompt suggests it once, e.g. `✦ /compact · context 81% full`. Tips stay rare (three prompts apart), and a command you have run twice stops being suggested. `/tips` opens the whole cheat sheet; `/tips <word>` filters it. |
| `tutor` | `/tutor <question>` opens a **Tutor** pane and answers there as a lesson: in plain words, with a concrete example, starting from what you already know and from the session you are in. Ask about a term, a concept or a pasted passage; select text in the transcript first and `/tutor` explains it. Every concept it explains goes into a knowledge base on this machine. Under an answer, `g` marks its concepts known and `s`, `d` and `q` ask for it simpler, deeper or as a quiz. The **Knowledge** tab lists what you know by field. Next time the tutor builds on what you know instead of explaining it again. Set your background and the model (`opus` by default) in `/config`. |
| `counterpart-review` | Claude Code and Codex review each other. Every `git commit` an agent runs first passes a secrets scan (gitleaks), the project check, and a headless read-only review by the other agent: Codex (GPT 6.1 Sol, xhigh) in Claude Code, Claude (Opus 5.5, xhigh) in Codex. Findings block the commit. A reviewer that cannot run blocks in Claude Code (a usage limit asks you instead) and warns in Codex, which has no "ask". The `review` skill gets the same reviewer on demand for a plan, a diff or a branch: `/counterpart-review:review` in Claude Code, `$counterpart-review:review` in Codex. Needs the other agent's CLI, logged in. |

`debrief` adds a short section to Claude's system prompt with the exact forms it reads
(a `## Next steps` list with `You:` for your own steps, one `ASSUMPTION:` per line), so
it works without any CLAUDE.md. Keep the conventions in `AGENTS.md` too if Codex
should follow them.

## Install

```
/plugin install debrief --marketplace <github-user>/claude-plugins
/plugin install tips --marketplace <github-user>/claude-plugins
/plugin install tutor --marketplace <github-user>/claude-plugins
/plugin install counterpart-review --marketplace <github-user>/claude-plugins
```

From a local checkout, so `/reload-plugins` picks up your edits without a new version:

```
claude plugin marketplace add ~/Documents/Projects/Personal/claude-plugins
claude plugin install debrief@personal-plugins
claude plugin install tips@personal-plugins
claude plugin install tutor@personal-plugins
claude plugin install counterpart-review@personal-plugins
```

`debrief` replaces the former `next-steps` and `assumptions` plugins; uninstall those
first (`claude plugin uninstall next-steps@personal-plugins assumptions@personal-plugins`).

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
