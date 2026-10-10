import type { Mark, Step } from '../types'

// Appended to the main loop's system prompt: the forms this plugin reads, so it works without them in CLAUDE.md.
export const FORMAT = `The debrief plugin shows the end of each reply above the user's prompt, one key per item: your next steps for them to mark (you do it next, drop it, they do it, they want to talk it over), and your assumptions to confirm or correct. Write for it:
- Next steps: end every reply with a "## Next steps" heading and a numbered list, or "Next steps: none" when nothing is pending. Write each step as a short, specific action, whoever takes it ("Commit and push the fix", not "I could commit this"). Most useful first, at most five.
- Assumptions: put each unverified assumption you act on on a line of its own, "ASSUMPTION: <a plain statement the user can confirm or refute>", when you make it, so the user can correct it before you build on it.`

// What the verify action puts in the prompt; the open assumptions ride along as context the user does not see.
export const VERIFY = 'Verify your open assumptions before going on'

export function verifyContext(open: readonly string[]): string {
  return [
    'The open assumptions, as you wrote them:',
    ...open.map(text => `- ${text}`),
    '',
    'Check each one with your tools, without changing anything. Then answer with one line per assumption, repeating it exactly:',
    'HOLDS: <assumption> -- how you checked',
    'WRONG: <assumption> -- what is true',
    'UNSURE: <assumption> -- what you could not check',
  ].join('\n')
}

export type News = { holds: readonly string[]; wrong: readonly string[]; steps: Readonly<Record<Mark, readonly string[]>> }

const SAID: Record<Mark, string> = {
  next: 'Wants you to do these steps next',
  drop: 'Dropped these steps, do not do them',
  mine: 'Takes these steps on themselves',
  chat: 'Wants to talk these steps over first (the prompt may say more)',
}

const MEMORY = 'These are facts the user checked: if you keep a memory, save any that will still matter in later sessions, a wrong one with what is true instead.'

// What the person marked since Claude last heard, for their next prompt to carry; undefined when nothing.
export function newsContext({ holds, wrong, steps }: News): string | undefined {
  const quote = (list: readonly string[]) => list.map(one => `"${one}"`).join('; ')
  const lines = [
    holds.length > 0 ? `- Confirmed these assumptions hold: ${quote(holds)}` : '',
    wrong.length > 0 ? `- Marked these assumptions wrong (the prompt may say what is true): ${quote(wrong)}` : '',
    ...(Object.keys(SAID) as Mark[]).map(mark => (steps[mark].length > 0 ? `- ${SAID[mark]}: ${quote(steps[mark])}` : '')),
    // Assumptions the person settled are the facts most worth keeping, so Claude's own memory gets the chance.
    holds.length + wrong.length > 0 ? MEMORY : '',
  ].filter(line => line !== '')

  return lines.length === 0 ? undefined : ['What the user marked in the debrief since your last reply:', ...lines].join('\n')
}

// What a second press on an assumption puts in the prompt; the person types what is true after it.
export const correction = (text: string) => `The assumption "${text}" is wrong: `

// "## Next steps", "**Next steps:**", "Next steps:", or the bare words on a line; group 1 is any text after them.
const HEADING =
  /^\s*(?:#{1,6}\s+(?:\*\*)?next steps(?:\*\*)?:?|(?:\*\*|__)next steps:?(?:\*\*|__):?|next steps:|next steps(?=\s*$))\s*(.*)$/i
const MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/

// Every non-blank line after the reply's last Next steps heading is a step; "none" is no step.
export function parseSteps(answer: string): Step[] {
  const lines = answer.split('\n')
  const start = lines.findLastIndex(line => HEADING.test(line))

  if (start === -1) {
    return []
  }

  return [HEADING.exec(lines[start] ?? '')?.[1] ?? '', ...lines.slice(start + 1)]
    .map(line => line.replace(MARKER, '').replaceAll('**', '').trim())
    .filter(step => step !== '' && !/^none\b/i.test(step))
    .slice(0, 9)
    .map(text => ({ text }))
}

// A marker quoted in backticks (`ASSUMPTION:`) is a mention, not an assumption.
const ASSUMPTION = /(?<!`)\bASSUMPTION:(?:\*\*|__)?\s*(.+)$/
const FENCE = /^\s*(`{3,}|~{3,})/

// The fence a code block is open under after this line, if any: only a fence of its kind and at least its length
// closes it, so a longer fence can hold a shorter one.
function fence(open: string | undefined, line: string): string | undefined {
  const mark = FENCE.exec(line)?.[1]
  if (mark === undefined) {
    return open
  }

  return open === undefined ? mark : mark[0] === open[0] && mark.length >= open.length ? undefined : open
}

// Every ASSUMPTION: line outside code blocks, once each.
export function parseAssumptions(text: string): string[] {
  let open: string | undefined
  const found: string[] = []
  for (const line of text.split('\n')) {
    open = fence(open, line)
    const one = open !== undefined ? '' : (ASSUMPTION.exec(line)?.[1]?.replaceAll('**', '').trim() ?? '')
    if (one !== '' && !found.includes(one)) {
      found.push(one)
    }
  }

  return found
}

export type Verdict = { kind: 'holds' | 'wrong' | 'unsure'; claim: string; note: string }

const VERDICT = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?(HOLDS|WRONG|UNSURE):(?:\*\*|__)?\s*(.+)$/
const NOTE = /\s+(?:--|\u2014|\u2013)\s+/

// The HOLDS / WRONG / UNSURE lines Claude answers a verify request with; one in a code block is an example.
export function parseVerdicts(text: string): Verdict[] {
  let open: string | undefined
  return text.split('\n').flatMap(line => {
    open = fence(open, line)
    const match = open !== undefined ? null : VERDICT.exec(line)
    if (match === null) {
      return []
    }
    const [claim = '', ...note] = (match[2] ?? '').replaceAll('**', '').split(NOTE)
    const kind = match[1] === 'HOLDS' ? 'holds' : match[1] === 'WRONG' ? 'wrong' : 'unsure'

    return [{ kind, claim: claim.trim(), note: note.join(' - ').trim().slice(0, 300) }]
  })
}

// Case, spacing, quotes, bold and a closing period do not count, so a claim repeated loosely still names its
// assumption; underscores do, as they belong to names (user_id, _id).
const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[`"'*]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim()

export const same = (a: string, b: string) => plain(a) === plain(b)

// The assumption a verdict line names: the same text, also after a label like "A2:" or "1." Nothing looser, so a
// claim that only looks alike (v1, v1.1) names none and its assumption stays open for the person.
export function named<T extends { text: string }>(all: readonly T[], claim: string): T | undefined {
  const bare = claim.replace(/^\s*[a-z]?\d+[:.)]\s+/i, '')

  return all.find(one => same(one.text, claim) || same(one.text, bare))
}

// ponytail: CJK and emoji-presentation graphemes count as two cells; other East Asian Width cases count as one. Use a full width table if they show up.
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}|\uFE0F/u
const graphemes = new Intl.Segmenter()

// Cuts text to `room` terminal cells at a grapheme boundary, ending in an ellipsis when cut. A Button's label
// wraps rather than truncates, so a one-row button is cut here.
export function fit(text: string, room: number): string {
  const cells = [...graphemes.segment(text)].map(({ segment }) => ({
    segment,
    width: WIDE.test(segment) ? 2 : 1,
  }))

  if (cells.reduce((sum, cell) => sum + cell.width, 0) <= room) {
    return text
  }

  let used = 1
  let kept = ''
  for (const cell of cells) {
    if (used + cell.width > room) {
      break
    }
    used += cell.width
    kept += cell.segment
  }

  return `${kept}\u2026`
}
