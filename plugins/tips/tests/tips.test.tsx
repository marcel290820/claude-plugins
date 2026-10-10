import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { TipsSession } from '../types'
import { commandNames, commandText, digestLine, offer, promptTips, sheetFor, turnTips, weekly } from '../hooks/register'

const FRESH: TipsSession = { tip: null, shown: [], prompts: 0, lastAt: -3, edited: [], bash: [], asks: 0 }
const COMPOSER = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: false, columns: 100 } as const
const HINT = {
  plugin: 'tips',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const
const PANE = {
  plugin: 'tips',
  component: 'Pane',
  requestId: 'tips',
  props: {
    title: 'Tips',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// The kit has no store beneath the plugins; this one keeps values for the test.
function fakeStore(on: On) {
  const values = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: values.get(e.key) }))
  on('store.set', (_, e) => {
    values.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...values.keys()] }))
  return values
}

// The commands the session can run: every one the sheet names, unless a test says otherwise.
function commands(on: On, names = SHEET_NAMES) {
  on('command.list', () => ({ value: names.map(name => ({ name, description: '', source: 'builtin' as const })) }))
}
const SHEET_NAMES = sheetFor('').flatMap(([, rows]) => rows.flatMap(([usage]) => commandNames(usage)))

// The bottom of the hint line shows the tail a hook handed it.
function hintBottom(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.component === 'PromptHint' ? (e.props.tail ?? 'no tip') : ''}</Text>
  })
}

test('prompts map to the command that fits them', () => {
  const first = (text: string, isMidTurn = false) => promptTips(text, isMidTurn)[0]?.id

  expect(first('undo that last change')).toBe('rewind')
  expect(first('keep going until the tests pass')).toBe('goal')
  expect(first('check the deploy every 5 minutes')).toBe('loop')
  expect(first('send me a summary every morning')).toBe('schedule')
  expect(first('rename this prop across all packages')).toBe('batch')
  expect(first('research the best vector databases')).toBe('deep-research')
  expect(first('add oauth login to the app')).toBe('security-review')
  expect(first('make a slide deck from this')).toBe('slides')
  expect(first('the hooks are not firing in claude code')).toBe('doctor')
  expect(first('is that file still used?', true)).toBe('btw')
  expect(first('is that file still used?')).toBeUndefined()
  expect(first('what is a bloom filter?')).toBe('tutor')
  expect(first('explain teacher forcing')).toBe('tutor')
  expect(first('what is in src/app.ts?')).toBeUndefined()
  expect(first(`please implement the importer ${'with care '.repeat(40)}`)).toBe('plan')
  expect(first('fix the typo in the readme')).toBeUndefined()
})

test('turns map to the command that fits what happened', () => {
  const ids = (facts: Partial<Parameters<typeof turnTips>[0]>) =>
    turnTips({ isAborted: false, durationMs: 1000, session: FRESH, ...facts }).map(tip => tip.id)

  expect(ids({ context: 82 })).toEqual(['compact'])
  expect(ids({ context: 40, fiveHour: 91 })).toEqual(['usage'])
  expect(ids({ isAborted: true })).toEqual(['rewind'])
  expect(ids({ session: { ...FRESH, bash: ['gh pr create --fill'] } })).toEqual(['autofix-pr'])
  expect(ids({ session: { ...FRESH, edited: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] } })).toEqual(['code-review'])
  expect(ids({ session: { ...FRESH, edited: ['src/App.tsx'] } })).toEqual(['verify'])
  expect(ids({ session: { ...FRESH, asks: 6 } })).toEqual(['fewer-permission-prompts'])
  expect(ids({ durationMs: 11 * 60_000 })).toEqual(['background'])
  expect(ids({})).toEqual([])
})

test('a tip shows once, waits its gap, and retires once known', () => {
  const research = [{ id: 'deep-research', why: 'cited' }]
  const shown = offer({ ...FRESH, prompts: 1 }, research, {})
  expect(shown.tip?.id).toBe('deep-research')
  expect(offer({ ...shown, tip: null, prompts: 9 }, research, {}).tip).toBeNull()

  const soon = { ...shown, tip: null, prompts: 2 }
  expect(offer(soon, [{ id: 'plan', why: 'plan' }], {}).tip).toBeNull()
  expect(offer(soon, [{ id: 'compact', why: 'full', isUrgent: true }], {}).tip?.id).toBe('compact')
  expect(offer({ ...FRESH, prompts: 1 }, research, { 'deep-research': 2 }).tip).toBeNull()
})

test('command names include every alias of a cheat sheet row', () => {
  expect(commandNames('/code-review [level] [target] · /review')).toEqual(['code-review', 'review'])
  expect(commandNames('/autocompact [tokens|auto]')).toEqual(['autocompact'])
})

test('the weekly digest shows the week and three commands not tried yet', () => {
  const DAY = 24 * 60 * 60_000
  const first = weekly(0, undefined, { plan: 1 })
  expect(first?.week).toEqual([])
  expect(first?.picks.map(([usage]) => usage)).toEqual(['/goal <condition>', '/run', '/verify'])
  expect(weekly(6 * DAY, first, { plan: 1 })).toBeUndefined()

  const next = weekly(7 * DAY, first, { plan: 3, compact: 1, tips: 5 })
  expect(next?.week).toEqual([['plan', 2], ['compact', 1]])
  expect(next?.picks.map(([usage]) => usage)).toEqual([
    '/run-skill-generator',
    '/code-review [level] [target] · /review',
    '/security-review',
  ])
  expect(next === undefined ? '' : digestLine(next)).toBe(
    'Weekly tips · since the last digest you ran /plan ×2, /compact ×1 · try /run-skill-generator (record app verification recipe), ' +
      '/code-review (find bugs; --fix repairs), /security-review (find security vulnerabilities) · /tips for the full sheet',
  )
})

test('the digest offers untried commands again once all were offered', () => {
  let digest = weekly(0, undefined, {})
  const seen = new Set<string>()
  for (let week = 1; week <= 60 && digest !== undefined; week += 1) {
    digest.picks.forEach(([usage]) => seen.add(usage))
    expect(digest.picks).toHaveLength(3)
    expect(digestLine(digest)).not.toMatch(/tried every command/)
    digest = weekly(week * 7 * 24 * 60 * 60_000, digest, {})
  }
  expect(seen.size).toBeGreaterThan(90)
  expect(digestLine({ at: 0, used: {}, week: [], picks: [], offered: [] })).toMatch(/tried every command/)
})

test('a digest is logged at the first interactive start, then weekly', async ($, on) => {
  const store = fakeStore(on)
  const logged: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: 1000 }))
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(logged).toHaveLength(1)
  expect(logged[0]).toMatch(/^Weekly tips · try \/plan/)
  expect(store.get('digest')).toMatchObject({ at: 1000 })
})

test('a fitting prompt puts the tip under the prompt until the person takes it', async ($, on) => {
  const store = fakeStore(on)
  commands(on)
  hintBottom(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('command.run', () => ({}))
  on('session.id', () => ({ value: 's1' }))

  await $.prompt.submit({ text: 'research rust web frameworks', wait: false, origin: COMPOSER })
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await hint.find({ type: 'Text' }))?.text).toBe('✦ /deep-research · researches with cited sources')
  await hint.unmount()

  await $.command.run({ command: 'deep-research', args: 'rust', origin: COMPOSER, presentation: PRESENTATION })
  expect(store.get('used:s1')).toEqual({ 'deep-research': 1 })
  const cleared = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await cleared.find({ type: 'Text' }))?.text).toBe('no tip')
})

test('a full context window suggests /compact when the turn ends', async ($, on) => {
  fakeStore(on)
  commands(on)
  hintBottom(on)
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 160_000, window: 200_000, percent: 80 }, rateLimits: [] } }))

  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await hint.find({ type: 'Text' }))?.text).toBe('✦ /compact · context 80% full; summarize to free room')
})

test('two sessions counting at once both count', async ($, on) => {
  fakeStore(on)
  commands(on)
  hintBottom(on)
  on('command.run', () => ({}))
  let calls = 0
  on('session.id', () => ({ value: `s${(calls += 1)}` }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  const run = () => $.command.run({ command: 'deep-research', args: '', origin: COMPOSER, presentation: PRESENTATION })
  await Promise.all([run(), run()])
  await $.prompt.submit({ text: 'research rust web frameworks', wait: false, origin: COMPOSER })

  // Known after two runs, so the research prompt brings no tip.
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await hint.find({ type: 'Text' }))?.text).toBe('no tip')
})

test('two commands at once in one session both count', async ($, on) => {
  const store = fakeStore(on)
  on('command.run', () => ({}))
  on('session.id', () => ({ value: 's1' }))

  const run = () => $.command.run({ command: 'btw', args: '', origin: COMPOSER, presentation: PRESENTATION })
  await Promise.all([run(), run()])
  expect(store.get('used:s1')).toEqual({ btw: 2 })
})

test('two starts at once log one digest', async ($, on) => {
  fakeStore(on)
  const logged: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: 1000 }))
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined }
  })

  const start = () => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await Promise.all([start(), start()])
  expect(logged).toHaveLength(1)
})

test('/tips opens the cheat sheet, filtered by its argument', async ($, on) => {
  fakeStore(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.command.run({ command: 'tips', args: '', origin: COMPOSER, presentation: PRESENTATION })
    const all = await $.ui.mount({ ...PANE, surface })
    expect(await all.find({ text: '/plan [task]' })).toBeDefined()
    expect(await all.find({ text: 'Account and extras' })).toBeDefined()
    await all.unmount()

    await $.command.run({ command: 'tips', args: 'review', origin: COMPOSER, presentation: PRESENTATION })
    const some = await $.ui.mount({ ...PANE, surface })
    expect(await some.find({ text: '/security-review' })).toBeDefined()
    expect(await some.find({ text: '/plan [task]' })).toBeUndefined()
    await some.unmount()
  }
})

test('a tip never names a command this session cannot run', async ($, on) => {
  fakeStore(on)
  commands(on, ['compact'])
  hintBottom(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.prompt.submit({ text: 'research rust web frameworks', wait: false, origin: COMPOSER })
  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect((await hint.find({ type: 'Text' }))?.text).toBe('no tip')
})

test('taking a row puts its command in the prompt, ready for its arguments', () => {
  expect(commandText('/plan [task]', '')).toBe('/plan ')
  expect(commandText('/diff', '')).toBe('/diff')
  expect(commandText('/rewind · /checkpoint · /undo', '')).toBe('/rewind')
  expect(commandText('/compact [instructions]', 'keep the plan')).toBe('/compact keep the plan')
  expect(commandText('/code-review ultra · /ultrareview', '')).toBe('/code-review ultra')
  expect(commandText('/doctor prompt-audit [path]', '')).toBe('/doctor prompt-audit ')
  expect(commandText('/effort ultracode [on|off]', '')).toBe('/effort ultracode ')
})

test('the sheet filters as you type, Enter takes the first match, and a row press takes that one', async ($, on) => {
  fakeStore(on)
  const box = { text: '' }
  const closed: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    box.text = e.text
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })

  await $.command.run({ command: 'tips', args: '', origin: COMPOSER, presentation: PRESENTATION })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'filter', text: 'compa', kind: 'change' })
  expect(await ui.find({ key: '/plan [task]' })).toBeUndefined()
  await ui.input({ key: 'filter', text: 'compa' })
  expect(box.text).toBe('/compact ')
  expect(closed).toEqual(['tips'])

  box.text = ''
  await ui.input({ key: 'filter', text: '', kind: 'change' })
  await ui.press({ key: '/diff' })
  expect(box.text).toBe('/diff')
})

test('the sheet stays open and says so when no prompt box takes the command', async ($, on) => {
  fakeStore(on)
  const closed: string[] = []
  const toasts: string[] = []
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', () => ({ isFilled: false, text: '', cursor: 0 }))

  await $.command.run({ command: 'tips', args: '', origin: COMPOSER, presentation: PRESENTATION })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: '/diff' })
  expect(closed).toEqual([])
  expect(toasts).toEqual(['No prompt box took /diff: type it yourself.'])
})
