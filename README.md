# claude-plugins

Personal Claude Code mods (function-hook plugins) and one plugin for both Claude Code
and Codex, shipped as one marketplace.

| Plugin | What it does |
| --- | --- |
| `tips` | A proactive cheat sheet. When a prompt or turn fits a Claude Code command (a research question, a full context window, five changed files, an interrupted turn, an opened PR, a concept to learn), the hint line under the prompt suggests it once, e.g. `✦ /compact · context 81% full`. Tips stay rare (three prompts apart), only name commands this session has, and a command you have run twice stops being suggested. `/tips` opens the sheet as a launcher: type to filter, Enter puts the first match in the prompt, or Tab to any row. A weekly digest shows what you used and three commands to try. |
| `tutor` | `/tutor <question>` opens a **Tutor** pane and answers there as a lesson: in plain words, with a concrete example, starting from what you already know and from the session you are in. Ask about a term, a concept or a pasted passage; select text in the transcript first and `/tutor` explains it. Every concept it explains goes into a knowledge base on this machine. Under an answer, `g` marks its concepts known and `s`, `d` and `q` ask for it simpler, deeper or as a quiz. The **Knowledge** tab lists what you know by field. Next time the tutor builds on what you know instead of explaining it again. Set your background and the model (`opus` by default) in `/config`. |
| `counterpart-review` | Claude Code and Codex review each other. Every `git commit` an agent runs first passes a secrets scan (gitleaks), the project check, and a headless read-only review by the other agent: Codex (GPT 6.1 Sol, xhigh) in Claude Code, Claude (Opus 5.5, xhigh) in Codex. Findings block the commit, and the next review checks those fixes first instead of starting over. A pass shows the reviewer's summary. A reviewer that cannot run blocks in Claude Code (a usage limit asks you instead) and warns in Codex, which has no "ask". The `review` skill gets the same reviewer on demand for a plan, a diff or a branch (with nothing named: the uncommitted changes, else the branch): `/counterpart-review:review` in Claude Code, `$counterpart-review:review` in Codex. Needs the other agent's CLI, logged in. |

## Archived

`archive/debrief` (next steps and assumptions band) is retired: kept for reference, not in the marketplace, not checked.

## Install

```
/plugin install tips --marketplace <github-user>/claude-plugins
/plugin install tutor --marketplace <github-user>/claude-plugins
/plugin install counterpart-review --marketplace <github-user>/claude-plugins
```

From a local checkout, so `/reload-plugins` picks up your edits without a new version:

```
claude plugin marketplace add ~/Documents/Projects/Personal/claude-plugins
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

Claude Code lays a mod's API types (`.claude-plugin/types/`, ignored by git) when an
interactive session loads it; `check.sh` lends a new mod the types of one already
opened. Try a mod live with `claude --plugin-dir plugins/<name>`: saving a file reloads it.
