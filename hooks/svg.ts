// The band as one SVG for the surfaces that draw it (desktop, editor, mobile): rings, bars, real 1px dividers.

export type Cell = {
  key: string
  label: string
  value: string
  sub: string
  tone?: 'warning' | 'error'
  // Small text after the value.
  note?: string
  // A ring: fill 0..1, and the part of it this session added, drawn solid at its end.
  ring?: { fill: number; mine?: number }
  bars?: number[]
  dots?: number
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
// The image cannot read the app's theme, so it follows the system's.
const STYLE =
  `.l,.s{fill:#6b6a64;font:12px ${FONT}}.v{fill:#1f1e1d;font:600 20px ${FONT}}.d{stroke:#1f1e1d;stroke-opacity:.12}` +
  `.t{stroke:#1f1e1d;stroke-opacity:.08;fill:none}.a{stroke:#d97757;fill:none}.b{fill:#d97757}.bo{fill:#d97757;fill-opacity:.35}.ao{stroke:#d97757;stroke-opacity:.35;fill:none}` +
  `.o{fill:#1f1e1d;fill-opacity:.08}` +
  `.warning{stroke:#a86400;fill:#a86400}.error{stroke:#c62828;fill:#c62828}.a.warning,.a.error,.ao.warning,.ao.error{fill:none}` +
  `@media (prefers-color-scheme:dark){.l,.s{fill:#9c9b94}.v{fill:#ecebe6}.d,.t{stroke:#fff}.o{fill:#fff;fill-opacity:.1}` +
  `.warning{stroke:#e3a03d;fill:#e3a03d}.error{stroke:#ef6a5a;fill:#ef6a5a}.a.warning,.a.error,.ao.warning,.ao.error{fill:none}}`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fit = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s)

const ROW = 76
// Narrowest column a cell without a note fits in: its value and its bars or dots.
const MIN_COL = 170

// shortcut: the 20px value's width guessed per character, measure in a font table if it drifts.
const valueWidth = (s: string) => [...s].reduce((w, ch) => w + (ch === '%' ? 18 : ch === '.' || ch === ',' ? 6 : 12), 0)
// A note sits between the value and the ring: the column must hold all three.
const need = (c: Cell) => (c.note ? 14 + valueWidth(fit(c.value, 10)) + 6 + c.note.length * 6 + 62 : MIN_COL)

// A row too wide for the band splits into lines of near-equal length.
function wrap(cells: Cell[], width: number): Cell[][] {
  const perLine = Math.max(1, Math.floor(width / Math.max(...cells.map(need))))
  const lines = Math.ceil(cells.length / perLine)
  const size = Math.ceil(cells.length / lines)
  return Array.from({ length: lines }, (_, i) => cells.slice(i * size, (i + 1) * size))
}

function graphic(c: Cell, right: number, top: number): string {
  const tone = c.tone ? ` ${c.tone}` : ''
  if (c.ring) {
    const r = 22
    const cx = right - r - 6
    const cy = top + ROW / 2
    const len = 2 * Math.PI * r
    const fill = Math.min(1, Math.max(0, c.ring.fill))
    const arc = (cls: string, from: number, to: number) =>
      `<circle class="${cls}${tone}" cx="${cx}" cy="${cy}" r="${r}" stroke-width="6" stroke-dasharray="${((to - from) * len).toFixed(1)} ${len.toFixed(1)}" transform="rotate(${(-90 + from * 360).toFixed(1)} ${cx} ${cy})"/>`
    let s = `<circle class="t" cx="${cx}" cy="${cy}" r="${r}" stroke-width="6"/>`
    if (c.ring.mine === undefined) return s + arc('a', 0, fill)
    // Earlier use faint, this session's solid after it.
    const mine = Math.min(fill, Math.max(0, c.ring.mine))
    if (fill - mine > 0) s += arc('ao', 0, fill - mine)
    if (mine > 0) s += arc('a', fill - mine, fill)
    return s
  }
  if (c.bars && c.bars.length > 0) {
    const max = Math.max(...c.bars)
    if (max <= 0) return ''
    const w = 5, gap = 2, h = 30
    const x0 = right - 8 - c.bars.length * (w + gap)
    const base = top + ROW / 2 + h / 2
    return c.bars
      .map((v, i) => {
        const bh = Math.max(2, Math.round((v / max) * h))
        const cls = i === c.bars!.length - 1 ? 'b' : 'bo'
        return `<rect class="${cls}" x="${x0 + i * (w + gap)}" y="${base - bh}" width="${w}" height="${bh}" rx="1.5"/>`
      })
      .join('')
  }
  if (c.dots !== undefined) {
    // One dot per turn, 8 by 3; past 24 the grid stays full. Kept above the subtitle line.
    const cols = 8, rows = 3, step = 8
    const x0 = right - 8 - cols * step
    const y0 = top + 28
    let s = ''
    for (let i = 0; i < cols * rows; i++) {
      const x = x0 + (i % cols) * step
      const y = y0 + Math.floor(i / cols) * step
      s += `<circle class="${i < c.dots ? 'b' : 'o'}" cx="${x}" cy="${y}" r="2.5"/>`
    }
    return s
  }
  return ''
}

function row(cells: Cell[], top: number, width: number): string {
  const colW = width / Math.max(1, cells.length)
  let s = ''
  cells.forEach((c, i) => {
    const left = i * colW
    const x = left + (i === 0 ? 0 : 14)
    const tone = c.tone ? ` ${c.tone}` : ''
    if (i > 0) s += `<line class="d" x1="${left}" y1="${top + 12}" x2="${left}" y2="${top + ROW - 8}"/>`
    s += `<text class="l" x="${x}" y="${top + 22}">${esc(c.label)}</text>`
    const value = fit(c.value, 10)
    s += `<text class="v${tone}" x="${x}" y="${top + 46}">${esc(value)}</text>`
    if (c.note) s += `<text class="s" x="${x + valueWidth(value) + 6}" y="${top + 45}">${esc(c.note)}</text>`
    if (c.sub) s += `<text class="s" x="${x}" y="${top + 64}">${esc(fit(c.sub, Math.floor((colW - 24) / 6.2)))}</text>`
    s += graphic(c, left + colW, top)
  })
  return s
}

export function bandSvg(rows: Cell[][], width = 760): string {
  const shown = rows.filter(r => r.length > 0).flatMap(r => wrap(r, width))
  const height = shown.length * ROW
  let body = ''
  shown.forEach((r, i) => {
    if (i > 0) body += `<line class="d" x1="0" y1="${i * ROW + 0.5}" x2="${width}" y2="${i * ROW + 0.5}"/>`
    body += row(r, i * ROW, width)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${STYLE}</style>${body}</svg>`
}
