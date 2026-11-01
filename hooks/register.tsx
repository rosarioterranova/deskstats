import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { Agent, Live, Stats } from '../types'
import { estimateUsd, totalTokens } from './prices'
import { bandSvg } from './svg'
import type { Cell } from './svg'

const EMPTY: Stats = { tokens: 0, busyMs: 0, turns: 0, seen: 0, costBase: 0, costStart: 0, turnCosts: [], turnTokens: [], turnMs: [], limits: {} }

const usage = atom({ plugin: 'deskstats', key: 'usage' } as const, null)
const stats = atom({ plugin: 'deskstats', key: 'stats' } as const, EMPTY)
const agents = atom({ plugin: 'deskstats', key: 'agents' } as const, [])

const PANE = 'deskstats-subagents'

const LIMITS: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'weekly limit', spend_limit: 'spend limit' }
const KEEP = 12

// Switches unit on the rounded value, so 999,950 reads 1M, not 1000k.
const fmtTokens = (n: number) => (n < 1000 ? `${n}` : n < 999_950 ? `${+(n / 1e3).toFixed(1)}k` : `${+(n / 1e6).toFixed(1)}M`)

const elapsed = (ms: number) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const resetIn = (min: number) => {
  if (min < 60) return `resets in ${min}m`
  if (min < 48 * 60) return `resets in ${Math.floor(min / 60)}h ${min % 60}m`
  return `resets in ${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`
}

const tone = (pct: number) => (pct >= 90 ? ('error' as const) : pct >= 75 ? ('warning' as const) : undefined)
// The tone in words too, so it does not rest on colour alone.
const TONE_WORD = { warning: 'high', error: 'very high' }
const withTone = (t: Cell['tone'], sub: string) => [t && TONE_WORD[t], sub].filter(Boolean).join(' · ')
const push = (xs: number[], x: number) => [...xs, x].slice(-KEEP)
const avg = (total: number, n: number) => (n > 0 ? total / n : 0)
const pct = (n: number) => `${+n.toFixed(1)}%`
const usd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)
const share = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0)
// What the session cost moved by since a mark. A cost below the mark means the engine started its ledger over.
const since = (cost: number, mark: number) => (cost >= mark ? cost - mark : cost)
// The cost since the last /clear; nothing yet when no prompt has marked where it starts.
const spent = (cost: number, s: Stats) => since(cost, s.costStart ?? cost)
const agentUsd = (list: Agent[]) => list.reduce((t, a) => t + (a.usd ?? 0), 0)
// A run's time so far: what finished runs took, plus the one going now.
const runMs = (ms: number, now: number, live?: Live) => ms + (live === undefined ? 0 : Math.max(0, now - live.since))
const agentTokens = (a: Agent) => a.tokens + (a.live?.tokens ?? 0)
// Finished subagents on a model with no known price: their cost is missing from every estimate.
const unpriced = (list: Agent[]) => {
  const n = list.filter(a => a.isDone && a.usd === undefined).length
  return n > 0 ? `${n} not priced` : ''
}
const toolSummary = (tools: Agent['tools']) => {
  const sorted = Object.entries(tools).sort((a, b) => b[1] - a[1])
  const calls = sorted.reduce((t, [, n]) => t + n, 0)
  return calls === 0 ? 'no tool calls' : `${calls} tool calls: ${sorted.slice(0, 4).map(([t, n]) => `${t} ${n}`).join(', ')}`
}
const firstLine = (text: string) => text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
// Text a subagent or the API wrote: the engine refuses control characters, bidi marks can disguise it, and length is capped.
const clean = (text: string, max = 200) =>
  [
    ...text
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/(?:[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]|\s)+/g, ' ')
      .trim(),
  ]
    .slice(0, max)
    .join('')
// Readings with no reset time cannot tell windows apart, so they count as the same one.
const sameWindow = (a?: string, b?: string) => a === undefined || b === undefined || a === b

// What this turn moved each limit by, added to the session's share. A new resetsAt is a new window: the share starts over.
// shortcut: every point the window moved during this session's turns counts as this session's, so another session working
// at the same time inflates it; exact needs per-request usage from the API, which nothing reports.
export function addShares(limits: Stats['limits'], now: SessionRateLimit[]): Stats['limits'] {
  // A window with no reading this turn keeps its share.
  const out: Stats['limits'] = Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, { share: v.share, resetsAt: v.resetsAt }]))
  for (const r of now) {
    const prev = limits[r.kind]
    const rolled = prev !== undefined && !sameWindow(prev.resetsAt, r.resetsAt)
    const share = rolled ? r.percentUsed : (prev?.share ?? 0) + (prev?.start === undefined ? 0 : Math.max(0, r.percentUsed - prev.start))
    out[r.kind] = { share: +share.toFixed(1), resetsAt: r.resetsAt }
  }
  return out
}

export function cells(u: SessionUsage, s: Stats, now: number, list: Agent[] = []): Cell[][] {
  const limits: Cell[] = u.rateLimits.map(r => {
    const kept = s.limits[r.kind]
    // A share from a window that has since reset is not this one's. A turn still running adds what it moved the window by so far.
    const moved = kept?.start === undefined ? 0 : Math.max(0, r.percentUsed - kept.start)
    const mine = kept !== undefined && sameWindow(kept.resetsAt, r.resetsAt) ? Math.min(r.percentUsed, kept.share + moved) : 0
    const at = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
    const t = tone(r.percentUsed)
    return {
      key: r.kind,
      label: LIMITS[r.kind] ?? clean(r.kind, 40),
      value: `${r.percentUsed}%`,
      note: `${pct(mine)} this session`,
      sub: withTone(t, Number.isFinite(at) ? resetIn(Math.max(0, Math.round((at - now) / 60000))) : ''),
      tone: t,
      ring: { fill: r.percentUsed / 100, mine: mine / 100 },
    }
  })
  if (u.context.percent !== undefined) {
    const t = tone(u.context.percent)
    limits.push({
      key: 'context',
      label: 'context',
      value: `${Math.round(u.context.percent)}%`,
      sub: withTone(t, `${fmtTokens(u.context.tokens ?? 0)} / ${fmtTokens(u.context.window)}`),
      tone: t,
      ring: { fill: u.context.percent / 100 },
    })
  }

  const last = <T,>(xs: T[]) => xs[xs.length - 1]
  const lastCost = last(s.turnCosts)
  const work: Cell[] = []
  if (u.cost !== undefined) {
    work.push({
      key: 'cost',
      label: 'session cost',
      // Since the last /clear, as the averages and shares below count it.
      value: `$${spent(u.cost.usd, s).toFixed(2)}`,
      sub: lastCost === undefined ? '' : `last $${lastCost.toFixed(2)} · ⌀ $${avg(spent(u.cost.usd, s), s.turns).toFixed(2)}`,
      bars: s.turnCosts,
    })
  }
  const lastTokens = last(s.turnTokens)
  // Running totals count what the turns and subagents still going have used so far; the per-turn figures wait for the turn to end.
  const tokens = s.tokens + (s.live?.tokens ?? 0) + list.reduce((t, a) => t + (a.live?.tokens ?? 0), 0)
  // Per-turn averages divide by the turns this plugin measured, not by prompts sent before it loaded.
  work.push(
    {
      key: 'tokens',
      label: 'tokens',
      value: fmtTokens(tokens),
      sub: lastTokens === undefined ? '' : `last ${fmtTokens(lastTokens)}`,
      bars: s.turnTokens,
    },
    { key: 'turns', label: 'turns', value: `${s.turns}`, sub: s.seen > 0 ? `⌀ ${fmtTokens(Math.round(avg(s.tokens, s.seen)))} tokens / turn` : '', dots: s.turns },
    {
      key: 'time',
      label: 'agent time',
      value: elapsed(runMs(s.busyMs, now, s.live)),
      sub: s.live !== undefined ? `running · ${elapsed(runMs(0, now, s.live))} this turn` : s.seen > 0 ? `⌀ ${elapsed(avg(s.busyMs, s.seen))} / turn` : '',
      bars: s.turnMs,
    },
  )
  if (list.length === 0) return [limits, work]

  // Main agent vs subagents: what the subagents took of the session.
  const running = list.filter(a => !a.isDone).length
  const subUsd = agentUsd(list)
  const subTokens = list.reduce((t, a) => t + agentTokens(a), 0)
  const subMs = list.reduce((t, a) => t + runMs(a.ms, now, a.live), 0)
  const recent = list.slice(-KEEP)
  const subs: Cell[] = [
    { key: 'agents', label: 'subagents', value: `${list.length}`, sub: running > 0 ? `${running} running` : 'all done', dots: list.length },
    {
      key: 'agent-cost',
      label: 'subagent cost',
      value: `≈${usd(subUsd)}`,
      sub: [unpriced(list), u.cost !== undefined && `${share(subUsd, spent(u.cost.usd, s))}% of session cost`].filter(Boolean).join(' · '),
      bars: recent.map(a => a.usd ?? 0),
    },
    { key: 'agent-tokens', label: 'subagent tokens', value: fmtTokens(subTokens), sub: `${share(subTokens, tokens)}% of session`, bars: recent.map(agentTokens) },
    { key: 'agent-time', label: 'subagent time', value: elapsed(subMs), sub: `⌀ ${elapsed(avg(subMs, list.length))} each`, bars: recent.map(a => runMs(a.ms, now, a.live)) },
  ]
  return [limits, work, subs]
}

// Only agents this session spawned: the engine's own forks (compaction, memory) carry ids no spawn named.
const touch = ($: EngineInterface, id: string, fn: (a: Agent) => Agent) =>
  update($, agents, list => (list.some(a => a.id === id) ? list.map(a => (a.id === id ? fn(a) : a)) : list))

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Subagents' })

// Redraws once a second so a running time counts up, until `isRunning` says that run is over. Draws only: nothing is written.
const tickWhile = ($: EngineInterface, isRunning: () => Promise<boolean>) => {
  const timer = $.clock.every(1000, () => {
    isRunning().then(
      yes => (yes ? $.ui.invalidate('ui.render') : timer.cancel()),
      () => timer.cancel(),
    )
  })
}

// A failed read keeps the last reading, so one bad call does not hide the band.
const refresh = async ($: EngineInterface) => {
  const fresh = await $.session.usage().catch(() => null)
  await update($, usage, prev => fresh ?? prev)
  return read($, usage)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // First, and never fatal: the band works without the command.
    await $.command.register({ name: 'subagents', description: 'Show what each subagent of this session did and cost' }).catch(() => undefined)
    const u = await refresh($)
    // The cost so far is the baseline for the next turn's own cost.
    const turns = await $.session.turns().catch(() => undefined)
    // A run the last process left going never ends now: it stops counting.
    await update($, stats, s => ({ ...EMPTY, ...s, costBase: u?.cost?.usd ?? s.costBase, turns: turns ?? s.turns, live: undefined }))
    await update($, agents, list => list.map(a => (a.live === undefined ? a : { ...a, live: undefined, isDone: true })))
    return result
  })

  // A main turn begins: its tokens and time count up from here until turn.complete.
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const since = await $.clock.now()
      await update($, stats, s => ({ ...EMPTY, ...s, live: { since, tokens: 0 } }))
      tickWhile($, async () => (await read($, stats)).live?.since === since)
    }
    return result
  }).catch(($, e, next) => next(e))

  // The reading this turn starts from: what it adds to a limit is the move from here.
  // Observers, not guards: a hook that throws lets the prompt, subagent or tool go on as if deskstats were not there.
  on('prompt.submit', async ($, e, next) => {
    const u = await refresh($)
    if (u !== null) {
      await update($, stats, x => {
        const s = { ...EMPTY, ...x }
        const limits = { ...s.limits }
        for (const r of u.rateLimits) {
          const kept = limits[r.kind]
          limits[r.kind] = kept !== undefined && sameWindow(kept.resetsAt, r.resetsAt) ? { ...kept, start: r.percentUsed } : { share: 0, resetsAt: r.resetsAt, start: r.percentUsed }
        }
        // The first prompt after /clear marks where its cost starts, whether the engine kept its ledger or began a new one.
        const cost = u.cost?.usd
        const mark = s.costStart === null && cost !== undefined ? { costStart: cost, costBase: cost } : {}
        return { ...s, limits, ...mark }
      })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Pushed after each turn and whenever a limit moves a whole point.
  on('session.measure', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('command.run', { command: 'subagents' }, async $ => {
    await openPane($)
    return { text: 'Subagents pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId
    if (started.deny === undefined && id !== undefined) {
      const live = { since: await $.clock.now(), tokens: 0 }
      const agent: Agent = { id, description: clean(e.description), type: clean(e.subagentType, 60), model: clean(started.model, 60), tokens: 0, ms: 0, tools: {}, report: '', isDone: false, live }
      // A resumed run keeps its id: that entry runs again rather than a second one appearing.
      await update($, agents, list => (list.some(a => a.id === id) ? list.map(a => (a.id === id ? { ...a, isDone: false, live } : a)) : [...list, agent]))
      tickWhile($, async () => (await read($, agents)).some(a => a.id === id && a.live?.since === live.since))
    }
    return started
  }).catch(($, e, next) => next(e))

  // Each request as it ends: its tokens count toward the run going now, and the band reads the session's cost and context again.
  // A subagent's cost is priced here, one request at a time: a turn's summed counts hide each request's prompt size, which sets the rate.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const id = e.agentId
    const used = result.usage
    if (used) {
      const n = totalTokens(used)
      if (id === undefined) await update($, stats, s => (s.live === undefined ? s : { ...s, live: { ...s.live, tokens: s.live.tokens + n } }))
      else {
        const cost = estimateUsd(used)
        await touch($, id, a => ({ ...a, ...(cost === undefined ? {} : { usd: (a.usd ?? 0) + cost }), ...(a.live && { live: { ...a.live, tokens: a.live.tokens + n } }) }))
      }
    }
    await refresh($)
    return result
  })

  // The tool runs first: the count waits on it, not it on the count.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const id = e.agentId
    if (id !== undefined) {
      const tool = clean(e.tool, 60)
      await touch($, id, a => ({ ...a, tools: { ...a.tools, [tool]: (a.tools[tool] ?? 0) + 1 } }))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const used = e.usage
    const tokens = used ? totalTokens(used) : 0
    const id = e.agentId
    if (id !== undefined) {
      await touch($, id, a => ({
        ...a,
        model: used ? clean(used.model, 60) : a.model,
        tokens: a.tokens + tokens,
        ms: a.ms + e.durationMs,
        report: clean(firstLine(e.answer), 300) || a.report,
        isDone: true,
        // The run's own totals above replace what its requests added up to.
        live: undefined,
      }))
      // A subagent's tokens count in the session's; its cost is already in the session cost, so it is only estimated here.
      await update($, stats, s => ({ ...EMPTY, ...s, tokens: s.tokens + tokens }))
      return next(e)
    }
    const u = await refresh($)
    const turns = await $.session.turns().catch(() => undefined)
    await update($, stats, x => {
      const s = { ...EMPTY, ...x }
      const cost = u?.cost?.usd ?? s.costBase
      const turnCost = since(cost, s.costBase)
      // No `live`: the turn's own totals replace what its requests added up to, so any drift between them corrects here.
      return {
        tokens: s.tokens + tokens,
        busyMs: s.busyMs + e.durationMs,
        turns: typeof turns === 'number' ? turns : s.turns + 1,
        seen: s.seen + 1,
        costBase: cost,
        costStart: s.costStart,
        turnCosts: push(s.turnCosts, turnCost),
        turnTokens: push(s.turnTokens, tokens),
        turnMs: push(s.turnMs, e.durationMs),
        limits: u ? addShares(s.limits, u.rateLimits) : s.limits,
      }
    })
    return next(e)
  })

  // /clear starts a new task: the counters start over, and the next prompt marks where its cost starts.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, stats, s => ({ ...EMPTY, costBase: s.costBase, costStart: null }))
      await update($, agents, () => [])
    }
    return next(e)
  })

  // Claude desktop only: the terminal keeps its own band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.surface === 'terminal' || e.props.hasSurvey || u === null) return next(e)

    const list = await read($, agents)
    const rows = cells(u, { ...EMPTY, ...(await read($, stats)) }, await $.clock.now(), list).filter(r => r.length > 0)
    // Other mods share this slot: draw theirs below ours. next(e) rejects only when nothing answers beneath.
    const below = await next(e).catch(() => undefined)
    const { Box, Button, Svg } = $.ui.resolve(e)
    // Every figure in words, for a reader that cannot see the drawing.
    const alt = rows.flat().map(c => [c.label, c.value, c.note, c.sub].filter(Boolean).join(' ')).join('; ')
    // shortcut: the phone's slot taken as 360px wide, read the slot's own width if the engine ever reports it in pixels.
    const width = e.surface === 'mobile' ? 360 : 760
    return (
      <Box flexDirection="column">
        <Svg source={bandSvg(rows, width)} alt={alt} />
        {list.length > 0 ? (
          <Box flexDirection="row">
            <Box flexGrow={1} />
            <Button key="subagents" plain label="Subagent details" onPress={() => openPane($)} />
          </Box>
        ) : null}
        {below}
      </Box>
    )
  })

  // One entry per subagent, newest first: what it was asked, what it ran, what it cost, what it reported.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const u = await read($, usage)
    const s = { ...EMPTY, ...(await read($, stats)) }
    const now = await $.clock.now()
    const subUsd = agentUsd(list)
    const total = u?.cost === undefined ? undefined : spent(u.cost.usd, s)

    return (
      <Box flexDirection="column" gap={1}>
        {list.length === 0 ? (
          <Text dimColor>No subagents in this session yet.</Text>
        ) : (
          <Text>
            Main agent ≈{total === undefined ? '?' : usd(Math.max(0, total - subUsd))} · subagents ≈{usd(subUsd)}
            {total === undefined ? '' : ` (${share(subUsd, total)}% of ${usd(total)})`}
            {unpriced(list) === '' ? '' : ` · ${unpriced(list)}`}
          </Text>
        )}
        {[...list].reverse().map(a => (
          <Box key={a.id} flexDirection="column">
            <Text bold wrap="truncate-end">
              {a.isDone ? '' : 'running · '}
              {a.description}
            </Text>
            <Text dimColor wrap="truncate-end">
              {a.type} · {a.model}
            </Text>
            <Text wrap="truncate-end">
              ≈{a.usd === undefined ? '?' : usd(a.usd)} · {fmtTokens(agentTokens(a))} tokens · {elapsed(runMs(a.ms, now, a.live))}
            </Text>
            <Text dimColor wrap="truncate-end">
              {toolSummary(a.tools)}
            </Text>
            {a.report !== '' && (
              <Text dimColor wrap="truncate-end">
                ↳ {a.report}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
