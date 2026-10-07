import { expect, test } from 'claude-code/testing'

import { parseNextSteps } from '../hooks/register'

const BAND = {
  plugin: 'next-steps',
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

const ANSWER = 'Done.\n\n## Next steps\n- Run the **check** script\n2. Commit the change\n'

test('parses the heading forms and ignores none', () => {
  expect(parseNextSteps(ANSWER)).toEqual(['Run the check script', 'Commit the change'])
  expect(parseNextSteps('Text\n\n**Next steps:** none')).toEqual([])
  expect(parseNextSteps('Text\n\n**Next steps**\nnone')).toEqual([])
  expect(parseNextSteps('Next steps: push the branch')).toEqual(['push the branch'])
  expect(parseNextSteps('Next steps are unclear here.')).toEqual([])
  expect(parseNextSteps('No section at all')).toEqual([])
})

test('the band lists the last answer and a press fills the prompt', async ($, on) => {
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })

  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.press({ key: 'step-2' })
    await ui.unmount()
  }
  expect(filled).toEqual(['Commit the change', 'Commit the change'])
})

test('the band stays out of the way while working and after an answer without steps', async ($, on) => {
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.turn.complete({ answer: ANSWER, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const working = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, isWorking: true } })
  expect(await working.find({ key: 'step-1' })).toBeUndefined()
  await working.unmount()

  await $.turn.complete({ answer: 'Done.\n\nNext steps: none', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  const idle = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await idle.find({ key: 'step-1' })).toBeUndefined()
})
