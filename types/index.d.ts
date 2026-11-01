// Per-turn history the band draws its bars from; the last 12 turns.
export type Stats = {
  tokens: number
  busyMs: number
  turns: number
  // Main turns this plugin measured: the averages divide by these, not by prompts sent before it loaded.
  seen: number
  costBase: number
  // The session cost that spend since the last /clear is measured from; null until the first prompt after it.
  costStart: number | null
  turnCosts: number[]
  turnTokens: number[]
  turnMs: number[]
  // Per limit window: the reading when the turn began, this session's points so far, and the window it counts in.
  limits: Record<string, { start?: number; share: number; resetsAt?: string }>
  // The main turn running now, absent between turns.
  live?: Live
}

// A run still going: when it began, and the tokens its requests have used so far.
export type Live = { since: number; tokens: number }

// One subagent this session started, and what it did.
export type Agent = {
  id: string
  description: string
  type: string
  model: string
  tokens: number
  // Estimated from tokens and list prices; absent for a model with no known price.
  usd?: number
  ms: number
  tools: Record<string, number>
  report: string
  isDone: boolean
  // Present while it runs.
  live?: Live
}

declare module 'claude-code' {
  // SessionUsage is the engine's own type, named from inside its module: the contract imports nothing.
  interface PluginState {
    'deskstats': { usage: SessionUsage | null; stats: Stats; agents: Agent[] }
  }
}
