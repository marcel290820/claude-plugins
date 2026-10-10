// One step of the reply's Next steps; `isYours` marks one only the person can take.
export type Step = { text: string; isYours: boolean }

// A step of the person's own they ticked off; `isTold` once their next prompt told Claude.
export type Done = { text: string; isTold: boolean }

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
    debrief: { steps: Step[]; done: Done[]; assumptions: Assumption[]; round: number }
  }
}
