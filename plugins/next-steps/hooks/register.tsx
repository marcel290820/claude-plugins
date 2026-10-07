import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { NextStep } from '../types'

const steps = atom({ plugin: 'next-steps', key: 'steps' } as const, [] as NextStep[])

// "## Next steps", "**Next steps:**", "Next steps:", or the bare words on a line; group 1 is any text after them.
const HEADING =
  /^\s*(?:#{1,6}\s+(?:\*\*)?next steps(?:\*\*)?:?|(?:\*\*|__)next steps:?(?:\*\*|__):?|next steps:|next steps(?=\s*$))\s*(.*)$/i
const MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/

// Every non-blank line after the reply's last Next steps heading is a step; "none" is no step.
export function parseNextSteps(answer: string): NextStep[] {
  const lines = answer.split('\n')
  const start = lines.findLastIndex(line => HEADING.test(line))

  if (start === -1) {
    return []
  }

  return [HEADING.exec(lines[start] ?? '')?.[1] ?? '', ...lines.slice(start + 1)]
    .map(line => line.replace(MARKER, '').replaceAll('**', '').trim())
    .filter(step => step !== '' && !/^none\b/i.test(step))
    .slice(0, 9)
}

// ponytail: CJK and emoji-presentation graphemes count as two cells; other East Asian Width cases count as one. Use a full width table if they show up.
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}|\uFE0F/u
const graphemes = new Intl.Segmenter()

// Cuts text to `room` terminal cells at a grapheme boundary, ending in "…" when cut (just "…" when no cell is left).
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

  return `${kept}…`
}

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const found = parseNextSteps(e.answer)
      await update($, steps, () => found)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, steps, () => [])
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, steps)
    const isQuiet =
      list.length === 0 ||
      e.props.hasSurvey ||
      e.props.isWorking ||
      e.props.view.agentId !== undefined

    if (isQuiet) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    // One row per step: "1: " takes three cells; the full step still goes to the prompt.
    const room = e.props.bodyColumns - 3

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold>Next steps</Text>
          <Text dimColor>
            ({list.length === 1 ? '1' : `1-${list.length}`} to insert)
          </Text>
        </Box>
        {list.map((step, index) => (
          <Button
            key={`step-${index + 1}`}
            plain
            hotkey={String(index + 1)}
            label={fit(step, room)}
            onPress={() => $.prompt.fill({ text: step })}
          />
        ))}
      </Box>
    )
  })
}
