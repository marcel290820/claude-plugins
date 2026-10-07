export type Tip = { id: string; why: string; isUrgent?: boolean }

export type TipsSession = {
  tip: Tip | null
  // Tip ids shown this session; each shows once.
  shown: string[]
  // Prompts the person typed, and the count when the last tip showed.
  prompts: number
  lastAt: number
  // Files edited this session, and Bash commands run since the last prompt.
  edited: string[]
  bash: string[]
  asks: number
}

declare module 'claude-code' {
  interface PluginState {
    tips: { session: TipsSession; filter: string }
  }
}
