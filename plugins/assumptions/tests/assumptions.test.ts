import { expect, test } from 'claude-code/testing'

import { parseAssumptions } from '../hooks/register'

const PANE = {
  plugin: 'assumptions',
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

test('parses markers anywhere on a line', () => {
  expect(
    parseAssumptions('Intro\nASSUMPTION: the API is UTC\n- **ASSUMPTION:** port 8080 is free\nnothing'),
  ).toEqual(['the API is UTC', 'port 8080 is free'])
})

// session.append has no stand-in beneath the plugins in this kit, so the capture path is verified in a live session, not here.
test('the empty pane draws on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /Nothing to review/ })).toBeDefined()
    await ui.unmount()
  }
})
