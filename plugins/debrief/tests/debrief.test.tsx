import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { absorb } from '../hooks/register'
import { fit, FORMAT, named, newsContext, parseAssumptions, parseSteps, parseVerdicts, VERIFY } from '../hooks/parse'

const BAND = {
  plugin: 'debrief',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const
const PANE = {
  plugin: 'debrief',
  component: 'Pane',
  requestId: 'assumptions',
  props: {
    title: 'Assumptions',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const
const COMPOSER = { kind: 'composer' } as const

const ANSWER = 'Done.\n\n## Next steps\n- Run the **check** script\n2. Commit the change\n3. **You:** Restart Codex\n'

// The engine beneath the plugin: the prompt box as a draft (the person may type once, right after the first read), and
// a turn that completes with an answer.
function world(on: On, draft = '', typedAfterRead = '') {
  const box = { text: draft }
  let typing = typedAfterRead
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.read', () => {
    const value = { text: box.text, cursor: box.text.length }
    box.text += typing
    typing = ''
    return { value }
  })
  on('prompt.fill', (_, e) => {
    box.text = e.mode === 'append' ? box.text + e.text : e.text
    return { isFilled: true, text: box.text, cursor: box.text.length }
  })
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return { box, submitted }
}

const answer = (text: string, reason: 'answer' | 'aborted' = 'answer') =>
  ({ answer: text, durationMs: 1, isAborted: reason === 'aborted', turnId: 't', reason }) as const
const reply = (text: string, agentId?: string) => ({
  message: { type: 'assistant' as const, role: 'assistant' as const, content: [{ type: 'text' as const, text }] },
  door: 'response' as const,
  origin: { kind: 'model' as const, model: 'test' },
  uuid: crypto.randomUUID(),
  ...(agentId === undefined ? {} : { agentId }),
})

test('steps parse from every heading form, and You: marks the person\'s own', () => {
  expect(parseSteps(ANSWER)).toEqual([
    { text: 'Run the check script', isYours: false },
    { text: 'Commit the change', isYours: false },
    { text: 'Restart Codex', isYours: true },
  ])
  expect(parseSteps('Text\n\n**Next steps:** none')).toEqual([])
  expect(parseSteps('Text\n\n**Next steps**\nnone')).toEqual([])
  expect(parseSteps('Next steps: push the branch')).toEqual([{ text: 'push the branch', isYours: false }])
  expect(parseSteps('Next steps are unclear here.')).toEqual([])
  expect(parseSteps('No section at all')).toEqual([])
})

test('assumptions parse anywhere on a line, never from code or a quoted marker', () => {
  const text = [
    'Intro',
    'ASSUMPTION: the API is UTC',
    '- **ASSUMPTION:** port 8080 is free',
    'Prefix each one with `ASSUMPTION:` so it shows up.',
    '```',
    'ASSUMPTION: inside a fence',
    '```',
    'ASSUMPTION: the API is UTC',
  ].join('\n')
  expect(parseAssumptions(text)).toEqual(['the API is UTC', 'port 8080 is free'])
  // A longer fence holds a shorter one: only a fence of its own kind and length closes it.
  const nested = ['````md', '```', 'ASSUMPTION: an example', '```', 'HOLDS: an example', '````', 'ASSUMPTION: real'].join('\n')
  expect(parseAssumptions(nested)).toEqual(['real'])
  expect(parseVerdicts(nested)).toEqual([])
})

test('verdict lines name their assumption, loosely', () => {
  const verdicts = parseVerdicts(
    '- HOLDS: the API is UTC -- read config.ts\n**WRONG:** Port 8080 is free. \u2014 the dev server holds it\nUNSURE: the cache is warm',
  )
  expect(verdicts).toEqual([
    { kind: 'holds', claim: 'the API is UTC', note: 'read config.ts' },
    { kind: 'wrong', claim: 'Port 8080 is free.', note: 'the dev server holds it' },
    { kind: 'unsure', claim: 'the cache is warm', note: '' },
  ])
  const all = [{ text: 'port 8080 is free' }, { text: 'the API is UTC' }]
  expect(named(all, 'Port 8080 is free.')).toBe(all[0])
  expect(named(all, 'A2: `the API is UTC`')).toBe(all[1])
  expect(named(all, 'something else')).toBeUndefined()
  const close = [{ text: 'auth is enabled' }, { text: 'auth is enabled by default' }]
  expect(named(close, 'A2: auth is enabled by default')).toBe(close[1])
  // A claim that only looks alike names none, and underscores are part of a name.
  expect(named([{ text: 'The API uses v1' }], 'The API uses v10')).toBeUndefined()
  expect(named([{ text: 'The API uses v1' }], 'The API uses v1.1')).toBeUndefined()
  expect(named([{ text: 'it reads user_id' }], 'it reads userid')).toBeUndefined()
  expect(named([{ text: 'it reads id' }], 'it reads _id')).toBeUndefined()
  expect(absorb([], 'ASSUMPTION: uses user_id\nASSUMPTION: uses userid\nASSUMPTION: uses _id\nASSUMPTION: uses id', 1)).toHaveLength(4)
})

test('the ledger takes new assumptions into the round, and Claude\'s verdicts settle them', () => {
  const first = absorb([], 'ASSUMPTION: a\nASSUMPTION: b', 1)
  expect(first).toEqual([
    { text: 'a', round: 1 },
    { text: 'b', round: 1 },
  ])
  const settled = absorb(first, 'HOLDS: a -- checked\nWRONG: b -- it is c', 2)
  expect(settled).toEqual([
    { text: 'a', round: 1, verdict: 'holds', settledIn: 2, told: 'holds', note: 'checked' },
    { text: 'b', round: 1, verdict: 'wrong', settledIn: 2, told: 'wrong', note: 'it is c' },
  ])
  // Said again: a settled one keeps its verdict, an open one joins the new round.
  expect(absorb([...settled, { text: 'c', round: 1 }], 'ASSUMPTION: a\nASSUMPTION: c\nUNSURE: c -- no access', 3)).toEqual([
    ...settled,
    { text: 'c', round: 3, note: 'no access' },
  ])
})

test('what the person marked is said in one block, and nothing when nothing was marked', () => {
  expect(newsContext({ holds: ['a', 'b'], wrong: ['c'], did: ['Restart Codex'] })).toBe(
    'What the user marked in the debrief since your last reply:\n' +
      '- Confirmed these assumptions hold: "a"; "b"\n' +
      '- Marked these assumptions wrong (the prompt may say what is true): "c"\n' +
      '- Did these steps themselves: "Restart Codex"\n' +
      'These are facts the user checked: if you keep a memory, save any that will still matter in later sessions, a wrong one with what is true instead.',
  )
  expect(newsContext({ holds: [], wrong: [], did: [] })).toBeUndefined()
})

test('the band lists the steps: a digit fills the prompt with one of Claude\'s, or 0 with all', async ($, on) => {
  const { box } = world(on)
  await $.turn.complete(answer(ANSWER))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Button', key: 'step-2' })).toMatchObject({ props: { hotkey: '2', label: 'Commit the change' } })
    expect(await ui.find({ key: 'yours-1' })).toMatchObject({ props: { hotkey: '3' }, text: '○ Restart Codex' })
    await ui.press({ key: 'step-2' })
    expect(box.text).toBe('Commit the change')
    box.text = ''
    await ui.press({ key: 'steps-all' })
    expect(box.text).toBe('Run the check script\nCommit the change')
    box.text = ''
    await ui.unmount()
  }
})

test('two quick presses on steps put both in the prompt', async ($, on) => {
  const { box } = world(on)
  await $.turn.complete(answer(ANSWER))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await Promise.all([ui.press({ key: 'step-1' }), ui.press({ key: 'step-2' })])
  expect(box.text).toBe('Run the check script\nCommit the change')
})

test('a press never writes over what was typed meanwhile', async ($, on) => {
  const { box } = world(on, '', 'typed')
  await $.turn.complete(answer(ANSWER))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await ui.press({ key: 'step-1' })
  expect(box.text).toBe('typedRun the check script')
})

test('a press with a draft in the box keeps the draft', async ($, on) => {
  const { box } = world(on, 'also update the docs')
  await $.turn.complete(answer(ANSWER))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await ui.press({ key: 'step-1' })
  expect(box.text).toBe('also update the docs\nRun the check script')
})

test('a step of the person\'s ticks off, and their next prompt tells Claude once', async ($, on) => {
  const { box, submitted } = world(on)
  await $.turn.complete(answer(ANSWER))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await ui.press({ key: 'yours-1' })
  expect(box.text).toBe('')
  expect(await ui.find({ key: 'yours-1' })).toMatchObject({ text: '✓ Restart Codex' })
  await $.prompt.submit({ text: 'continue', wait: false, origin: COMPOSER })
  expect(submitted.at(-1)?.context).toEqual([
    'What the user marked in the debrief since your last reply:\n- Did these steps themselves: "Restart Codex"',
  ])
  await $.prompt.submit({ text: 'and more', wait: false, origin: COMPOSER })
  expect(submitted.at(-1)?.context).toEqual([])
})

test('an assumption steps through holds and wrong with one key, keeping its row and number', async ($, on) => {
  const { box, submitted } = world(on)
  await $.prompt.submit({ text: 'set it up', wait: false, origin: COMPOSER })
  await $.session.append(reply('Starting.\nASSUMPTION: the VPS runs the same version\nASSUMPTION: port 8080 is free'))

  const working = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
  expect(await working.find({ key: 'assumption-1' })).toMatchObject({ props: { hotkey: '1' }, text: '? the VPS runs the same version' })
  expect(await working.find({ key: 'verify' })).toMatchObject({ props: { hotkey: '3', label: 'Ask Claude to check the 2 open ones' } })
  await working.unmount()

  await $.turn.complete(answer(`Done.\n${ANSWER}`))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'assumption-1' })).toMatchObject({ props: { hotkey: '4' } })
  await ui.press({ key: 'assumption-1' })
  expect(await ui.find({ key: 'assumption-1' })).toMatchObject({ props: { hotkey: '4' }, text: '✓ the VPS runs the same version' })
  expect(box.text).toBe('')
  await ui.press({ key: 'assumption-2' })
  await ui.press({ key: 'assumption-2' })
  expect(await ui.find({ key: 'assumption-2' })).toMatchObject({ text: '✗ port 8080 is free' })
  expect(box.text).toBe('The assumption "port 8080 is free" is wrong: ')
  expect(await ui.find({ key: 'verify' })).toBeUndefined()

  await $.prompt.submit({ text: `${box.text}8080 is the dev server`, wait: false, origin: COMPOSER })
  expect(submitted.at(-1)?.context[0]).toBe(
    'What the user marked in the debrief since your last reply:\n' +
      '- Confirmed these assumptions hold: "the VPS runs the same version"\n' +
      '- Marked these assumptions wrong (the prompt may say what is true): "port 8080 is free"\n' +
      'These are facts the user checked: if you keep a memory, save any that will still matter in later sessions, a wrong one with what is true instead.',
  )
})

test('a subagent\'s assumptions and steps stay out of the band', async ($, on) => {
  world(on)
  await $.prompt.submit({ text: 'go', wait: false, origin: COMPOSER })
  await $.session.append(reply('ASSUMPTION: from a subagent', 'agent-1'))
  await $.turn.complete({ ...answer(ANSWER), agentId: 'agent-1' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
})

test('an open assumption stays in view until answered; an answered one leaves with the next prompt', async ($, on) => {
  world(on)
  await $.prompt.submit({ text: 'go', wait: false, origin: COMPOSER })
  await $.session.append(reply('ASSUMPTION: one\nASSUMPTION: two'))
  const first = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await first.press({ key: 'assumption-1' })
  await first.unmount()

  await $.prompt.submit({ text: 'next', wait: false, origin: COMPOSER })
  await $.session.append(reply('ASSUMPTION: three\nASSUMPTION: four\nASSUMPTION: five\nASSUMPTION: six'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Button' })).map(one => one.text)
  // Oldest first: a later one waits beyond the window rather than moving the numbers of those in it.
  expect(rows).toEqual(['? two', '? three', '? four', '? five', 'Ask Claude to check the 5 open ones'])
  expect(await ui.find({ text: /1 more in \/assumptions/ })).toBeDefined()
})

test('two quick presses on an assumption land on wrong', async ($, on) => {
  const { box } = world(on)
  await $.prompt.submit({ text: 'go', wait: false, origin: COMPOSER })
  await $.session.append(reply('ASSUMPTION: port 8080 is free'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await Promise.all([ui.press({ key: 'assumption-1' }), ui.press({ key: 'assumption-1' })])
  expect(await ui.find({ key: 'assumption-1' })).toMatchObject({ text: '✗ port 8080 is free' })
  expect(box.text).toBe('The assumption "port 8080 is free" is wrong: ')
})

test('a prompt typed while Claude works is a new round too, and a reopened verdict is news again', async ($, on) => {
  const { submitted } = world(on)
  await $.prompt.submit({ text: 'go', wait: false, origin: COMPOSER })
  await $.session.append(reply('ASSUMPTION: one'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
  await ui.press({ key: 'assumption-1' })
  await ui.unmount()

  await $.prompt.submit({ text: 'meanwhile', wait: false, origin: COMPOSER, turnId: 't' })
  expect(submitted.at(-1)?.context[0]).toContain('hold: "one"')
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await after.findAll({ type: 'Button' })).toHaveLength(0)
  await after.unmount()

  // Reopened in the pane and confirmed again: Claude hears it again.
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'reopen-one' })
  await pane.press({ key: 'holds-one' })
  await $.prompt.submit({ text: 'next', wait: false, origin: COMPOSER })
  expect(submitted.at(-1)?.context[0]).toContain('hold: "one"')
})

test('a step Claude asks for again after hearing it was done shows open again', async ($, on) => {
  const { submitted } = world(on)
  await $.turn.complete(answer(ANSWER))
  const first = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await first.press({ key: 'yours-1' })
  await first.unmount()
  await $.prompt.submit({ text: 'deployed', wait: false, origin: COMPOSER })
  expect(submitted.at(-1)?.context[0]).toContain('"Restart Codex"')

  await $.turn.complete(answer(ANSWER))
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await again.find({ key: 'yours-1' })).toMatchObject({ text: '○ Restart Codex' })
})

test('the verify line is found after a draft, and verdict lines in a code block are examples', async ($, on) => {
  const { box, submitted } = world(on, 'first fix the typo')
  await $.prompt.submit({ text: 'go', wait: false, origin: COMPOSER })
  await $.session.append(reply('ASSUMPTION: the API is UTC'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'verify' })
  expect(box.text).toBe(`first fix the typo\n${VERIFY}`)
  await $.prompt.submit({ text: box.text, wait: false, origin: COMPOSER })
  expect(submitted.at(-1)?.context.at(-1)).toContain('- the API is UTC')

  await $.session.append(reply('Answer like this:\n```\nHOLDS: the API is UTC -- how\n```'))
  expect(await ui.find({ key: 'assumption-1' })).toMatchObject({ text: '? the API is UTC' })
})

test('the verify prompt carries the open assumptions and Claude\'s verdicts settle them', async ($, on) => {
  const { box, submitted } = world(on)
  await $.prompt.submit({ text: 'go', wait: false, origin: COMPOSER })
  await $.session.append(reply('ASSUMPTION: the API is UTC\nASSUMPTION: port 8080 is free'))
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await band.press({ key: 'verify' })
  expect(box.text).toBe(VERIFY)

  await $.prompt.submit({ text: box.text, wait: false, origin: COMPOSER })
  expect(submitted.at(-1)?.context[0]).toContain('- the API is UTC\n- port 8080 is free')
  await $.prompt.submit({ text: 'unrelated', wait: false, origin: COMPOSER })
  expect(submitted.at(-1)?.context).toEqual([])

  await $.session.append(reply('HOLDS: the API is UTC -- read the config\nWRONG: port 8080 is free -- the dev server holds it'))
  expect(await band.find({ key: 'assumption-2' })).toMatchObject({ text: '✗ port 8080 is free' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ text: 'all settled · 1 hold · 1 wrong' })).toBeDefined()
  expect(await pane.find({ text: 'the dev server holds it' })).toBeDefined()
  // Claude said so itself: nothing to tell it.
  await $.prompt.submit({ text: 'ok', wait: false, origin: COMPOSER })
  expect(submitted.at(-1)?.context).toEqual([])
})

test('the pane answers y and n for the next open one, and a settled one opens again', async ($, on) => {
  const { box } = world(on)
  await $.prompt.submit({ text: 'go', wait: false, origin: COMPOSER })
  await $.session.append(reply('ASSUMPTION: first\nASSUMPTION: second'))

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ key: 'holds-first' })).toMatchObject({ props: { hotkey: 'y' } })
  expect((await pane.find({ key: 'holds-second' }))?.props.hotkey).toBeUndefined()
  await pane.press({ key: 'holds-first' })
  await pane.press({ key: 'wrong-second' })
  expect(box.text).toBe('The assumption "second" is wrong: ')
  expect(await pane.find({ text: 'all settled · 1 hold · 1 wrong' })).toBeDefined()

  await pane.press({ key: 'reopen-first' })
  expect(await pane.find({ key: 'holds-first' })).toMatchObject({ props: { hotkey: 'y' } })
})

test('the empty pane draws on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: 'No assumptions yet.' })).toBeDefined()
    await ui.unmount()
  }
})

test('an interrupted turn keeps the last steps; an answer without steps clears them', async ($, on) => {
  world(on)
  await $.turn.complete(answer(ANSWER))
  await $.turn.complete(answer('Stopped half way', 'aborted'))
  const kept = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await kept.find({ key: 'step-1' })).toBeDefined()
  await kept.unmount()

  await $.turn.complete(answer('Done.\n\nNext steps: none'))
  const cleared = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await cleared.find({ key: 'step-1' })).toBeUndefined()
})

test('a resumed session shows the steps its last reply left', async ($, on) => {
  world(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'do it', toolUses: [] },
      { role: 'assistant', text: ANSWER, toolUses: [] },
      { role: 'assistant', text: '', toolUses: [] },
    ],
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'step-2' })).toBeDefined()
})

test('the system prompt learns the forms the band reads', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  const facts = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null } as const

  const composed = await $.prompt.compose({ ...facts, traits: [] })
  expect(composed.sections.map(one => one.id)).toEqual(['intro', 'debrief:format'])
  expect(composed.sections[1]?.text).toBe(FORMAT)
  expect((await $.prompt.compose({ ...facts, traits: ['bare'] })).sections).toHaveLength(1)
})

test('fit counts terminal cells and never splits a character', () => {
  expect(fit('short', 10)).toBe('short')
  expect(fit('abcdefghij', 5)).toBe('abcd\u2026')
  expect(fit('\u65E5\u672C\u8A9E\u306E\u30C6\u30AD\u30B9\u30C8', 7)).toBe('\u65E5\u672C\u8A9E\u2026')
  expect(fit('ship it \u{1F680}\u{1F680}\u{1F680}', 10)).toBe('ship it \u2026')
  expect(fit('\u{1F469}\u200D\u{1F4BB} pair', 4)).toBe('\u{1F469}\u200D\u{1F4BB} \u2026')
  expect(fit('\u2705 Verify the change', 19)).toBe('\u2705 Verify the chan\u2026')
  expect(fit('\u{1F1E9}\u{1F1EA}\u{1F1E9}\u{1F1EA}\u{1F1E9}\u{1F1EA}', 5)).toBe('\u{1F1E9}\u{1F1EA}\u{1F1E9}\u{1F1EA}\u2026')
  expect(fit('\u2764\uFE0F\u2764\uFE0F\u2764\uFE0F', 5)).toBe('\u2764\uFE0F\u2764\uFE0F\u2026')
  expect(fit('anything', 0)).toBe('\u2026')
  expect(fit('anything', -2)).toBe('\u2026')
})

test('a /clear starts the debrief over', async ($, on) => {
  world(on)
  on('session.end', () => ({ sessionId: 's' }))
  await $.prompt.submit({ text: 'go', wait: false, origin: COMPOSER })
  await $.session.append(reply('ASSUMPTION: one'))
  await $.turn.complete(answer(ANSWER))
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
})
