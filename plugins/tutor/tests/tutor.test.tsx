import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Concept, Lesson } from '../types'
import { dots, ledger, toConcept } from '../hooks/register'
import { buildPrompt, FOLLOW_UPS, learn, merge, parseReply, recentConversation, sections, slug, titleOf, wrap } from '../hooks/teach'

const NOW = 1_800_000_000_000
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PANE = {
  plugin: 'tutor',
  component: 'Pane',
  requestId: 'tutor',
  props: { title: 'Tutor', isFocused: true, bodyColumns: 72, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const concept = (name: string, change: Partial<Concept> = {}): Concept => ({
  name,
  gist: `${name} in one line.`,
  domain: 'Machine learning',
  builtOn: [],
  state: 'learning',
  explained: 1,
  firstAt: NOW,
  lastAt: NOW,
  ...change,
})

const lesson = (question: string, change: Partial<Lesson> = {}): Lesson => ({
  id: question,
  question,
  status: 'done',
  answer: `About ${question}.`,
  takeaway: '',
  note: '',
  taught: [],
  builtOn: [],
  startedAt: NOW,
  isConfirmed: false,
  isQuiz: false,
  ...change,
})

const RECORD = '<knowledge>{"takeaway":"Reuse, do not recompute.","taught":[{"name":"KV cache","gist":"Keeps past keys and values.","domain":"Machine learning"}],"builtOn":["Attention"],"mastered":[],"shaky":[]}</knowledge>'

test('a reply splits into the answer and its knowledge record', () => {
  expect(parseReply(`A **KV cache** keeps them.\n\n${RECORD}`)).toEqual({
    answer: 'A **KV cache** keeps them.',
    learned: {
      isQuiz: false,
      takeaway: 'Reuse, do not recompute.',
      taught: [{ name: 'KV cache', gist: 'Keeps past keys and values.', domain: 'Machine learning' }],
      builtOn: ['Attention'],
      mastered: [],
      shaky: [],
    },
  })
  expect(parseReply('```json\n<knowledge>{"taught":[{"name":"X"}]}</knowledge>\n```').learned?.taught).toEqual([
    { name: 'X', gist: '', domain: 'General' },
  ])
  expect(parseReply('No record here.')).toEqual({ answer: 'No record here.', learned: undefined })
  expect(parseReply('Cut short <knowledge>{"taught":[').answer).toBe('Cut short')
  expect(parseReply('Bad <knowledge>{oops}</knowledge>').learned).toBeUndefined()
  expect(parseReply('<knowledge>{"taught":[{"gist":"no name"},7],"builtOn":["x",3]}</knowledge>').learned).toEqual({
    isQuiz: false,
    takeaway: '',
    taught: [],
    builtOn: ['x'],
    mastered: [],
    shaky: [],
  })
  // A record of the wrong shape counts as none, so the lesson can say nothing was recorded.
  expect(parseReply('A.<knowledge>{"taught":"Attention","mastered":null}</knowledge>').learned).toBeUndefined()
  expect(parseReply('A.<knowledge>{"quiz":"yes"}</knowledge>').learned).toBeUndefined()
  expect(parseReply('A.<knowledge>{"quiz":true}</knowledge>').learned?.isQuiz).toBe(true)
})

test('learning tracks what is new, what stuck and what was forgotten', () => {
  const known = [concept('Attention', { state: 'known' }), concept('Softmax', { state: 'known', explained: 2 })]
  const later = NOW + 1000
  const changed = learn(
    known,
    {
      isQuiz: false,
      takeaway: '',
      taught: [
        { name: 'KV cache', gist: 'Keeps past keys and values.', domain: 'Machine learning' },
        { name: 'softmax', gist: 'Turns scores into probabilities.', domain: 'Statistics' },
      ],
      builtOn: ['Attention', 'Not listed'],
      mastered: [],
      shaky: [],
    },
    { now: later, since: NOW, isQuizAnswer: false },
  )

  expect(changed.find(one => one.name === 'KV cache')).toEqual({
    name: 'KV cache',
    gist: 'Keeps past keys and values.',
    domain: 'Machine learning',
    builtOn: ['Attention', 'Not listed'],
    state: 'learning',
    explained: 1,
    firstAt: later,
    lastAt: later,
  })
  // Explained again: it had not stuck, so it is learning again; the name and field stay as first met.
  expect(changed.find(one => one.name === 'Softmax')).toMatchObject({ state: 'learning', explained: 3, domain: 'Machine learning', gist: 'Turns scores into probabilities.' })
  expect(changed.find(one => one.name === 'Attention')).toMatchObject({ state: 'known', lastAt: later })
  expect(changed).toHaveLength(3)

  const quiz = { isQuiz: false, takeaway: '', taught: [], builtOn: [], mastered: ['kv cache'], shaky: ['Attention'] }
  const quizzed = learn(changed, quiz, { now: later + 1, since: later, isQuizAnswer: true })
  expect(quizzed.map(one => [one.name, one.state])).toEqual([
    ['Attention', 'learning'],
    ['KV cache', 'known'],
  ])

  const merged = merge(known, changed)
  expect(merged.map(one => one.name)).toEqual(['Attention', 'Softmax', 'KV cache'])
})

test('the prompt carries the learner, their knowledge, the session and the thread', () => {
  const prompt = buildPrompt({
    nonce: 'n0nce',
    question: 'and prefill?',
    excerpt: 'prefill is compute-bound',
    background: 'An ML engineer.',
    knowledge: [concept('Attention', { state: 'known' }), concept('KV cache', { explained: 2 })],
    conversation: '[assistant] The KV cache grew.',
    lessons: [lesson('what is a KV cache?'), lesson('broken', { status: 'failed' })],
  })

  expect(prompt).toContain('<learner>An ML engineer.</learner>')
  expect(prompt).toContain('Machine learning: Attention')
  expect(prompt).toContain('- KV cache (Machine learning; explained 2x): KV cache in one line.')
  expect(prompt).toContain('[assistant] The KV cache grew.')
  expect(prompt).toContain('<question>what is a KV cache?</question>')
  expect(prompt).not.toContain('broken')
  expect(prompt).toContain('<excerpt-n0nce note="text the learner selected">\nprefill is compute-bound\n</excerpt-n0nce>')
  expect(prompt).toContain('<conversation-n0nce note=')
  expect(prompt.endsWith('<question>and prefill?</question>')).toBe(true)

  const bare = buildPrompt({ nonce: 'n0nce', question: '', excerpt: 'x', background: ' ', knowledge: [], conversation: '', lessons: [] })
  expect(bare).toContain('none yet')
  expect(bare).toContain('A well-educated adult')
  expect(bare).toContain('<question>Explain this excerpt.</question>')
})

test('the conversation is cut from its end to the budget', () => {
  const turns = [
    { role: 'user', text: 'first' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: 'x'.repeat(30) },
    { role: 'user', text: 'last' },
  ]
  expect(recentConversation(turns, 1000)).toBe(`[user] first\n\n[assistant] ${'x'.repeat(30)}\n\n[user] last`)
  expect(recentConversation(turns, 14)).toBe(`[assistant] [...] ${'x'.repeat(10)}\n\n[user] last`)
})

test('a follow-up is titled by the question it follows', () => {
  const asked = lesson('what is a KV cache?')
  const simpler = lesson(FOLLOW_UPS[0].prompt)
  expect(titleOf(asked, [])).toBe('what is a KV cache?')
  expect(titleOf(simpler, [asked])).toBe('Simpler: what is a KV cache?')
  expect(titleOf(lesson(FOLLOW_UPS[2].prompt), [asked, simpler])).toBe('Quiz me: what is a KV cache?')
  expect(titleOf(lesson(''), [])).toBe('Explain the selected text')
  expect(titleOf(lesson('the cache'), [lesson('test me', { isQuiz: true })])).toBe('Answer: the cache')
})

test('the dot meter shows one dot per concept, known first, scaled to its room and spaced in fives', () => {
  expect(dots(2, 1, 12)).toEqual(['● ●', ' ◐'])
  expect(dots(30, 10, 8)).toEqual(['● ● ● ● ●  ●', ' ◐ ◐'])
  expect(dots(0, 7, 10)).toEqual(['', '◐ ◐ ◐ ◐ ◐  ◐ ◐'])
  expect(dots(100, 1, 10)[1]).toBe('  ◐')
  expect(dots(0, 0, 10)).toEqual(['', ''])
})

type Reply = { isAnswered: true; text: string } | { isAnswered: false; reason: 'api-error'; status: number; error: 'overloaded' }

// The engine's answers beneath the plugin for one session; the model answers `reply`.
function world(on: On, reply: Reply | Reply[], stored: Concept[] | 'full' = [], selected?: string) {
  const replies = Array.isArray(reply) ? reply : [reply]
  if (stored === 'full') {
    on('store.keys', () => ({ value: [] }))
    on('store.set', () => ({ deny: 'the store is over 4 MiB' }))
  } else {
    mock.store(on, Object.fromEntries(stored.map(one => [`concept:${slug(one.name)}`, one])))
  }
  const clock = mock.clock(on, { now: NOW })
  const prompts: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.selection', () => ({ value: selected === undefined ? undefined : { text: selected } }))
  on('ui.panes', () => ({ value: [{ id: 'tutor', title: 'Tutor', isShown: true, isFocused: true, isPlaced: true }] }))
  on('ui.focus', () => ({}))
  on('ui.scroll', () => ({}))
  on('ui.log', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [{ role: 'assistant', text: 'The run died: the KV cache filled the GPU.', toolUses: [] }] }))
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)
    return { value: { ...(replies[prompts.length - 1] ?? replies.at(-1) ?? answered('')), usage: USAGE } }
  })
  return { prompts, clock }
}

const answered = (text: string): Reply => ({ isAnswered: true, text })
const start = { cwd: '/', surface: 'terminal', isInteractive: true } as const

test('a question asked in the pane becomes a lesson, and its concepts knowledge', async ($, on) => {
  const { prompts } = world(on, answered(`### KV cache\n\nA **KV cache** keeps past keys and values.\n${RECORD}`), [concept('Attention', { state: 'known' })])
  await $.session.start(start)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') {
      expect(await pane.find({ text: 'Ask about any term, concept or passage.' })).toBeDefined()
    }
    await pane.input({ key: 'ask', text: 'what is a KV cache?' })
    expect(await pane.find({ type: 'Markdown', text: 'A **KV cache** keeps past keys and values.' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'KV cache' })).toBeDefined()
    expect(await pane.find({ text: 'Reuse, do not recompute.' })).toBeDefined()
    expect(await pane.find({ text: 'Attention' })).toBeDefined()

    await pane.press({ key: 'got-it' })
    expect(await pane.find({ text: 'Got it ✓' })).toBeDefined()

    await pane.press({ key: 'tab-knowledge' })
    expect(await pane.find({ text: 'Keeps past keys and values.' })).toBeDefined()
    await pane.press({ key: 'open-concept:attention' })
    expect(await pane.find({ text: 'used by' })).toBeDefined()
    await pane.press({ key: 'open-concept:attention' })
    expect(await pane.find({ text: '2/2' })).toBeDefined()
    await pane.press({ key: 'tab-lesson' })
    await pane.unmount()
  }

  // The second question carried the first lesson, the session and what the learner knows.
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('the KV cache filled the GPU')
  expect(prompts[1]).toContain('Machine learning: Attention, KV cache')
  expect(prompts[1]).toContain('<question>what is a KV cache?</question>\n<answer>### KV cache')
})

test('/tutor asks right away and a follow-up button asks again', async ($, on) => {
  const { prompts, clock } = world(on, answered(`Shorter.\n${RECORD}`))
  await $.session.start(start)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.command.run({ command: 'tutor', args: 'KV cache', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })
  await clock.advance(1)
  await pane.press({ key: 'follow-s' })

  expect(prompts).toHaveLength(2)
  expect(prompts[0]).toContain('<question>KV cache</question>')
  expect(prompts[1]).toContain(`<question>${FOLLOW_UPS[0].prompt}</question>`)
  expect(await pane.find({ text: 'Simpler: KV cache' })).toBeDefined()
})

test('a failed answer says why and can be asked again', async ($, on) => {
  world(on, { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' })
  await $.session.start(start)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'ask', text: 'why?' })
  expect(await pane.find({ text: 'The API answered 529 (overloaded).' })).toBeDefined()
  const buttons = await pane.findAll({ type: 'Button' })
  expect(buttons.some(one => one.key?.startsWith('retry-'))).toBe(true)
})

test('the knowledge tab marks, refreshes and forgets a concept', async ($, on) => {
  const { prompts } = world(on, answered(`Again.\n${RECORD}`), [concept('Teacher forcing'), concept('McNemar test', { domain: 'Statistics', state: 'known' })])
  await $.session.start(start)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'tab-knowledge' })

  expect(await pane.find({ text: 'Statistics' })).toBeDefined()
  await pane.press({ key: 'open-concept:teacher-forcing' })
  await pane.press({ key: 'state-concept:teacher-forcing' })
  expect(await pane.find({ text: /^known, explained 1x/ })).toBeDefined()

  await pane.press({ key: 'forget-concept:teacher-forcing' })
  expect(await pane.find({ key: 'open-concept:teacher-forcing' })).toBeUndefined()

  await pane.press({ key: 'open-concept:mcnemar-test' })
  await pane.press({ key: 'refresh-concept:mcnemar-test' })
  expect(prompts[0]).toContain('<question>Refresh me on McNemar test.</question>')
})

test('answers are cut at their headings, never inside code', () => {
  expect(sections('Intro.\n\n### One\nBody one.\n```\n# not a heading\n```\n## Two ##\nBody two.')).toEqual([
    { heading: '', body: 'Intro.' },
    { heading: 'One', body: 'Body one.\n```\n# not a heading\n```' },
    { heading: 'Two', body: 'Body two.' },
  ])
  expect(sections('**Fixes:**\n- one\n**Mixed** text stays')).toEqual([{ heading: 'Fixes', body: '- one\n**Mixed** text stays' }])
  expect(sections('')).toEqual([])
})

test('the accent bar text wraps at word boundaries and cuts a word too long for a line', () => {
  expect(wrap('what does linearizability mean', 12)).toEqual(['what does', 'linearizabil', 'ity mean'])
  expect(wrap('  one  two ', 20)).toEqual(['one two'])
  expect(wrap('', 10)).toEqual([])
})

test('/tutor with text selected in the transcript explains that text', async ($, on) => {
  const passage = 'Audit metrics computed on pre-collected data are not sufficient.'
  const { prompts, clock } = world(on, answered(`They measure a fixed dataset.\n${RECORD}`), [], `  ${passage}\n`)
  await $.session.start(start)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.command.run({ command: 'tutor', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })
  await clock.advance(1)

  expect(prompts[0]).toMatch(new RegExp(`<excerpt-(\\w+) note="text the learner selected">\n${passage}\n</excerpt-\\1>`))
  expect(prompts[0]).toContain('<question>Explain this excerpt.</question>')
  expect(await pane.find({ text: 'Explain the selected text' })).toBeDefined()
  expect(await pane.find({ text: `"${passage}"` })).toBeDefined()
})

test('a concept an older version stored is kept, its missing fields filled', () => {
  expect(toConcept({ name: 'KV cache', gist: 'Keeps keys.', domain: 'ML', state: 'known', explained: 2, firstAt: 5, lastAt: 9 })).toEqual({
    name: 'KV cache',
    gist: 'Keeps keys.',
    domain: 'ML',
    builtOn: [],
    state: 'known',
    explained: 2,
    firstAt: 5,
    lastAt: 9,
  })
  expect(toConcept({ name: 'Bare', builtOn: ['A', 3], state: 'odd' })).toMatchObject({ builtOn: ['A'], state: 'learning', domain: 'General' })
  expect(toConcept({ gist: 'no name' })).toBeUndefined()
  expect(toConcept('KV cache')).toBeUndefined()
})

test('an answer still shows when the store refuses to save what it taught', async ($, on) => {
  world(on, answered(`Kept.\n${RECORD}`), 'full')
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start(start)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'ask', text: 'what is a KV cache?' })
  expect(await pane.find({ type: 'Markdown', text: 'Kept.' })).toBeDefined()
  expect(await pane.find({ text: /^Nothing was recorded: .*4 MiB/ })).toBeDefined()
  expect(toasts).toEqual([])
})

test('the header ledger draws one dot per concept, a group per field, scaled alike when short of room', () => {
  const fields = [
    { domain: 'Distributed systems', known: 3, total: 9 },
    { domain: 'Machine learning', known: 1, total: 3 },
    { domain: 'Statistics', known: 0, total: 1 },
  ]
  expect(ledger(fields, 40)).toEqual([
    ['●●●', '◐◐◐◐◐◐'],
    ['●', '◐◐'],
    ['', '◐'],
  ])
  expect(ledger(fields, 8)).toEqual([
    ['●', '◐◐◐'],
    ['', '◐'],
    ['', '◐'],
  ])
  expect(ledger([], 10)).toEqual([])
})

test('C, C++ and C# are three concepts; case and spacing do not make a new one', () => {
  expect(new Set(['C', 'C++', 'C#'].map(slug)).size).toBe(3)
  expect(slug('KV cache')).toBe(slug(' kv-Cache '))
})

test('a late answer leaves what the learner set meanwhile, and only a quiz answer shows mastery', () => {
  const marked = concept('Attention', { state: 'known', lastAt: NOW + 50 })
  const record = { isQuiz: false, takeaway: '', taught: [{ name: 'Attention', gist: 'Again.', domain: 'Machine learning' }], builtOn: [], mastered: [], shaky: [] }
  expect(learn([marked], record, { now: NOW + 99, since: NOW, isQuizAnswer: false })[0]).toMatchObject({ state: 'known', explained: 2, lastAt: NOW + 99 })

  const learning = concept('Softmax')
  const claim = { isQuiz: false, takeaway: '', taught: [], builtOn: [], mastered: ['Softmax'], shaky: [] }
  expect(learn([learning], claim, { now: NOW + 9, since: NOW + 1, isQuizAnswer: false })).toEqual([])
  expect(learn([learning], claim, { now: NOW + 9, since: NOW + 1, isQuizAnswer: true })[0]?.state).toBe('known')
})

test('a question asked while another is answered waits for it and sees its answer', async ($, on) => {
  const { prompts, clock } = world(on, answered(`First answer.\n${RECORD}`))
  await $.session.start(start)
  const run = (args: string) =>
    $.command.run({ command: 'tutor', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })

  await run('one')
  await run('two')
  await clock.advance(1)

  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('<question>one</question>\n<answer>First answer.</answer>')
})

test('an answer with no knowledge record says nothing was recorded', async ($, on) => {
  world(on, answered('Just text.'))
  await $.session.start(start)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'ask', text: 'why?' })
  expect(await pane.find({ type: 'Markdown', text: 'Just text.' })).toBeDefined()
  expect(await pane.find({ text: 'Nothing was recorded: the answer carried no knowledge record.' })).toBeDefined()
})

test('a bare /tutor returns to the lesson tab', async ($, on) => {
  world(on, answered(`A.\n${RECORD}`), [concept('Attention')])
  await $.session.start(start)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'tab-knowledge' })
  expect(await pane.find({ key: 'filter' })).toBeDefined()

  await $.command.run({ command: 'tutor', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 180 } })
  expect(await pane.find({ key: 'filter' })).toBeUndefined()
  expect(await pane.find({ key: 'ask' })).toBeDefined()
})

test('an answer to a quiz the tutor asked marks what it shows as known', async ($, on) => {
  const quiz = answered('Which cache does decoding reuse?\n<knowledge>{"quiz":true,"taught":[],"builtOn":["Attention"],"mastered":[],"shaky":[]}</knowledge>')
  const graded = answered('Right.\n<knowledge>{"quiz":false,"taught":[],"builtOn":[],"mastered":["Attention"],"shaky":[]}</knowledge>')
  world(on, [quiz, graded], [concept('Attention')])
  await $.session.start(start)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'ask', text: 'Quiz me.' })
  expect(await pane.find({ key: 'ask', type: 'Input' })).toMatchObject({ props: { placeholder: 'Type your answer' } })
  await pane.input({ key: 'ask', text: 'the KV cache' })

  expect(await pane.find({ text: 'Answer: the KV cache' })).toBeDefined()
  await pane.press({ key: 'tab-knowledge' })
  expect(await pane.find({ text: '1/1' })).toBeDefined()
})

test('marking a concept keeps every row in its place', async ($, on) => {
  const { clock } = world(on, answered(''), [concept('Older', { firstAt: NOW }), concept('Newer', { firstAt: NOW + 1, lastAt: NOW + 1 })])
  await $.session.start(start)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'tab-knowledge' })
  const order = async () => (await pane.findAll({ type: 'Button' })).map(one => one.key).filter(key => key?.startsWith('open-'))

  expect(await order()).toEqual(['open-concept:newer', 'open-concept:older'])
  await pane.press({ key: 'open-concept:older' })
  await clock.advance(10)
  await pane.press({ key: 'state-concept:older' })
  expect(await order()).toEqual(['open-concept:newer', 'open-concept:older'])
})
