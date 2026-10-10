// One step of the reply's Next steps.
export type Step = { text: string }

// What the person made of a step, in the order one key cycles through: Claude does it next, drop it, they do it
// themselves, they want to talk it through. A step with no mark is open.
export type Mark = 'next' | 'drop' | 'mine' | 'chat'

// A step the person marked; `isTold` once their next prompt told Claude.
export type Marked = { text: string; mark: Mark; isTold: boolean }

export type Verdict = 'holds' | 'wrong'

export type Assumption = {
  text: string
  // The person's prompt it was made (or last said) after.
  round: number
  // Absent while unverified.
  verdict?: Verdict
  // The prompt the verdict was set under: the band keeps it in view until the next one.
  settledIn?: number
  // The verdict Claude has heard: its own, or the person's once their next prompt carried it.
  told?: Verdict
  // What is true instead, or why it could not be checked, when Claude said so.
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    debrief: { steps: Step[]; marks: Marked[]; assumptions: Assumption[]; round: number }
  }
}
