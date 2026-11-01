// Estimated USD of one model request from its token counts, at first-party API list prices (per million tokens).
// shortcut: hand-copied price table (2026-10), update it when prices or models change; unknown models get no estimate.
// shortcut: cache writes priced at the 1-hour rate (2x input) Claude Code uses; split by TTL if usage ever reports it.

import type { TurnUsage } from 'claude-code'

type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }

const p = (input: number, output: number, cacheRead: number): Price => ({ input, output, cacheWrite: input * 2, cacheRead })

// Prompts past this many tokens take a model's long rate card, where it has one.
const LONG = 100_000

// First match wins, so specific ids come before their family. The third entry is the long-prompt rate.
const PRICES: [RegExp, Price, Price?][] = [
  [/(fable|mythos)-5-1/, p(10, 50, 0.25)],
  [/fable|mythos/, p(10, 50, 1)],
  [/opus-5-5/, p(4, 20, 0.2)],
  [/opus/, p(5, 25, 0.5)],
  [/sonnet-5/, p(2, 10, 0.2)],
  [/sonnet/, p(3, 15, 0.3)],
  [/haiku-5-5/, p(0.1, 0.5, 0.01), p(0.5, 2.5, 0.05)],
  [/haiku/, p(1, 5, 0.1)],
]

// Counts summed over several requests overstate the prompt, so price each request (a turn.step's usage), not a turn.
export function estimateUsd(u: TurnUsage): number | undefined {
  const row = PRICES.find(([re]) => re.test(u.model))
  if (row === undefined) return undefined
  const prompt = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  const price = row[2] !== undefined && prompt > LONG ? row[2] : row[1]
  return (
    (u.input_tokens * price.input +
      u.output_tokens * price.output +
      u.cache_creation_input_tokens * price.cacheWrite +
      u.cache_read_input_tokens * price.cacheRead) /
    1e6
  )
}

export const totalTokens = (u: TurnUsage) => u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
