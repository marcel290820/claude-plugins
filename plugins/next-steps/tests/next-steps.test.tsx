import { expect, test } from 'claude-code/testing'

import { fit, parseNextSteps } from '../hooks/register'

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

test('a long step is cut to one row but fills the prompt whole', async ($, on) => {
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  const step = 'Run the full check script and read every failure carefully'
  await $.turn.complete({ answer: `## Next steps\n- ${step}`, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 23 } })
  expect((await ui.find({ key: 'step-1' }))?.text).toBe('Run the full check …')
  await ui.press({ key: 'step-1' })
  expect(filled).toEqual([step])
})

test('fit counts terminal cells and never splits a character', () => {
  expect(fit('short', 10)).toBe('short')
  expect(fit('abcdefghij', 5)).toBe('abcd…')
  expect(fit('\u65E5\u672C\u8A9E\u306E\u30C6\u30AD\u30B9\u30C8', 7)).toBe('\u65E5\u672C\u8A9E…')
  expect(fit('ship it \u{1F680}\u{1F680}\u{1F680}', 10)).toBe('ship it …')
  expect(fit('\u{1F469}\u200D\u{1F4BB} pair', 4)).toBe('\u{1F469}\u200D\u{1F4BB} …')
  expect(fit('\u2705 Verify the change', 19)).toBe('\u2705 Verify the chan…')
  expect(fit('\u{1F1E9}\u{1F1EA}\u{1F1E9}\u{1F1EA}\u{1F1E9}\u{1F1EA}', 5)).toBe('\u{1F1E9}\u{1F1EA}\u{1F1E9}\u{1F1EA}…')
  expect(fit('\u2764\uFE0F\u2764\uFE0F\u2764\uFE0F', 5)).toBe('\u2764\uFE0F\u2764\uFE0F…')
  expect(fit('anything', 0)).toBe('…')
  expect(fit('anything', -2)).toBe('…')
})
