import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Assumption } from '../types'

const PANE = 'assumptions'
const list = atom({ plugin: 'assumptions', key: 'list' } as const, [] as Assumption[])

const MARKER = /\bASSUMPTION:(?:\*\*|__)?\s*(.+)$/

export function parseAssumptions(text: string): string[] {
  return text
    .split('\n')
    .map(line => MARKER.exec(line)?.[1]?.replaceAll('**', '').trim() ?? '')
    .filter(found => found !== '')
}

async function judge($: EngineInterface, text: string, verdict: 'ok' | 'wrong') {
  const judged = await update($, list, all =>
    all.map(one => (one.text === text ? { ...one, verdict } : one)),
  )
  showCount($, judged)
}

function showCount($: EngineInterface, all: Assumption[]) {
  const open = all.filter(one => one.verdict === undefined).length
  $.ui.status(open === 0 ? undefined : `${open} assumption${open === 1 ? '' : 's'} to review`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'assumptions',
      description: 'Review the assumptions Claude made this session',
    })
    showCount($, await read($, list))

    return next(e)
  })

  on('command.run', { command: 'assumptions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Assumptions', focus: true })

    return {}
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    const stored = await next(e)
    const text = e.message.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('\n')
    const found = e.agentId === undefined ? parseAssumptions(text) : []

    if (found.length > 0) {
      const all = await update($, list, known => [
        ...known,
        ...found
          .filter((one, index) => found.indexOf(one) === index)
          .filter(one => !known.some(seen => seen.text === one))
          .map(one => ({ text: one })),
      ])
      showCount($, all)
      // ponytail: opened unasked, so it docks only on wide fullscreen terminals; the status line covers the rest.
      void $.ui.open({ id: PANE, title: 'Assumptions' })
    }

    return stored
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      showCount($, await update($, list, () => []))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, list)
    const open = all.filter(one => one.verdict === undefined)
    const judged = all.filter(one => one.verdict !== undefined)

    return (
      <Box flexDirection="column" gap={1}>
        {all.length === 0 && <Text dimColor>No assumptions yet.</Text>}
        {open.map((one, index) => (
          <Box key={`open-${one.text}`} flexDirection="column">
            <Text>{one.text}</Text>
            <Box gap={2}>
              <Button
                key={`ok-${one.text}`}
                plain
                hotkey={index === 0 ? 'y' : undefined}
                label="holds"
                onPress={() => judge($, one.text, 'ok')}
              />
              <Button
                key={`wrong-${one.text}`}
                plain
                hotkey={index === 0 ? 'n' : undefined}
                label="wrong"
                onPress={async () => {
                  await judge($, one.text, 'wrong')
                  await $.prompt.fill({ text: `Wrong assumption: ${one.text}\nCorrect: ` })
                }}
              />
            </Box>
          </Box>
        ))}
        {judged.length > 0 && (
          <Box flexDirection="column">
            {judged.map(one => (
              <Text dimColor strikethrough={one.verdict === 'wrong'}>
                {one.verdict === 'ok' ? 'holds' : 'wrong'}  {one.text}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
