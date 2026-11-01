import type { On, TurnCompleteInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'

import { estimateUsd } from '../hooks/prices'
import { addShares } from '../hooks/register'
import { bandSvg } from '../hooks/svg'

const NOW = Date.parse('2026-10-30T10:00:00Z')
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const BAND = { plugin: 'deskstats', requestId: 'above', component: 'AbovePrompt', props: PROPS } as const
const PANE = { plugin: 'deskstats', requestId: 'deskstats-subagents', component: 'Pane', surface: 'desktop', props: { title: 'Subagents', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} } } as const
const ORIGIN = { plugin: 'test', tier: 'core' } as const
const turn = (fields: Partial<TurnCompleteInput> = {}): TurnCompleteInput => ({ answer: '', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer', ...fields }) as TurnCompleteInput
const tokens = (model: string, input: number) => ({ model, input_tokens: input, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const spawn = (description: string, resume?: string) => ({
  tool_use_id: 'tu1',
  prompt: 'find x',
  description,
  subagentType: 'Explore',
  parentModel: 'claude-opus-5-5',
  provider: ORIGIN,
  background: false,
  fork: false,
  ...(resume === undefined ? {} : { resume: { agentId: resume, prompt: '' } }),
})
const prompt = () => ({ text: 'hi', wait: false, origin: { kind: 'composer' as const } })
// One model request of a subagent, read to its end.
const step = async ($: Engine, agentId: string) => {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId }));
}
// What the band says: the Svg's text alternative.
const bandAlt = async ($: Engine) => {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  await ui.unmount()
  return String((svg as { props?: { alt?: string } } | undefined)?.props?.alt)
}

const seed = (on: On) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('session.turns', () => ({ value: 3 }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { tokens: 42000, window: 200000, percent: 21 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 37, resetsAt: '2026-10-30T12:30:00Z' },
        { kind: 'seven_day', percentUsed: 92.5, resetsAt: '2026-11-02T10:00:00Z' },
      ],
      cost: { usd: 0.654 },
    },
  }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
}

test('the desktop draws one Svg with every figure in its alt', async ($, on) => {
  seed(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const usage = { model: 'm', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500 }
  await $.turn.complete(turn({ durationMs: 12000, usage }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const alt = String(((await ui.find({ type: 'Svg' })) as { props?: { alt?: string } })?.props?.alt)
  // 92.5% says so in words, not only in colour.
  for (const text of ['5-hour limit 37% 0% this session resets in 2h 30m', 'very high · resets in 3d 0h', 'context 21%', 'session cost $0.65', 'tokens 10k', 'turns 3', 'agent time 12s'])
    expect(alt).toContain(text)
  expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
  await ui.unmount()
})

test('the terminal draws nothing of ours', async ($, on) => {
  seed(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /5-hour limit/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: 'engine' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a turn adds what it moved each limit by; a new window starts the share over', () => {
  const at = '2026-10-30T12:30:00Z'
  const a = addShares({ five_hour: { start: 10, share: 2, resetsAt: at } }, [{ kind: 'five_hour', percentUsed: 13.5, resetsAt: at }])
  expect(a.five_hour?.share).toBe(5.5)
  // No reading when the turn began: nothing to attribute.
  expect(addShares({}, [{ kind: 'seven_day', percentUsed: 40 }]).seven_day?.share).toBe(0)
  const rolled = addShares({ five_hour: { start: 90, share: 30, resetsAt: at } }, [{ kind: 'five_hour', percentUsed: 4, resetsAt: '2026-10-30T17:30:00Z' }])
  expect(rolled.five_hour?.share).toBe(4)
  // A turn with no reading for a window keeps its share.
  expect(addShares({ five_hour: { share: 5, resetsAt: at } }, []).five_hour?.share).toBe(5)
})

test('a turn shows this session\'s share next to the limit; a window that reset since shows none', async ($, on) => {
  let pct = 37
  let resetsAt = '2026-10-30T12:30:00Z'
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('session.turns', () => ({ value: 1 }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 42000, window: 200000, percent: 21 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt }], cost: { usd: 0.7 } },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.measure', () => ({ changed: ['rateLimits'] }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(prompt())
  // The prompt starts from 37%; the turn ends at 40%.
  pct = 40
  await $.turn.complete(turn())
  expect(await bandAlt($)).toContain('5-hour limit 40% 3% this session')

  // While idle the window resets: the 3% belonged to the old one.
  pct = 4
  resetsAt = '2026-10-30T17:30:00Z'
  await $.session.measure({ context: { tokens: 42000, window: 200000, percent: 21 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt }], changed: ['rateLimits'] })
  expect(await bandAlt($)).toContain('5-hour limit 4% 0% this session')
})

test('a subagent shows in the band and in its pane with what it did and cost', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('session.turns', () => ({ value: 1 }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: 1000, window: 200000, percent: 1 }, rateLimits: [], cost: { usd: 1 } },
  }))
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  // Two requests of 60k prompt tokens: each under 100k, so both at the short rate, $0.10 a million.
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: tokens('claude-haiku-5-5', 60_000) }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn('Find the config loader'))
  await $.tool.call({ tool: 'Bash', command: 'grep -r x', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'grep -r y', agentId: 'a1' })
  await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'a1' })
  // An engine fork's id no spawn named: not a subagent.
  await $.tool.call({ tool: 'Read', file_path: '/b', agentId: 'compaction-fork' })
  await step($, 'compaction-fork')
  await $.turn.complete(turn({ agentId: 'compaction-fork', usage: tokens('claude-haiku-5-5', 60_000) }))
  // 120k input tokens at $0.10 a million = $0.012.
  await step($, 'a1')
  await step($, 'a1')
  await $.turn.complete(turn({ answer: 'Found it in src/config.ts\nmore', durationMs: 5000, agentId: 'a1', usage: tokens('claude-haiku-5-5', 120_000) }))

  expect(await bandAlt($)).toContain('subagent cost ≈$0.01 1% of session cost')

  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /Find the config loader/ }))?.text).toBe('Find the config loader')
  expect((await pane.find({ type: 'Text', text: /Explore/ }))?.text).toContain('claude-haiku-5-5')
  expect((await pane.find({ type: 'Text', text: /tool calls/ }))?.text).toBe('3 tool calls: Bash 2, Read 1')
  expect((await pane.find({ type: 'Text', text: /↳/ }))?.text).toContain('Found it in src/config.ts')
  expect((await pane.find({ type: 'Text', text: /Main agent/ }))?.text).toBe('Main agent ≈$0.99 · subagents ≈$0.01 (1% of $1.00)')
  expect((await pane.find({ type: 'Text', text: /started before/ }))?.text).toBeUndefined()
  await pane.unmount()
})

test('a resumed subagent stays one entry and runs again; control characters are dropped', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('session.turns', () => ({ value: 1 }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [], cost: { usd: 1 } } }))
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn('Fix \u001b[31mred\u001b[0m \u202egnp.exe'))
  await $.turn.complete(turn({ answer: 'ran: \u001b[31mFAIL\u001b[0m', agentId: 'a1', usage: tokens('claude-haiku-5-5', 1000) }))
  await $.agent.spawn(spawn('Fix red', 'a1'))

  // One entry, not two, running again.
  expect(await bandAlt($)).toContain('subagents 1 1 running')

  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /^running · / }))?.text).toBe('running · Fix red gnp.exe')
  expect((await pane.find({ type: 'Text', text: /↳/ }))?.text).toBe('↳ ran: FAIL')
  await pane.unmount()
})

test('averages divide by measured turns; a failed usage read keeps the band', async ($, on) => {
  let fail = false
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  // Ten prompts before this plugin loaded.
  on('session.turns', () => ({ value: 10 }))
  on('session.usage', () => {
    if (fail) throw new Error('usage unavailable')
    return { value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 37 }], cost: { usd: 1 } } }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // 24 turns of 1s and 1k tokens: past the 12 the bars keep.
  for (let i = 0; i < 24; i++) await $.turn.complete(turn({ usage: tokens('m', 1000) }))
  fail = true
  await $.turn.complete(turn({ usage: tokens('m', 1000) }))

  const alt = await bandAlt($)
  for (const text of ['turns 10 ⌀ 1k tokens / turn', 'agent time 25s ⌀ 1s / turn', '5-hour limit 37%']) expect(alt).toContain(text)
})

test('a turn costs what the session cost moved by; after /clear the average counts only new turns', async ($, on) => {
  let cost = 0.2
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 's' }))
  on('clock.now', () => ({ value: NOW }))
  on('session.turns', () => ({ value: 1 }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [], cost: { usd: cost } } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  const costCell = async () => (await bandAlt($)).split('; ').find(c => c.startsWith('session cost'))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(prompt())
  cost = 0.7
  await $.turn.complete(turn({ usage: tokens('m', 1000) }))
  expect(await costCell()).toBe('session cost $0.70 last $0.50 · ⌀ $0.70')

  // The engine keeps its ledger: $0.70 before /clear, one $0.20 turn after it.
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  await $.prompt.submit(prompt())
  cost = 0.9
  await $.turn.complete(turn())
  expect(await costCell()).toBe('session cost $0.20 last $0.20 · ⌀ $0.20')
  expect(await bandAlt($)).toContain('tokens 0')

  // The engine starts a new ledger: a $0.95 turn after /clear, more than all before it.
  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  cost = 0
  await $.prompt.submit(prompt())
  cost = 0.95
  await $.turn.complete(turn())
  expect(await costCell()).toBe('session cost $0.95 last $0.95 · ⌀ $0.95')
})

test('each model is priced at its own rate card', () => {
  const usd4 = (n: number | undefined) => (n === undefined ? n : +n.toFixed(4))
  // Haiku 5.5: 200k prompt tokens is over 100k, so the long rate, $0.50 a million.
  expect(usd4(estimateUsd(tokens('claude-haiku-5-5', 200_000)))).toBe(0.1)
  expect(usd4(estimateUsd(tokens('claude-haiku-5-5', 100_000)))).toBe(0.01)
  const reads = (model: string) => estimateUsd({ ...tokens(model, 0), cache_read_input_tokens: 1_000_000 })
  expect(usd4(reads('claude-fable-5-1'))).toBe(0.25)
  expect(usd4(reads('claude-fable-5'))).toBe(1)
  expect(usd4(reads('claude-opus-5-5'))).toBe(0.2)
  expect(estimateUsd(tokens('some-other-model', 1000))).toBeUndefined()
})

test('a row whose notes do not fit beside their rings wraps onto two lines', () => {
  const limit = (key: string) => ({ key, label: key, value: '92.5%', note: '12.3% this session', sub: '', ring: { fill: 0.9 } })
  const height = (svg: string) => Number(/height="(\d+)"/.exec(svg)?.[1])
  expect(height(bandSvg([[limit('a'), limit('b'), limit('c')]]))).toBe(76)
  expect(height(bandSvg([[limit('a'), limit('b'), limit('c'), limit('d')]]))).toBe(152)
  // A phone's width: one limit a line.
  expect(height(bandSvg([[limit('a'), limit('b')]], 360))).toBe(152)
})

test('a subagent on a model with no price says so rather than costing nothing', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  on('session.turns', () => ({ value: 1 }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200000 }, rateLimits: [], cost: { usd: 1 } } }))
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('agent.spawn', () => ({ model: 'some-other-model', agentId: 'a1' }))
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn('Look around'))
  await $.turn.complete(turn({ agentId: 'a1', usage: tokens('some-other-model', 1000) }))

  expect(await bandAlt($)).toContain('subagent cost ≈$0.00 1 not priced · 0% of session cost')
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /Main agent/ }))?.text).toContain('· 1 not priced')
  await pane.unmount()
})

test('a running turn shows its tokens, cost, context, limit share and time before it ends', async ($, on) => {
  let now = NOW
  let cost = 0.2
  let pct = 37
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: now }))
  on('session.turns', () => ({ value: 1 }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: cost * 100_000, window: 200000, percent: cost * 50 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: '2026-10-30T12:30:00Z' }], cost: { usd: cost } },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: tokens(e.model, 5000) }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(prompt())
  await $.turn.start({ text: 'hi', turnId: 't' })
  // One request of the main turn, 14 seconds in: the session cost, context and limit moved with it.
  now = NOW + 14_000
  cost = 0.5
  pct = 39
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 }));
  for (const text of ['5-hour limit 39% 2% this session', 'context 25%', 'session cost $0.50', 'tokens 5k', 'agent time 14s running · 14s this turn']) expect(await bandAlt($)).toContain(text)

  // A subagent's request counts in its own figures and the session's while it runs.
  await $.agent.spawn(spawn('Look around'))
  now = NOW + 20_000
  await step($, 'a1')
  for (const text of ['tokens 10k', 'subagent tokens 5k 50% of session', 'subagent time 6s']) expect(await bandAlt($)).toContain(text)
  const pane = await $.ui.mount(PANE)
  expect((await pane.find({ type: 'Text', text: /tokens ·/ }))?.text).toBe('≈<$0.01 · 5k tokens · 6s')
  await pane.unmount()

  // At the end the turn's own totals stand, and the time goes back to the average.
  await $.turn.complete(turn({ agentId: 'a1', durationMs: 6000, usage: tokens('claude-haiku-5-5', 5000) }))
  await $.turn.complete(turn({ durationMs: 21_000, usage: tokens('claude-opus-5-5', 6000) }))
  for (const text of ['tokens 11k', 'agent time 21s ⌀ 21s / turn', '5-hour limit 39% 2% this session']) expect(await bandAlt($)).toContain(text)
})
