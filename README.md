# claude-mods

Personal Claude Code mods (function-hook plugins), shipped as one marketplace.

| Mod | What it does |
| --- | --- |
| `next-steps` | Reads the "Next steps" section that ends each reply and lists the steps in the band above the prompt. With the prompt empty, press `1`-`9` (or click a step) to put that step in the prompt. The band hides while a turn runs and when the steps are "none". |
| `assumptions` | Collects every `ASSUMPTION:` line Claude writes into an **Assumptions** pane. The status line shows how many are open. Mark each one `holds` (`y`) or `wrong` (`n`); `wrong` fills the prompt with a correction to finish. Open the pane with `/assumptions`. On a wide fullscreen terminal it docks by itself when a new assumption arrives. |

The conventions themselves (end each reply with "Next steps", prefix
unverified assumptions with `ASSUMPTION:`) stay in `AGENTS.md`, so Codex keeps
following them too. The mods only read and present them.

## Install

From GitHub (repo is private; needs GitHub access on that machine):

```
/plugin install next-steps --marketplace <github-user>/claude-mods
/plugin install assumptions --marketplace <github-user>/claude-mods
```

From a local checkout, so `/reload-plugins` picks up your edits without a new version:

```
claude plugin marketplace add ~/Documents/Projects/Personal/claude-mods
claude plugin install next-steps@claude-mods
claude plugin install assumptions@claude-mods
```

## Develop

Each mod is `plugins/<name>/` with `.claude-plugin/plugin.json`,
`hooks/register.tsx`, its state contract in `types/index.d.ts`, and tests in
`tests/`. `.claude/check.sh` validates, type-checks and tests every mod.

The test kit has no stand-in for the transcript store, so the `session.append`
path in `assumptions` is checked in a live session, not in `check.sh`.
