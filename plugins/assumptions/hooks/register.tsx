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
  $.ui.status(open === 0 ? undefined : `${open} to review`)
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
    const held = judged.filter(one => one.verdict === 'ok').length

    if (all.length === 0) {
      return (
        <Text dimColor>
          Nothing to review. Lines Claude marks ASSUMPTION: land here.
        </Text>
      )
    }

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text bold>Assumptions</Text>
            <Text dimColor>
              {[
                open.length > 0 ? `${open.length} open` : 'all reviewed',
                held > 0 ? `${held} holds` : '',
                judged.length > held ? `${judged.length - held} wrong` : '',
              ]
                .filter(part => part !== '')
                .join(', ')}
            </Text>
          </Box>
          {open.length > 0 && !e.props.isFocused && (
            <Text dimColor>(ctrl+x tab to answer)</Text>
          )}
        </Box>
        <Box flexDirection="column">
          {open.map((one, index) => {
            const isNext = index === 0

            // The next one answers to y/n while the pane has the keys; the rest show their buttons under the pointer.
            return (
              <Box key={`open-${one.text}`} gap={1}>
                <Text color={isNext ? 'suggestion' : 'warning'}>{isNext ? '❯' : '?'}</Text>
                <Text bold={isNext} color={isNext ? 'suggestion' : undefined}>
                  {one.text}
                </Text>
                <Box
                  gap={2}
                  marginLeft={2}
                  flexShrink={0}
                  {...(isNext ? {} : { display: 'none', hover: { display: 'flex' } } as const)}
                >
                  <Button
                    key={`ok-${one.text}`}
                    plain
                    dimColor={!e.props.isFocused}
                    hotkey={isNext && e.props.isFocused ? 'y' : undefined}
                    label="holds"
                    onPress={() => judge($, one.text, 'ok')}
                  />
                  <Button
                    key={`wrong-${one.text}`}
                    plain
                    dimColor={!e.props.isFocused}
                    hotkey={isNext && e.props.isFocused ? 'n' : undefined}
                    label="wrong"
                    onPress={async () => {
                      await judge($, one.text, 'wrong')
                      await $.prompt.fill({ text: `Wrong assumption: ${one.text}\nCorrect: ` })
                    }}
                  />
                </Box>
              </Box>
            )
          })}
          {judged.map(one => (
            <Box key={`judged-${one.text}`} gap={1}>
              <Text color={one.verdict === 'ok' ? 'success' : 'error'}>
                {one.verdict === 'ok' ? '✓' : '✗'}
              </Text>
              <Text dimColor strikethrough={one.verdict === 'wrong'}>
                {one.text}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
