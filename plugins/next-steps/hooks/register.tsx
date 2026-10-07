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

    return (
      <Box flexDirection="column">
        <Text dimColor>Next steps</Text>
        {list.map((step, index) => (
          <Button
            key={`step-${index + 1}`}
            plain
            hotkey={String(index + 1)}
            label={step}
            onPress={() => $.prompt.fill({ text: step })}
          />
        ))}
      </Box>
    )
  })
}
