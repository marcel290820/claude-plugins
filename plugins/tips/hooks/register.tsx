import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Tip, TipsSession } from '../types'
import { SHEET } from './sheet'

const PANE = 'tips'
// Prompts between two tips, so they stay rare; urgent tips skip the wait.
const GAP = 3
// A command the person has run this often is known; its tip retires.
const KNOWN_AFTER = 2

const FRESH: TipsSession = { tip: null, shown: [], prompts: 0, lastAt: -GAP, edited: [], bash: [], asks: 0 }
const session = atom({ plugin: 'tips', key: 'session' } as const, FRESH)
const filter = atom({ plugin: 'tips', key: 'filter' } as const, '')

// First match wins, so the more specific patterns lead.
const PROMPT_TIPS: [RegExp, string, string][] = [
  [/\b(undo|revert (that|this|it|your)|roll ?back|go back to)\b/i, 'rewind', 'restores code and chat to a checkpoint (esc esc)'],
  [/\b(keep going|work|continue|iterate|loop) until\b/i, 'goal', 'keeps working until a condition holds'],
  [/\b(every|each) \d+ ?(s|secs?|seconds?|m|mins?|minutes?|h|hours?)\b|\bkeep (checking|polling|watching)\b|\bpoll\b/i, 'loop', 'repeats a prompt on an interval'],
  [/\b(every (day|morning|evening|night|week|weekday)|daily|nightly|weekly|on a cron)\b/i, 'schedule', 'runs it in the cloud on a schedule'],
  [/\b(across (the|all|every)|every file|all (the )?files|whole (codebase|repo)|codemod|everywhere)\b/i, 'batch', 'fans a large change out in parallel'],
  [/\b(research|state of the art|literature|sources|citations?|alternatives to)\b/i, 'deep-research', 'researches with cited sources'],
  [/\b(security|vulnerab\w*|auth(entication|orization)?|login|passwords?|secrets?|credentials?|xss|csrf|sql injection|jwt|oauth)\b/i, 'security-review', 'checks the change for vulnerabilities'],
  [/\b(simplify|clean ?up|tidy up|dedupe)\b/i, 'simplify', 'cleans up the diff for reuse and clarity'],
  [/\b(slides?|slide deck|presentation)\b/i, 'slides', 'builds a presentation'],
  [/\b(mockups?|wireframes?|artboards?)\b/i, 'design', 'creates design artboards'],
  [/\b(diagrams?|flowcharts?)\b/i, 'artifact-diagramming', 'loads diagram design guidance'],
  [/\b(charts?|plots?|dashboards?|visuali[sz]ations?)\b/i, 'dataviz', 'loads chart design guidance'],
  [/\b(in (the|my) browser|chrome|click (on )?the|fill (in|out) the form)\b/i, 'claude-in-chrome', 'drives your browser for the task'],
  [/\b(claude code|plugins?|hooks?|mcp|skills?|statusline)\b.*\b(broken|fails?|failing|not (working|loading|firing)|doesn'?t (work|load|fire))\b/i, 'doctor', 'diagnoses your setup (/debug for runtime issues)'],
  [/\b(meanwhile|in parallel|in the background)\b/i, 'fork', 'copies this into a background session'],
  [/\b(from|on) my phone\b|\baway from (my )?(desk|computer|laptop)\b/i, 'remote-control', 'drives this session from another device'],
  [/\bhow should (we|i)\b|\b(plan|design) (it|this) (first|before)\b/i, 'plan', 'plans before implementing (shift+tab)'],
]

const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|html)$/

export function promptTips(text: string, isMidTurn: boolean): Tip[] {
  const tips: Tip[] = []
  if (isMidTurn && text.trim().endsWith('?') && text.length < 200) {
    tips.push({ id: 'btw', why: 'asks a side question without derailing the turn' })
  }
  for (const [pattern, id, why] of PROMPT_TIPS) {
    if (pattern.test(text)) {
      tips.push({ id, why })
    }
  }
  if (text.length >= 400 && /\b(implement|build|create|migrate|rewrite)\b/i.test(text)) {
    tips.push({ id: 'plan', why: 'plans a big change before code (shift+tab)' })
  }

  return tips
}

export type TurnFacts = {
  context?: number
  fiveHour?: number
  isAborted: boolean
  durationMs: number
  session: TipsSession
}

export function turnTips({ context, fiveHour, isAborted, durationMs, session: s }: TurnFacts): Tip[] {
  const ran = (pattern: RegExp) => s.bash.some(command => pattern.test(command))

  return [
    context !== undefined && context >= 70 && { id: 'compact', why: `context ${context}% full; summarize to free room`, isUrgent: true },
    fiveHour !== undefined && fiveHour >= 80 && { id: 'usage', why: `${fiveHour}% of the 5-hour limit used`, isUrgent: true },
    isAborted && { id: 'rewind', why: 'restores code and chat to before that turn (esc esc)' },
    ran(/\bgh pr create\b/) && { id: 'autofix-pr', why: 'fixes the PR\'s CI and review comments for you' },
    s.asks >= 5 && { id: 'fewer-permission-prompts', why: `${s.asks} permission prompts so far; allowlist the safe ones` },
    s.edited.some(file => UI_FILE.test(file)) && { id: 'verify', why: 'sees the UI change working in the app' },
    (s.edited.length >= 5 || ran(/\bgit commit\b/)) && { id: 'code-review', why: `${s.edited.length} files changed; hunt bugs before they land` },
    durationMs >= 10 * 60_000 && { id: 'background', why: 'long runs can go to the background (/bg)' },
    s.prompts >= 10 && { id: 'rename', why: 'names this session so /resume finds it' },
    s.prompts >= 40 && { id: 'recap', why: 'sums up where this long session stands' },
  ].filter((tip): tip is Tip => tip !== false)
}

// Shows the first candidate not yet shown this session, not known by the person, and not too soon after the last tip.
export function offer(s: TipsSession, candidates: Tip[], used: Record<string, number>): TipsSession {
  const tip = candidates.find(
    one =>
      !s.shown.includes(one.id) &&
      (used[one.id] ?? 0) < KNOWN_AFTER &&
      (one.isUrgent === true || s.prompts - s.lastAt >= GAP),
  )

  return tip === undefined ? s : { ...s, tip, shown: [...s.shown, tip.id], lastAt: s.prompts }
}

// Each session counts under its own key, so sessions never overwrite each other's counts.
// ponytail: one small key per session that ran a command; fold old keys if the 4 MiB store ever fills.
const USED = 'used:'

// The store is JSON written by earlier sessions; keep only well-formed counts.
async function readCounts($: EngineInterface, key: string): Promise<Record<string, number>> {
  const stored = await $.store.get(key)
  if (typeof stored !== 'object' || stored === null) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  )
}

// Store read-modify-writes run one at a time, so this session's own writes never interleave.
// ponytail: separate processes can still interleave (the store has no compare-and-set); counts are per session, so only two digests started in the same instant can both show.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

async function readUsed($: EngineInterface): Promise<Record<string, number>> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(USED))
  const total: Record<string, number> = {}
  for (const counts of await Promise.all(keys.map(key => readCounts($, key)))) {
    for (const [name, count] of Object.entries(counts)) {
      total[name] = (total[name] ?? 0) + count
    }
  }

  return total
}

// "/code-review [level] [target] · /review" names code-review and review.
export function commandNames(usage: string): string[] {
  return [...usage.matchAll(/(?:^|· )\/([a-z-]+)/g)].map(match => match[1] ?? '')
}

const WEEK = 7 * 24 * 60 * 60_000
// Rows a digest may suggest: everything but the account group.
const TRYABLE = SHEET.filter(([group]) => group !== 'Account and extras').flatMap(([, rows]) => rows)

export type Digest = {
  at: number
  // The usage counts when it was made, to measure the next week against.
  used: Record<string, number>
  // Commands the person ran since the digest before, most first.
  week: [string, number][]
  // Rows to try this week, and every row offered so far, so each week brings new ones.
  picks: [string, string][]
  offered: string[]
}

// A digest is due a week after the last; the first comes right away.
export function weekly(now: number, last: Digest | undefined, used: Record<string, number>): Digest | undefined {
  if (last !== undefined && now - last.at < WEEK) {
    return undefined
  }

  const week = last === undefined
    ? []
    : Object.entries(used)
        .map(([name, count]): [string, number] => [name, count - (last.used[name] ?? 0)])
        .filter(([name, count]) => count > 0 && name !== 'tips')
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
  const untried = TRYABLE.filter(([usage]) => !commandNames(usage).some(name => (used[name] ?? 0) > 0))
  const fresh = untried.filter(([usage]) => !commandNames(usage).some(name => last?.offered.includes(name)))
  // Once every untried command was offered, the offers start over.
  const offered = fresh.length > 0 ? (last?.offered ?? []) : []
  const picks = (fresh.length > 0 ? fresh : untried).slice(0, 3)

  return { at: now, used, week, picks, offered: [...offered, ...picks.flatMap(([usage]) => commandNames(usage))] }
}

export function digestLine({ week, picks }: Digest): string {
  const ran = week.map(([name, count]) => `/${name} ×${count}`).join(', ')
  const tries = picks.map(([usage, purpose]) => `/${commandNames(usage)[0]} (${purpose.toLowerCase()})`).join(', ')

  return [
    'Weekly tips',
    ran === '' ? '' : `since the last digest you ran ${ran}`,
    tries === '' ? 'you have tried every command' : `try ${tries}`,
    '/tips for the full sheet',
  ].filter(part => part !== '').join(' · ')
}

// The store is JSON written by earlier sessions; a digest of another shape counts as none.
async function readDigest($: EngineInterface): Promise<Digest | undefined> {
  const stored = await $.store.get('digest')
  const isDigest =
    typeof stored === 'object' && stored !== null &&
    'at' in stored && typeof stored.at === 'number' &&
    'used' in stored && typeof stored.used === 'object' && stored.used !== null &&
    'week' in stored && Array.isArray(stored.week) &&
    'picks' in stored && Array.isArray(stored.picks) &&
    'offered' in stored && Array.isArray(stored.offered)

  // ponytail: checks the top-level shape only; the store is written by this mod alone.
  return isDigest ? (stored as Digest) : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tips',
      description: 'Open the Claude Code cheat sheet; /tips <word> filters it',
      argumentHint: '[filter]',
    })

    if (e.isInteractive) {
      const digest = await serial(async () => {
        const due = weekly(await $.clock.now(), await readDigest($), await readUsed($))
        if (due !== undefined) {
          await $.store.set('digest', due)
        }
        return due
      })
      if (digest !== undefined) {
        $.ui.log(digestLine(digest))
      }
    }

    return next(e)
  })

  on('command.run', { command: 'tips' }, async ($, e) => {
    await update($, filter, () => e.args.trim())
    await $.ui.open({ id: PANE, title: 'Tips', focus: true })

    return {}
  })

  // Counts each command the person runs; a known command's tip retires, and a tip they just took clears.
  on('command.run', async ($, e, next) => {
    if (e.origin.kind === 'composer') {
      const key = `${USED}${await $.session.id()}`
      await serial(async () => {
        const mine = await readCounts($, key)
        await $.store.set(key, { ...mine, [e.command]: (mine[e.command] ?? 0) + 1 })
      })
      await update($, session, s => (s.tip?.id === e.command ? { ...s, tip: null } : s))
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !e.text.startsWith('/')) {
      const used = await readUsed($)
      await update($, session, s =>
        offer({ ...s, tip: null, bash: [], prompts: s.prompts + 1 }, promptTips(e.text, e.turnId !== undefined), used),
      )
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) {
      return ran
    }

    if (e.tool === 'Bash') {
      const command = e.command
      await update($, session, s => ({ ...s, bash: [...s.bash, command].slice(-20) }))
    } else if (e.tool === 'Edit' || e.tool === 'Write') {
      const file = e.file_path
      await update($, session, s => (s.edited.includes(file) ? s : { ...s, edited: [...s.edited, file] }))
    }

    return ran
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    await update($, session, s => ({ ...s, asks: s.asks + 1 }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const usage = await $.session.usage()
      const used = await readUsed($)
      await update($, session, s =>
        offer(
          s,
          turnTips({
            context: usage.context.percent,
            fiveHour: usage.rateLimits.find(limit => limit.kind === 'five_hour')?.percentUsed,
            isAborted: e.isAborted,
            durationMs: e.durationMs,
            session: s,
          }),
          used,
        ),
      )
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, session, () => FRESH)
    }

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const { tip } = await read($, session)

    return next(tip === null ? e : { ...e, props: { ...e.props, tail: `✦ /${tip.id} · ${tip.why}` } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const [{ tip }, query, used, digest] = await Promise.all([
      read($, session),
      read($, filter),
      readUsed($),
      readDigest($),
    ])
    const needle = query.toLowerCase()
    const groups = SHEET.map(([group, rows]) => [
      group,
      rows.filter(([usage, purpose]) => `${usage} ${purpose}`.toLowerCase().includes(needle)),
    ] as const).filter(([, rows]) => rows.length > 0)
    // One row per command: purposes stay whole where they can, and the usage column takes the rest.
    const rows = groups.flatMap(([, list]) => list)
    const longest = (column: 0 | 1) => Math.max(0, ...rows.map(row => row[column].length))
    const width = Math.min(longest(0), Math.max(18, e.props.bodyColumns - 4 - longest(1)))

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold>Cheat sheet</Text>
          <Text dimColor>
            {query === '' ? '' : `"${query}" · `}✓ used · ✦ suggested now
          </Text>
        </Box>
        {tip !== null && (
          <Box gap={1} marginTop={1}>
            <Text color="suggestion">✦ /{tip.id}</Text>
            <Text>{tip.why}</Text>
          </Box>
        )}
        {query === '' && digest !== undefined && digest.picks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Box gap={1}>
              <Text bold color="claude">
                This week
              </Text>
              {digest.week.length > 0 && (
                <Text dimColor>since the last digest you ran {digest.week.map(([name, count]) => `/${name} ×${count}`).join(', ')}</Text>
              )}
            </Box>
            {digest.picks.map(([usage, purpose]) => (
              <Box key={`try-${usage}`} gap={1}>
                <Text color="suggestion">→</Text>
                <Text color="suggestion">{usage}</Text>
                <Text dimColor wrap="truncate-end">
                  {purpose}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {groups.length === 0 && <Text dimColor>No command matches "{query}".</Text>}
        {groups.map(([group, rows]) => (
          <Box key={group} flexDirection="column" marginTop={1}>
            <Text bold color="claude">
              {group}
            </Text>
            {rows.map(([usage, purpose]) => {
              const names = commandNames(usage)
              const isTip = tip !== null && names.includes(tip.id)
              const isUsed = names.some(name => (used[name] ?? 0) > 0)

              return (
                <Box key={usage} gap={1}>
                  <Text color={isTip ? 'suggestion' : 'success'}>{isTip ? '✦' : isUsed ? '✓' : ' '}</Text>
                  <Box width={width} flexShrink={0}>
                    <Text bold={isTip} color={isTip ? 'suggestion' : undefined} wrap="truncate-end">
                      {usage}
                    </Text>
                  </Box>
                  <Text dimColor={!isTip} wrap="truncate-end">
                    {purpose}
                  </Text>
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}
