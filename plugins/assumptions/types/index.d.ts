export type Assumption = { text: string; verdict?: 'ok' | 'wrong' }

declare module 'claude-code' {
  interface PluginState {
    assumptions: { list: Assumption[] }
  }
}
