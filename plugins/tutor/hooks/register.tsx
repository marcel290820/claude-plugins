import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, ModelCompleteResult, Register, RenderElement, Timer } from 'claude-code'

import type { Concept, Lesson } from '../types'
import { buildPrompt, FOLLOW_UPS, learn, merge, parseReply, recentConversation, RULES, sections, slug, titleOf, wrap } from './teach'

const PANE = 'tutor'
const lessons = atom({ plugin: 'tutor', key: 'lessons' } as const, [] as Lesson[])
const knowledge = atom({ plugin: 'tutor', key: 'knowledge' } as const, [] as Concept[])
const view = atom({ plugin: 'tutor', key: 'view' } as const, 'lesson' as 'lesson' | 'knowledge')
const expanded = atom({ plugin: 'tutor', key: 'expanded' } as const, [] as string[])
const filter = atom({ plugin: 'tutor', key: 'filter' } as const, '')
const tick = atom({ plugin: 'tutor', key: 'tick' } as const, 0)

// One store key per concept: sessions saving at once never drop each other's concepts.
const PREFIX = 'concept:'
const keyOf = (name: string) => `${PREFIX}${slug(name)}`
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

// The store is JSON this mod wrote, maybe an older version of it: every concept with a name is kept, and
// what an older version did not write is filled in, so a save never drops one.
export function toConcept(value: unknown): Concept | undefined {
  if (typeof value !== 'object' || value === null || !('name' in value) || typeof value.name !== 'string') {
    return undefined
  }
  const one: Record<string, unknown> = { ...value }
  const text = (field: unknown, fallback: string) => (typeof field === 'string' ? field : fallback)
  const time = (field: unknown, fallback: number) => (typeof field === 'number' && Number.isFinite(field) ? field : fallback)

  return {
    name: value.name,
    gist: text(one.gist, ''),
    domain: text(one.domain, 'General'),
    builtOn: Array.isArray(one.builtOn) ? one.builtOn.filter((base): base is string => typeof base === 'string') : [],
    state: one.state === 'known' ? 'known' : 'learning',
    explained: time(one.explained, 1),
    firstAt: time(one.firstAt, 0),
    lastAt: time(one.lastAt, time(one.firstAt, 0)),
  }
}

// ponytail: one store call per concept on each load; keep an index key if thousands of concepts make it slow.
async function stored($: EngineInterface): Promise<Concept[]> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(PREFIX))
  const values = await Promise.all(keys.map(key => $.store.get(key)))

  return values.map(toConcept).filter(one => one !== undefined).sort((a, b) => a.firstAt - b.firstAt)
}

// Every change to the knowledge reads, decides and writes as one step, one change at a time, so a late answer
// cannot write over a mark the learner made meanwhile. It writes only the concepts the change touched.
// ponytail: one queue per session; another session changing the same concept in the same instant can still win.
let queue: Promise<unknown> = Promise.resolve()
function change($: EngineInterface, decide: (latest: Concept[]) => { changed?: Concept[]; removed?: string[] }): Promise<void> {
  const run = queue.then(async () => {
    const { changed = [], removed = [] } = decide(await stored($))
    await Promise.all([
      ...changed.map(one => $.store.set(keyOf(one.name), one)),
      ...removed.map(name => $.store.delete(keyOf(name))),
    ])
    await update($, knowledge, list => merge(list.filter(one => !removed.some(name => slug(name) === slug(one.name))), changed))
  })
  queue = run.catch(() => undefined)
  return run
}

const calls = new Map<string, AbortController>()
let spinner: Timer | undefined

// Turns the spinner while any lesson thinks, and stops once none does.
function spin($: EngineInterface) {
  spinner ??= $.clock.every(120, () => {
    read($, lessons)
      .then(all => {
        if (all.some(one => one.status === 'thinking')) {
          return update($, tick, frame => frame + 1)
        }
        spinner?.cancel()
        spinner = undefined
      })
      .catch((error: unknown) => $.ui.log(`tutor: spinner: ${String(error)}`, { to: 'debug' }))
  })
}

function failure(reply: Exclude<ModelCompleteResult, { isAnswered: true }>): string {
  switch (reply.reason) {
    case 'api-error':
      return `The API answered ${reply.status ?? 'nothing'} (${reply.error}).`
    case 'empty-reply':
      return 'The model replied without text.'
    case 'aborted':
      return 'Cancelled.'
  }
}

type Options = { model: string; background: string }

// Brings the pane back to its top, where the field and the newest lesson are. A courtesy: a surface that
// cannot says so in the debug log.
function reveal($: EngineInterface) {
  $.ui.scroll({ in: PANE, to: 'start' }).catch((error: unknown) => $.ui.log(`tutor: ${String(error)}`, { to: 'debug' }))
}

// Asks run one after another, so a follow-up sees the answer it follows.
let line: Promise<unknown> = Promise.resolve()

// Started, never awaited, by the handlers that call it: an answer takes longer than a handler may run. It never
// rejects: whatever fails ends the lesson failed, saying why.
async function ask($: EngineInterface, options: Options, question: string, excerpt?: string) {
  const id = crypto.randomUUID()
  const stop = new AbortController()
  calls.set(id, stop)
  try {
    const lesson: Lesson = {
      id,
      question,
      ...(excerpt === undefined ? {} : { excerpt }),
      status: 'thinking',
      answer: '',
      takeaway: '',
      note: '',
      taught: [],
      builtOn: [],
      startedAt: await $.clock.now(),
      isConfirmed: false,
      isQuiz: false,
    }
    await update($, lessons, all => [...all, lesson])
    await update($, view, () => 'lesson')
    spin($)
    reveal($)
    const turn = line.then(() => respond($, options, lesson, stop.signal))
    line = turn.catch(() => undefined)
    await turn
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await settle($, id, { status: 'failed', answer: reason }).catch(() => $.ui.toast(`Tutor failed: ${reason}`))
  } finally {
    calls.delete(id)
  }
}

function settle($: EngineInterface, id: string, change: Partial<Lesson>) {
  return update($, lessons, all => all.map(one => (one.id === id ? { ...one, ...change } : one)))
}

// One lesson's turn: the model call, then what its answer taught.
async function respond($: EngineInterface, options: Options, lesson: Lesson, signal: AbortSignal) {
  const all = await read($, lessons)
  const earlier = all.slice(0, all.findIndex(one => one.id === lesson.id))
  const [known, messages] = await Promise.all([stored($), $.session.messages()])
  const reply = await $.model.complete(
    {
      model: options.model,
      system: [{ text: RULES, cache: true }],
      prompt: buildPrompt({
        nonce: crypto.randomUUID().slice(0, 8),
        question: lesson.question,
        ...(lesson.excerpt === undefined ? {} : { excerpt: lesson.excerpt }),
        background: options.background,
        knowledge: known,
        conversation: recentConversation(messages),
        lessons: earlier,
      }),
      maxTokens: 8000,
      effort: 'medium',
      timeoutMs: 5 * 60_000,
    },
    { signal },
  )
  if (!reply.isAnswered) {
    await settle($, lesson.id, { status: 'failed', answer: failure(reply) })
    return
  }

  const { answer, learned } = parseReply(reply.text)
  let note = learned === undefined ? 'Nothing was recorded: the answer carried no knowledge record.' : ''
  if (learned !== undefined) {
    const moment = { now: await $.clock.now(), since: lesson.startedAt, isQuizAnswer: earlier.at(-1)?.isQuiz === true }
    // The answer still shows when the store refuses the save (it holds 4 MiB); the note says what was lost.
    await change($, latest => ({ changed: learn(latest, learned, moment) })).catch((error: unknown) => {
      note = `Nothing was recorded: ${error instanceof Error ? error.message : String(error)}`
    })
  }
  await settle($, lesson.id, {
    status: 'done',
    answer,
    takeaway: learned?.takeaway ?? '',
    isQuiz: learned?.isQuiz ?? false,
    note,
    taught: learned?.taught.map(one => one.name) ?? [],
    builtOn: learned?.builtOn ?? [],
  })
  reveal($)

  const isShown = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  if (!isShown) {
    $.ui.toast(`Tutor answered: ${titleOf(lesson, earlier)}`)
  }
}

async function confirm($: EngineInterface, lesson: Lesson) {
  const ids = new Set(lesson.taught.map(slug))
  const at = await $.clock.now()
  await change($, latest => ({
    changed: latest.filter(one => ids.has(slug(one.name))).map(one => ({ ...one, state: 'known', lastAt: at })),
  }))
  await update($, lessons, list => list.map(one => (one.id === lesson.id ? { ...one, isConfirmed: true } : one)))
}

async function setState($: EngineInterface, name: string, state: Concept['state']) {
  const at = await $.clock.now()
  await change($, latest => ({ changed: latest.filter(one => slug(one.name) === slug(name)).map(one => ({ ...one, state, lastAt: at })) }))
}

// Older lessons open and close freely; concepts open one at a time, so their hotkeys stay unique.
function toggle($: EngineInterface, id: string) {
  return update($, expanded, ids => {
    if (ids.includes(id)) {
      return ids.filter(one => one !== id)
    }
    return id.startsWith('concept:') ? [...ids.filter(one => !one.startsWith('concept:')), id] : [...ids, id]
  })
}

// Compact age: now, 5m, 3h, 2d.
function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)

  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const cut = (text: string, width: number) => (text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text)

// One dot per concept, known first, scaled down to `room` dots and spaced in fives so they can be counted.
export function dots(known: number, learning: number, room: number): [string, string] {
  const total = known + learning
  const scale = total > room ? room / total : 1
  const solid = Math.round(known * scale)
  const half = Math.max(learning > 0 ? 1 : 0, Math.round(total * scale) - solid)
  const run = (from: number, count: number, glyph: string) =>
    Array.from({ length: count }, (_, index) => {
      const at = from + index
      return `${at === 0 ? '' : at % 5 === 0 ? '  ' : ' '}${glyph}`
    }).join('')

  return [run(0, solid, '●'), run(solid, half, '◐')]
}

// The one vocabulary for a concept's state, wherever it is drawn.
// Both green, told apart by the fill: still learning is no warning.
const MARK = {
  known: { glyph: '●', color: 'success', dimColor: false },
  learning: { glyph: '◐', color: 'success', dimColor: true },
} as const

type Field = { domain: string; known: number; total: number }

// Concepts counted per field, the biggest first.
function byField(concepts: readonly Concept[]): Field[] {
  return [...new Set(concepts.map(one => one.domain))]
    .map(domain => {
      const mine = concepts.filter(one => one.domain === domain)
      return { domain, known: mine.filter(one => one.state === 'known').length, total: mine.length }
    })
    .sort((a, b) => b.total - a.total)
}

// The header's miniature of the field rows: one dot per concept, a field per group, each group scaled
// down alike (to one dot at least) when they would not fit in `room` cells.
export function ledger(fields: readonly Field[], room: number): [string, string][] {
  const total = fields.reduce((sum, one) => sum + one.total, 0)
  const scale = Math.min(1, Math.max(0, room - fields.length + 1) / Math.max(1, total))

  return fields.map(({ known, total: count }) => {
    const shown = Math.max(1, Math.round(count * scale))
    const solid = Math.round((known / count) * shown)
    return ['●'.repeat(solid), '◐'.repeat(shown - solid)]
  })
}

type Kit = Pick<Elements['terminal'], 'Box' | 'Button' | 'Markdown' | 'Text'> & Partial<Pick<Elements['terminal'], 'Input'>>

type Snapshot = {
  all: Lesson[]
  concepts: Concept[]
  current: 'lesson' | 'knowledge'
  opened: string[]
  query: string
  frame: number
  now: number
  // Cells inside the pane's gutters.
  width: number
  isFocused: boolean
}

// Every Button keeps its place from draw to draw: the host keeps the focus ring by position, so one that
// came and went above the ring would move it.
function header($: EngineInterface, { Box, Button, Text }: Kit, s: Snapshot): RenderElement {
  const tabs = [
    { id: 'lesson', label: 'Lesson' },
    { id: 'knowledge', label: s.concepts.length === 0 ? 'Knowledge' : `Knowledge ${s.concepts.length}` },
  ] as const
  const used = tabs.reduce((width, tab) => width + tab.label.length + 3, -3)
  const groups = ledger(byField(s.concepts), s.width - used - 2)

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box gap={3}>
          {tabs.map(tab => (
            <Button
              key={`tab-${tab.id}`}
              plain
              dimColor={tab.id !== s.current}
              label={tab.label}
              onPress={() => update($, view, () => tab.id)}
            />
          ))}
        </Box>
        <Box gap={1}>
          {groups.map(([solid, half], index) => (
            <Box key={`group-${index}`}>
              <Text color={MARK.known.color}>{solid}</Text>
              <Text color={MARK.learning.color} dimColor>{half}</Text>
            </Box>
          ))}
        </Box>
      </Box>
      <Box>
        {tabs.map((tab, index) => (
          <Text key={`rule-${tab.id}`} color={tab.id === s.current ? 'claude' : undefined} dimColor={tab.id !== s.current}>
            {(tab.id === s.current ? '━' : '─').repeat(tab.label.length) + (index < tabs.length - 1 ? '───' : '')}
          </Text>
        ))}
        <Text dimColor>{'─'.repeat(Math.max(0, s.width - used))}</Text>
      </Box>
    </Box>
  )
}

// Text behind the accent bar, the bar drawn on every line it wraps to.
function barred({ Box, Text }: Kit, text: string, width: number, style: { bold?: true }): RenderElement {
  return (
    <Box flexDirection="column">
      {wrap(text, width - 2).map((line, index) => (
        <Box key={`line-${index}`} gap={1}>
          <Text color="claude">▍</Text>
          <Text {...style}>{line}</Text>
        </Box>
      ))}
    </Box>
  )
}

// Concept names behind their state's mark; a name the knowledge base does not hold is drawn plain.
function named({ Box, Text }: Kit, s: Snapshot, names: readonly string[], key: string): RenderElement {
  return (
    <Box columnGap={3} flexWrap="wrap">
      {names.map(name => {
        const state = s.concepts.find(one => slug(one.name) === slug(name))?.state
        return (
          <Box key={`${key}-${name}`} gap={1}>
            {state !== undefined && <Text color={MARK[state].color} dimColor={MARK[state].dimColor}>{MARK[state].glyph}</Text>}
            <Text>{name}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

// A label beside a run of concept names, the names wrapping under each other; labels share one width.
function labelled(kit: Kit, s: Snapshot, label: 'builds on' | 'taught' | 'used by', names: readonly string[], key: string): RenderElement {
  const { Box, Text } = kit
  return (
    <Box gap={1}>
      <Box width={9} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      {named(kit, s, names, key)}
    </Box>
  )
}

// The field, the rule under it and the keys: drawn first and always, so the ring never moves under them.
function toolbar($: EngineInterface, options: Options, kit: Kit, s: Snapshot): RenderElement {
  const { Box, Button, Input, Text } = kit
  const latest = s.all.at(-1)
  const isDone = latest?.status === 'done'
  const canConfirm = isDone && latest.taught.length > 0 && !latest.isConfirmed
  const placeholder =
    latest === undefined ? 'What do you want to understand?' : latest.isQuiz && isDone ? 'Type your answer' : 'Follow-up question'

  return (
    <Box flexDirection="column" marginTop={1}>
      {Input === undefined ? (
        <Text dimColor>/tutor {'<question>'} asks from the prompt</Text>
      ) : (
        <Box gap={1}>
          <Text color="claude">❯</Text>
          <Input
            key="ask"
            placeholder={placeholder}
            submitLabel="ask"
            autoFocus
            onSubmit={text => {
              if (text.trim() !== '') {
                void ask($, options, text.trim())
              }
            }}
          />
        </Box>
      )}
      {!s.isFocused && <Text dimColor>ctrl+x tab to type here</Text>}
      {latest !== undefined && (
        <Box flexDirection="column">
          <Text dimColor>{'─'.repeat(s.width)}</Text>
          <Box columnGap={3} flexWrap="wrap">
            <Button
              key="got-it"
              plain
              dimColor={!canConfirm}
              hotkey="g"
              label={latest.isConfirmed ? 'Got it ✓' : 'Got it'}
              onPress={() => (canConfirm ? confirm($, latest) : undefined)}
            />
            {FOLLOW_UPS.map(one => (
              <Button
                key={`follow-${one.hotkey}`}
                plain
                dimColor={!isDone}
                hotkey={one.hotkey}
                label={one.label}
                onPress={() => {
                  if (isDone) {
                    void ask($, options, one.prompt)
                  }
                }}
              />
            ))}
          </Box>
        </Box>
      )}
    </Box>
  )
}

// The question, when it was asked, the passage it is about and what it builds on.
function heading(kit: Kit, s: Snapshot, lesson: Lesson, title: string): RenderElement {
  const { Box, Text } = kit
  return (
    <Box flexDirection="column">
      {barred(kit, title, s.width, { bold: true })}
      <Box flexDirection="column" marginLeft={2}>
        {lesson.status !== 'thinking' && (
          <Text dimColor>asked {age(s.now - lesson.startedAt) === 'now' ? 'just now' : `${age(s.now - lesson.startedAt)} ago`}</Text>
        )}
        {lesson.excerpt !== undefined && (
          <Text dimColor italic wrap="wrap">
            "{cut(lesson.excerpt.replace(/\s+/g, ' '), 2 * s.width - 6)}"
          </Text>
        )}
        {lesson.builtOn.length > 0 && labelled(kit, s, 'builds on', lesson.builtOn, `built-${lesson.id}`)}
      </Box>
    </Box>
  )
}

// The answer with its headings drawn apart, then the one line to keep and the concepts it taught.
function answer(kit: Kit, s: Snapshot, lesson: Lesson): RenderElement {
  const { Box, Markdown, Text } = kit
  return (
    <Box flexDirection="column">
      {sections(lesson.answer).map((part, index) => (
        <Box key={`part-${lesson.id}-${index}`} flexDirection="column" marginTop={1}>
          {part.heading !== '' && <Text bold color="claude">{part.heading}</Text>}
          {part.body !== '' && <Markdown text={part.body} />}
        </Box>
      ))}
      {lesson.takeaway !== '' && <Box marginTop={1}>{barred(kit, lesson.takeaway, s.width, {})}</Box>}
      {lesson.taught.length > 0 && <Box marginTop={1}>{labelled(kit, s, 'taught', lesson.taught, `taught-${lesson.id}`)}</Box>}
      {lesson.note !== '' && (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">{lesson.note}</Text>
        </Box>
      )}
    </Box>
  )
}

function body($: EngineInterface, options: Options, kit: Kit, s: Snapshot, lesson: Lesson, isLatest: boolean): RenderElement {
  const { Box, Button, Text } = kit
  if (lesson.status === 'thinking') {
    return (
      <Box gap={1} marginTop={1}>
        <Text color="claude">{FRAMES[s.frame % FRAMES.length]}</Text>
        <Text dimColor>Thinking {Math.floor((s.now - lesson.startedAt) / 1000)}s</Text>
        <Box marginLeft={2}>
          <Button key={`cancel-${lesson.id}`} plain dimColor hotkey="c" label="cancel" onPress={() => calls.get(lesson.id)?.abort()} />
        </Box>
      </Box>
    )
  }
  if (lesson.status === 'failed') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box gap={1}>
          <Text color="error">✗</Text>
          <Text wrap="wrap">{lesson.answer}</Text>
        </Box>
        {isLatest && (
          <Box marginTop={1}>
            <Button
              key={`retry-${lesson.id}`}
              plain
              hotkey="r"
              label="Ask again"
              onPress={async () => {
                await update($, lessons, list => list.filter(one => one.id !== lesson.id))
                void ask($, options, lesson.question, lesson.excerpt)
              }}
            />
          </Box>
        )}
      </Box>
    )
  }

  return answer(kit, s, lesson)
}

// Newest first: the field and keys, the lesson asked last, then the earlier ones folded.
function lessonView($: EngineInterface, options: Options, kit: Kit, s: Snapshot): RenderElement {
  const { Box, Button, Text } = kit
  const latest = s.all.at(-1)
  const title = (lesson: Lesson) => titleOf(lesson, s.all.slice(0, s.all.indexOf(lesson)))

  if (latest === undefined) {
    return (
      <Box flexDirection="column">
        {toolbar($, options, kit, s)}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Ask about any term, concept or passage.</Text>
          <Text dimColor wrap="wrap">It starts from what you already know and remembers what you learn.</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor wrap="wrap">/tutor {'<question>'} asks from the prompt</Text>
            <Text dimColor wrap="wrap">select text in the transcript, then /tutor explains it</Text>
          </Box>
        </Box>
      </Box>
    )
  }

  const earlier = s.all.slice(0, -1).reverse()

  return (
    <Box flexDirection="column">
      {toolbar($, options, kit, s)}
      <Box flexDirection="column" marginTop={1}>
        {heading(kit, s, latest, title(latest))}
        {body($, options, kit, s, latest, true)}
      </Box>
      {earlier.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{'─'.repeat(s.width)}</Text>
          {earlier.map(lesson => {
            const isOpen = s.opened.includes(lesson.id)
            return (
              <Box key={`lesson-${lesson.id}`} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
                <Box gap={1}>
                  <Button key={`toggle-${lesson.id}`} plain dimColor label={isOpen ? '▾' : '▸'} onPress={() => toggle($, lesson.id)} />
                  <Box flexGrow={1}>
                    <Text dimColor={!isOpen} bold={isOpen} wrap="truncate-end">
                      {title(lesson)}
                    </Text>
                  </Box>
                  <Text dimColor>{lesson.status === 'thinking' ? FRAMES[s.frame % FRAMES.length] : age(s.now - lesson.startedAt)}</Text>
                </Box>
                {isOpen && <Box marginLeft={2}>{body($, options, kit, s, lesson, false)}</Box>}
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

function knowledgeView($: EngineInterface, options: Options, kit: Kit, s: Snapshot): RenderElement {
  const { Box, Button, Input, Text } = kit
  if (s.concepts.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Nothing learned yet.</Text>
        <Text dimColor wrap="wrap">Each concept the tutor explains lands here, and it builds on them next time.</Text>
      </Box>
    )
  }

  const needle = s.query.trim().toLowerCase()
  const shown = s.concepts.filter(one => `${one.name} ${one.domain} ${one.gist}`.toLowerCase().includes(needle))
  const domains = byField(s.concepts)
  const labelWidth = Math.min(22, Math.max(...domains.map(one => one.domain.length)))
  // Each dot takes two cells with its space; the count after them takes up to nine.
  const room = Math.max(5, Math.floor((s.width - labelWidth - 13) / 2))
  const rows = domains.map(one => ({ ...one, dots: dots(one.known, one.total - one.known, room) }))
  const dotsWidth = Math.max(...rows.map(one => one.dots.join('').length))
  const leadsTo = (name: string) =>
    s.concepts.filter(other => other.builtOn.some(base => slug(base) === slug(name))).map(other => other.name)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column">
        {rows.map(({ domain, known, total, dots: [solid, half] }) => (
          <Box key={`bar-${domain}`} gap={2}>
            <Box width={labelWidth} flexShrink={0}>
              <Text wrap="truncate-end">{domain}</Text>
            </Box>
            <Box width={dotsWidth} flexShrink={0}>
              <Text color={MARK.known.color}>{solid}</Text>
              <Text color={MARK.learning.color} dimColor>{half}</Text>
            </Box>
            <Text dimColor>
              {known}/{total}
            </Text>
          </Box>
        ))}
      </Box>
      {Input !== undefined && (
        <Box gap={1} marginTop={1}>
          <Text dimColor>⌕</Text>
          <Input key="filter" placeholder="filter" submitLabel="filter" onInput={value => update($, filter, () => value)} onSubmit={value => update($, filter, () => value)} />
        </Box>
      )}
      {shown.length === 0 && (
        <Box marginTop={1}>
          <Text dimColor>Nothing matches "{s.query}".</Text>
        </Box>
      )}
      {rows
        .filter(({ domain }) => shown.some(one => one.domain === domain))
        .map(({ domain }) => (
          <Box key={`domain-${domain}`} flexDirection="column" marginTop={1}>
            <Text bold color="claude">{domain}</Text>
            {shown
              .filter(one => one.domain === domain)
              // Newest first by when it was met, so marking one never moves the rows under the focus ring.
              .sort((a, b) => b.firstAt - a.firstAt)
              .map(one => {
                const id = `concept:${slug(one.name)}`
                const isOpen = s.opened.includes(id)
                const isKnown = one.state === 'known'
                const after = leadsTo(one.name)
                return (
                  <Box key={id} flexDirection="column" marginTop={1}>
                    <Box gap={1}>
                      <Text color={MARK[one.state].color} dimColor={MARK[one.state].dimColor}>{MARK[one.state].glyph}</Text>
                      <Box flexGrow={1}>
                        <Button key={`open-${id}`} plain label={one.name} onPress={() => toggle($, id)} />
                      </Box>
                      <Text dimColor>{age(s.now - one.lastAt)}</Text>
                    </Box>
                    <Box flexDirection="column" marginLeft={2}>
                      <Text dimColor={!isOpen} wrap="wrap">{one.gist}</Text>
                      {isOpen && (
                        <Box flexDirection="column" marginTop={1}>
                          {one.builtOn.length > 0 && labelled(kit, s, 'builds on', one.builtOn, `base-${id}`)}
                          {after.length > 0 && labelled(kit, s, 'used by', after, `next-${id}`)}
                          <Text dimColor>
                            {isKnown ? 'known' : 'still learning'}, explained {one.explained}x, first met{' '}
                            {new Date(one.firstAt).toISOString().slice(0, 10)}
                          </Text>
                          <Box columnGap={3} flexWrap="wrap" marginTop={1}>
                            <Button
                              key={`state-${id}`}
                              plain
                              hotkey="k"
                              label={isKnown ? 'Still learning' : 'I know this'}
                              onPress={() => setState($, one.name, isKnown ? 'learning' : 'known')}
                            />
                            <Button key={`refresh-${id}`} plain hotkey="r" label="Refresh me" onPress={() => void ask($, options, `Refresh me on ${one.name}.`)} />
                            <Button
                              key={`forget-${id}`}
                              plain
                              dimColor
                              hotkey="f"
                              label="Forget"
                              onPress={() => change($, () => ({ removed: [one.name] }))}
                            />
                          </Box>
                        </Box>
                      )}
                    </Box>
                  </Box>
                )
              })}
          </Box>
        ))}
    </Box>
  )
}

export const register: Register = (on, raw) => {
  const options: Options = {
    model: typeof raw.model === 'string' ? raw.model : 'opus',
    background: typeof raw.background === 'string' ? raw.background : '',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tutor',
      description: 'Ask the tutor: it explains, remembers what you learned, and builds on it',
      argumentHint: '[question, topics or pasted text]',
    })
    const loaded = await stored($)
    await update($, knowledge, () => loaded)
    // A reload drops the calls in flight; those lessons can only be asked again.
    await update($, lessons, all =>
      all.map(one => (one.status === 'thinking' ? { ...one, status: 'failed', answer: 'Interrupted by a reload.' } : one)),
    )

    return next(e)
  })

  on('command.run', { command: 'tutor' }, async ($, e) => {
    const question = e.args.trim()
    const excerpt = (await $.ui.selection())?.text.trim() || undefined
    await update($, view, () => 'lesson')
    await $.ui.open({ id: PANE, title: 'Tutor', focus: true, columns: 72, rows: 24 })
    // The ring keeps its place from the last time the pane had the keys; a new /tutor starts at the field.
    $.ui.focus({ requestId: PANE, key: 'ask' }).catch((error: unknown) => $.ui.log(`tutor: ${String(error)}`, { to: 'debug' }))
    if (question !== '' || excerpt !== undefined) {
      void ask($, options, question, excerpt)
    }

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit: Kit = $.ui.resolve(e)
    const [all, concepts, current, opened, query, frame, now] = await Promise.all([
      read($, lessons),
      read($, knowledge),
      read($, view),
      read($, expanded),
      read($, filter),
      read($, tick),
      $.clock.now(),
    ])
    const s: Snapshot = { all, concepts, current, opened, query, frame, now, width: e.props.bodyColumns - 3, isFocused: e.props.isFocused }
    const { Box } = kit

    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={2}>
        {header($, kit, s)}
        {current === 'lesson' ? lessonView($, options, kit, s) : knowledgeView($, options, kit, s)}
      </Box>
    )
  })
}
