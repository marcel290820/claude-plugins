// One concept the learner met, as the knowledge store keeps it.
export type Concept = {
  name: string
  // One plain sentence: what the knowledge view shows and the tutor reuses as a refresher.
  gist: string
  domain: string
  // Concepts the tutor built on when it explained this one: the way into it.
  builtOn: string[]
  // learning: explained, not yet shown to stick; known: the learner confirmed or demonstrated it.
  state: 'learning' | 'known'
  // How often the tutor explained it; a concept asked about again is shaky.
  explained: number
  firstAt: number
  lastAt: number
}

export type Lesson = {
  id: string
  question: string
  // Text the learner selected in the transcript when they asked.
  excerpt?: string
  status: 'thinking' | 'done' | 'failed'
  answer: string
  // The one sentence to remember; empty for a short answer.
  takeaway: string
  // Why nothing was learned from an answer, when nothing was.
  note: string
  // Concept names this answer explained, and the known ones it built on.
  taught: string[]
  builtOn: string[]
  startedAt: number
  isConfirmed: boolean
  // The answer asked the learner a quiz question; the next question is their answer.
  isQuiz: boolean
}

declare module 'claude-code' {
  interface PluginState {
    tutor: {
      lessons: Lesson[]
      knowledge: Concept[]
      view: 'lesson' | 'knowledge'
      // Older lessons and concepts the learner expanded, by id or name.
      expanded: string[]
      filter: string
      // Spinner frame while a lesson is thinking.
      tick: number
    }
  }
}
