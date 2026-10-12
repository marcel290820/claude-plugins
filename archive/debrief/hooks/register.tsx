import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Assumption, Mark, Marked, Step, Verdict } from '../types'
import {
  correction,
  fit,
  FORMAT,
  hide,
  named,
  newsContext,
  parseAssumptions,
  parseSteps,
  parseVerdicts,
  same,
  VERIFY,
  verifyContext,
} from './parse'

const PANE = 'assumptions'
// Assumption rows the band shows at most; the older ones wait in the pane.
const SHOWN = 4

const steps = atom({ plugin: 'debrief', key: 'steps' } as const, [] as Step[])
const marks = atom({ plugin: 'debrief', key: 'marks' } as const, [] as Marked[])
const assumptions = atom({ plugin: 'debrief', key: 'assumptions' } as const, [] as Assumption[])
// Counts the person's prompts; an assumption carries the count it was made under.
const round = atom({ plugin: 'debrief', key: 'round' } as const, 0)

const isOpen = (one: Assumption) => one.verdict === undefined

// The assumption under a new verdict, or open again with none (so a later verdict is news again). Claude's own
// verdict is one it has heard.
function settle(one: Assumption, verdict: Verdict | undefined, now: number, change: { note?: string; isClaudes?: boolean } = {}): Assumption {
  const { verdict: _was, settledIn: _in, told: _told, ...rest } = one
  const note = change.note === undefined || change.note === '' ? {} : { note: change.note }

  return verdict === undefined
    ? { ...rest, ...note }
    : { ...rest, ...note, verdict, settledIn: now, ...(change.isClaudes === true ? { told: verdict } : one.told === undefined ? {} : { told: one.told }) }
}

// Puts text in the prompt box after the draft, on a line of its own when there is one, so a press never writes over
// what was typed. One at a time, so each of two quick presses reads the draft the other left.
let filling: Promise<unknown> = Promise.resolve()
function put($: EngineInterface, text: string): Promise<void> {
  const run = filling.then(async () => {
    const { text: draft } = await $.prompt.read()
    await $.prompt.fill({ text: draft.trim() === '' ? text : `\n${text}`, mode: 'append' })
  })
  filling = run.catch(() => undefined)
  return run
}

async function judge($: EngineInterface, text: string, verdict: Verdict | undefined) {
  const now = await read($, round)
  await update($, assumptions, all => all.map(one => (same(one.text, text) ? settle(one, verdict, now) : one)))
  if (verdict === 'wrong') {
    await put($, correction(text))
  }
}

// One key walks an assumption through open, holds, wrong (which opens a correction) and back to open. The step is
// taken from the stored verdict, so two presses before a redraw still land on wrong.
async function press($: EngineInterface, text: string) {
  const now = await read($, round)
  let became: Verdict | undefined
  await update($, assumptions, all =>
    all.map(one => {
      if (!same(one.text, text)) {
        return one
      }
      became = one.verdict === undefined ? 'holds' : one.verdict === 'holds' ? 'wrong' : undefined
      return settle(one, became, now)
    }),
  )
  if (became === 'wrong') {
    await put($, correction(text))
  }
}

const CYCLE: readonly (Mark | undefined)[] = [undefined, 'next', 'drop', 'mine', 'chat']

// One key walks a step through open, next, drop, mine, chat and back to open. Nothing goes into the prompt, so the
// digits keep working; the next prompt tells Claude. The step is taken from the stored mark, so two quick presses
// move it two. Steps match by exact text: two that differ only in case are two actions.
function cycle($: EngineInterface, text: string) {
  return update($, marks, list => {
    const was = list.find(one => one.text === text)?.mark
    const mark = CYCLE[(CYCLE.indexOf(was) + 1) % CYCLE.length]
    const rest = list.filter(one => one.text !== text)
    return mark === undefined ? rest : [...rest, { text, mark, isTold: false }]
  })
}

// Marks every open step for Claude to do next; marked ones keep their mark.
function allNext($: EngineInterface, texts: readonly string[]) {
  return update($, marks, list => [
    ...list,
    ...texts.filter(text => !list.some(one => one.text === text)).map(text => ({ text, mark: 'next' as const, isTold: false })),
  ])
}

// New assumptions join the person's latest prompt; one said again while open joins it again. Claude's verdict lines
// settle the assumptions they name; UNSURE leaves one open with its reason.
export function absorb(all: readonly Assumption[], text: string, now: number): Assumption[] {
  let kept = [...all]
  for (const one of parseAssumptions(text)) {
    const known = kept.find(seen => same(seen.text, one))
    if (known === undefined) {
      kept.push({ text: one, round: now })
    } else if (isOpen(known)) {
      kept = kept.map(seen => (seen === known ? { ...seen, round: now } : seen))
    }
  }
  for (const { kind, claim, note } of parseVerdicts(text)) {
    const target = named(kept, claim)
    const verdict = kind === 'unsure' ? undefined : kind
    kept = kept.map(one => (one === target ? settle(one, verdict, now, { note, isClaudes: true }) : one))
  }

  return kept
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'assumptions',
      description: 'Every assumption Claude made this session, to confirm or correct',
    })
    // A resumed session shows the steps its last reply left.
    if ((await read($, steps)).length === 0) {
      const last = (await $.session.messages()).findLast(one => one.role === 'assistant' && one.text.trim() !== '')
      const found = parseSteps(last?.text ?? '')
      if (found.length > 0) {
        await update($, steps, () => found)
      }
    }

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return e.traits.includes('bare')
      ? composed
      : { sections: [...composed.sections, { id: 'debrief:format', text: FORMAT, scope: 'session' }] }
  })

  // The person's prompt carries what they marked since Claude last heard, and starts a round; the verify prompt
  // carries the open assumptions.
  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    const [all, marked] = await Promise.all([read($, assumptions), read($, marks)])
    const unheard = (verdict: Verdict) => all.filter(one => one.verdict === verdict && one.told !== verdict).map(one => one.text)
    const unsent = (mark: Mark) => marked.filter(one => one.mark === mark && !one.isTold).map(one => one.text)
    const byMark = { next: unsent('next'), drop: unsent('drop'), mine: unsent('mine'), chat: unsent('chat') }
    const sent = { holds: unheard('holds'), wrong: unheard('wrong'), steps: byMark }
    const news = isPerson ? newsContext(sent) : undefined
    const open = all.filter(isOpen).map(one => one.text)
    const isVerify = open.length > 0 && e.text.split('\n').some(line => line.trim().toLowerCase().startsWith(VERIFY.toLowerCase()))
    const context = [...(news === undefined ? [] : [news]), ...(isVerify ? [verifyContext(open)] : [])]

    const entered = await next(context.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...context] })
    if (entered.drop !== undefined) {
      return entered
    }
    if (isPerson) {
      await update($, round, n => n + 1)
    }
    // Only what this prompt carried counts as heard: a mark made meanwhile waits for the next one.
    if (news !== undefined) {
      const isSent = (one: Assumption) =>
        (one.verdict === 'holds' && sent.holds.includes(one.text)) || (one.verdict === 'wrong' && sent.wrong.includes(one.text))
      await update($, assumptions, list => list.map(one => (isSent(one) ? { ...one, told: one.verdict } : one)))
      await update($, marks, list => list.map(one => (byMark[one.mark].includes(one.text) ? { ...one, isTold: true } : one)))
    }

    return entered
  })

  // Each block of a main-loop reply as it lands, so an assumption shows while Claude still works on it.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    const text = e.message.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
    if (e.agentId === undefined && /\b(?:ASSUMPTION|HOLDS|WRONG|UNSURE):/.test(text)) {
      const now = await read($, round)
      await update($, assumptions, all => absorb(all, text, now))
    }

    return stored
  })

  // An interrupted or failed turn leaves the last steps standing.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      const found = parseSteps(e.answer)
      await update($, steps, () => found)
      await update($, marks, list => list.filter(one => !one.isTold))
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await Promise.all([
        update($, steps, () => []),
        update($, marks, () => []),
        update($, assumptions, () => []),
        update($, round, () => 0),
      ])
    }

    return next(e)
  })

  on('command.run', { command: 'assumptions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Assumptions', focus: true })

    return {}
  })

  // The transcript draws a reply without what the band shows, on the surfaces that draw the band; the stored reply,
  // and ctrl+o, keep it all. A block left empty draws nothing.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary === true || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return next(e)
    }
    const text = hide(e.props.text)
    if (text === e.props.text.trimEnd()) {
      return next(e)
    }
    const { Box } = $.ui.resolve(e)

    return text === '' ? <Box /> : next({ ...e, props: { ...e.props, text } })
  })

  // Above the prompt, one number per row, pressed by a bare digit in the empty prompt: a step cycles through its
  // marks, an assumption steps through holds and wrong. Nothing here waits on an answer:
  // the steps follow Claude's latest reply, and an unanswered assumption only stays in view.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) {
      return next(e)
    }
    const [list, marked, all, now] = await Promise.all([read($, steps), read($, marks), read($, assumptions), read($, round)])
    const rows = e.props.isWorking ? [] : list
    // Rows keep their place while the person answers them: a settled one stays until the next prompt.
    // The oldest rows first, so one arriving later never moves a row's number; one digit stays for the check row.
    const inView = all.filter(one => isOpen(one) || one.settledIn === now)
    const open = all.filter(isOpen)
    const shown = inView.slice(0, Math.max(0, Math.min(SHOWN, 9 - rows.length - (open.length > 0 ? 1 : 0))))

    if (rows.length + shown.length === 0) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    // "1: " and a mark take five cells; the full text still goes to the prompt.
    const room = e.props.bodyColumns - 5
    const digit = (index: number) => (index < 9 ? String(index + 1) : undefined)
    const markOf = (text: string) => marked.find(one => one.text === text)?.mark ?? 'open'
    const STEP = {
      open: { glyph: '○', color: undefined, isDim: false },
      next: { glyph: '▶', color: 'suggestion', isDim: false },
      drop: { glyph: '✗', color: 'error', isDim: true },
      mine: { glyph: '✓', color: 'success', isDim: true },
      chat: { glyph: '?', color: 'warning', isDim: false },
    } as const
    const MARK = {
      open: { glyph: '?', color: 'warning' },
      holds: { glyph: '✓', color: 'success' },
      wrong: { glyph: '✗', color: 'error' },
    } as const

    return (
      <Box flexDirection="column">
        {await next(e)}
        {rows.length > 0 && (
          <Box flexDirection="column">
            <Box gap={2}>
              <Text bold>Next steps</Text>
              {rows.length > 1 && (
                <Button key="steps-all" plain hotkey="0" label="all ▶" onPress={() => allNext($, rows.map(step => step.text))} />
              )}
              <Text dimColor>press: ▶ you next · ✗ drop · ✓ I do it · ? talk first</Text>
            </Box>
            {rows.map((step, index) => {
              const mark = STEP[markOf(step.text)]
              return (
                <Button key={`step-${index + 1}`} plain hotkey={digit(index)} label={step.text} onPress={() => cycle($, step.text)}>
                  <Text color={mark.color}>{mark.glyph}</Text>{' '}
                  <Text dimColor={mark.isDim} strikethrough={mark === STEP.drop}>
                    {fit(step.text, room)}
                  </Text>
                </Button>
              )
            })}
          </Box>
        )}
        {shown.length > 0 && (
          <Box flexDirection="column" marginTop={rows.length > 0 ? 1 : 0}>
            <Box gap={2}>
              <Text bold>Assumptions</Text>
              <Text dimColor>
                {inView.length > shown.length
                  ? `press: holds, again: wrong · ${inView.length - shown.length} more in /assumptions`
                  : 'press: holds, again: wrong'}
              </Text>
            </Box>
            {shown.map((one, index) => {
              const mark = MARK[one.verdict ?? 'open']
              return (
                <Button
                  key={`assumption-${index + 1}`}
                  plain
                  hotkey={digit(rows.length + index)}
                  label={one.text}
                  onPress={() => press($, one.text)}
                >
                  <Text color={mark.color}>{mark.glyph}</Text>{' '}
                  <Text dimColor={!isOpen(one)} strikethrough={one.verdict === 'wrong'}>
                    {fit(one.text, room)}
                  </Text>
                </Button>
              )
            })}
            {open.length > 0 && (
              <Button
                key="verify"
                plain
                dimColor
                hotkey={digit(rows.length + shown.length)}
                label={open.length === 1 ? 'Ask Claude to check the open one' : `Ask Claude to check the ${open.length} open ones`}
                onPress={() => put($, VERIFY)}
              />
            )}
          </Box>
        )}
      </Box>
    )
  })

  // The session's ledger: open ones first, the first answering y / n while the pane has the keys; a settled one
  // pressed opens again.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, assumptions)
    const open = all.filter(isOpen)
    const settled = all.filter(one => !isOpen(one))
    const held = settled.filter(one => one.verdict === 'holds').length
    const keys = e.props.isFocused

    if (all.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>No assumptions yet.</Text>
          <Text dimColor wrap="wrap">
            Each line Claude marks ASSUMPTION: lands here and above the prompt, to confirm or correct.
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text bold>Assumptions</Text>
            <Text dimColor>
              {[
                open.length > 0 ? `${open.length} open` : 'all settled',
                held > 0 ? `${held} hold` : '',
                settled.length > held ? `${settled.length - held} wrong` : '',
              ]
                .filter(part => part !== '')
                .join(' · ')}
            </Text>
          </Box>
          {open.length > 0 && !keys && <Text dimColor>ctrl+x tab to answer</Text>}
        </Box>
        {open.length > 0 && (
          <Box marginTop={1}>
            <Button
              key="verify"
              plain
              dimColor={!keys}
              hotkey={keys ? 'v' : undefined}
              label={open.length === 1 ? 'Ask Claude to check the open one' : `Ask Claude to check the ${open.length} open ones`}
              onPress={() => put($, VERIFY)}
            />
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          {open.map((one, index) => {
            const isNext = index === 0

            // The rest show their buttons under the pointer.
            return (
              <Box key={`open-${one.text}`} gap={1}>
                <Text color={isNext ? 'suggestion' : 'warning'}>{isNext ? '❯' : '?'}</Text>
                <Box flexGrow={1} flexDirection="column">
                  <Text bold={isNext} color={isNext ? 'suggestion' : undefined} wrap="wrap">
                    {one.text}
                  </Text>
                  {one.note !== undefined && <Text dimColor wrap="truncate-end">{one.note}</Text>}
                </Box>
                <Box
                  gap={2}
                  marginLeft={2}
                  flexShrink={0}
                  {...(isNext ? {} : ({ display: 'none', hover: { display: 'flex' } } as const))}
                >
                  <Button
                    key={`holds-${one.text}`}
                    plain
                    dimColor={!keys}
                    hotkey={isNext && keys ? 'y' : undefined}
                    label="holds"
                    onPress={() => judge($, one.text, 'holds')}
                  />
                  <Button
                    key={`wrong-${one.text}`}
                    plain
                    dimColor={!keys}
                    hotkey={isNext && keys ? 'n' : undefined}
                    label="wrong"
                    onPress={() => judge($, one.text, 'wrong')}
                  />
                </Box>
              </Box>
            )
          })}
          {settled.map(one => (
            <Box key={`settled-${one.text}`} gap={1}>
              <Text color={one.verdict === 'holds' ? 'success' : 'error'}>{one.verdict === 'holds' ? '✓' : '✗'}</Text>
              <Box flexGrow={1} flexDirection="column">
                <Button key={`reopen-${one.text}`} plain dimColor label={one.text} onPress={() => judge($, one.text, undefined)}>
                  <Text strikethrough={one.verdict === 'wrong'}>{one.text}</Text>
                </Button>
                {one.note !== undefined && <Text dimColor wrap="truncate-end">{one.note}</Text>}
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
