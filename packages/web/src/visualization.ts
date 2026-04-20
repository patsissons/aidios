/**
 * Circular beat visualization with branch arcs.
 *
 * Beats are drawn as colored tiles around a circle.
 * Branch arcs connect similar beats with Bezier curves.
 * Current playback beat is highlighted.
 * Hover shows branch arc in blue.
 */

import type { JukeboxTrack, Quantum, Edge, Segment } from './types'

interface TileInfo {
  angle: number
  x: number
  y: number
  color: string
  branchColor: string
}

export class Visualization {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private track: JukeboxTrack | null = null
  private tiles: TileInfo[] = []
  private centerX = 0
  private centerY = 0
  private radius = 0
  private tileWidth = 0
  private cssWidth = 0
  private cssHeight = 0

  private currentBeat = -1
  private hoveredBeat = -1
  private hoveredEdge: Edge | null = null
  private playedBeats = new Map<number, number>() // beat index → play count
  private onSeek: ((beatIndex: number) => void) | null = null

  /** Active branch ping animations */
  private branchPings: { srcIdx: number; destIdx: number; edge: Edge; startTime: number }[] = []
  private animFrameId: number | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.setupInteraction()
  }

  /** Register a callback for when the user clicks a beat to seek */
  onBeatSeek(cb: (beatIndex: number) => void): void {
    this.onSeek = cb
  }

  setTrack(track: JukeboxTrack): void {
    this.track = track
    this.layout()
    this.draw()
  }

  setCurrentBeat(beatIndex: number, isBranch: boolean): void {
    const prevBeat = this.currentBeat
    this.currentBeat = beatIndex
    this.playedBeats.set(beatIndex, (this.playedBeats.get(beatIndex) ?? 0) + 1)

    if (isBranch && prevBeat >= 0 && prevBeat < (this.track?.analysis.beats.length ?? 0)) {
      // Find the edge that was taken (src → dest where dest ≈ beatIndex or dest.next ≈ beatIndex)
      const srcBeat = this.track!.analysis.beats[prevBeat]
      const edge = (srcBeat.neighbors ?? []).find(
        (e) => e.dest.which === beatIndex || e.dest.next?.which === beatIndex,
      )
      if (edge) {
        this.branchPings.push({
          srcIdx: prevBeat,
          destIdx: beatIndex,
          edge,
          startTime: performance.now(),
        })
        this.startAnimation()
      }
    }

    this.draw()
  }

  reset(): void {
    this.currentBeat = -1
    this.playedBeats.clear()
    this.branchPings = []
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId)
      this.animFrameId = null
    }
    this.draw()
  }

  /** Recompute layout and redraw (call after threshold changes) */
  refresh(): void {
    this.draw()
  }

  // ─── Layout ─────────────────────────────────────────────────────────────

  private layout(): void {
    if (!this.track) return

    const dpr = window.devicePixelRatio || 1
    const rawW = Math.min(this.canvas.clientWidth || 900, 900)
    const rawH = Math.min(this.canvas.clientHeight || 600, 600)
    this.cssWidth = Math.max(rawW, 100)
    this.cssHeight = Math.max(rawH, 100)
    this.canvas.width = this.cssWidth * dpr
    this.canvas.height = this.cssHeight * dpr
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    this.centerX = this.cssWidth / 2
    this.centerY = this.cssHeight / 2
    this.radius = Math.min(this.cssWidth, this.cssHeight) * 0.38

    const beats = this.track.analysis.beats
    const n = beats.length
    this.tileWidth = Math.max(2, Math.min(8, (2 * Math.PI * this.radius) / n - 1))

    // Precompute tile positions and colors
    this.tiles = []
    const { tMin, tMax } = this.timbreRange()

    let maxNeighbors = 1
    for (const b of beats) {
      const nc = b.neighbors?.length ?? 0
      if (nc > maxNeighbors) maxNeighbors = nc
    }

    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2 // start at top
      const x = this.centerX + this.radius * Math.cos(angle)
      const y = this.centerY + this.radius * Math.sin(angle)

      const seg = beats[i].overlappingSegments?.[0]
      const color = seg ? this.segmentColor(seg, tMin, tMax) : '#333'

      const nc = beats[i].neighbors?.length ?? 0
      const branchColor = nc > 0
        ? `hsl(${280 + (nc / maxNeighbors) * 40}, 70%, ${40 + nc * 8}%)`
        : '#222'

      this.tiles.push({ angle, x, y, color, branchColor })
    }
  }

  private timbreRange(): { tMin: number[]; tMax: number[] } {
    const tMin = [Infinity, Infinity, Infinity]
    const tMax = [-Infinity, -Infinity, -Infinity]
    for (const seg of this.track!.analysis.segments) {
      for (let i = 0; i < 3; i++) {
        if (seg.timbre[i] < tMin[i]) tMin[i] = seg.timbre[i]
        if (seg.timbre[i] > tMax[i]) tMax[i] = seg.timbre[i]
      }
    }
    return { tMin, tMax }
  }

  private segmentColor(seg: Segment, tMin: number[], tMax: number[]): string {
    // Map timbre coefficients 1,2,3 to RGB (matching EternalJukebox)
    const norm = (v: number, min: number, max: number) =>
      max > min ? Math.round(((v - min) / (max - min)) * 255) : 128
    const r = norm(seg.timbre[1], tMin[1], tMax[1])
    const g = norm(seg.timbre[2], tMin[2], tMax[2])
    const b = norm(seg.timbre[0], tMin[0], tMax[0])
    return `rgb(${r},${g},${b})`
  }

  // ─── Drawing ────────────────────────────────────────────────────────────

  private draw(): void {
    if (!this.track) return
    const ctx = this.ctx

    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight)

    // Background circle (track ring)
    ctx.beginPath()
    ctx.arc(this.centerX, this.centerY, this.radius, 0, Math.PI * 2)
    ctx.strokeStyle = '#1a2030'
    ctx.lineWidth = this.tileWidth + 6
    ctx.stroke()

    // Draw branch arcs (behind tiles)
    this.drawBranchArcs(ctx)

    // Draw tiles
    this.drawTiles(ctx)

    // Draw hovered beat highlight
    if (this.hoveredBeat >= 0 && this.hoveredBeat < this.tiles.length) {
      this.drawHoveredBeat(ctx)
    }

    // Draw hovered edge highlight
    if (this.hoveredEdge) {
      this.drawArc(ctx, this.hoveredEdge, '#4af', 3.5, 1.0)
    }

    // Current beat indicator
    if (this.currentBeat >= 0 && this.currentBeat < this.tiles.length) {
      this.drawCurrentBeat(ctx)
    }

    // Animated branch pings (on top of everything)
    if (this.branchPings.length > 0) {
      this.drawBranchPings(ctx)
    }
  }

  private drawTiles(ctx: CanvasRenderingContext2D): void {
    const beats = this.track!.analysis.beats
    const n = beats.length
    const arcLen = (Math.PI * 2) / n

    for (let i = 0; i < n; i++) {
      const tile = this.tiles[i]
      const playCount = this.playedBeats.get(i) ?? 0

      // Outer ring: segment color
      ctx.beginPath()
      ctx.arc(this.centerX, this.centerY, this.radius, tile.angle - arcLen / 2, tile.angle + arcLen / 2)
      ctx.strokeStyle = tile.color
      ctx.lineWidth = this.tileWidth + 2
      ctx.stroke()

      // Inner ring: branch indicator
      ctx.beginPath()
      ctx.arc(this.centerX, this.centerY, this.radius - this.tileWidth - 2, tile.angle - arcLen / 2, tile.angle + arcLen / 2)
      ctx.strokeStyle = tile.branchColor
      ctx.lineWidth = Math.max(2, this.tileWidth * 0.6)
      ctx.stroke()

      // Play glow
      if (playCount > 0) {
        ctx.beginPath()
        ctx.arc(this.centerX, this.centerY, this.radius + this.tileWidth, tile.angle - arcLen / 2, tile.angle + arcLen / 2)
        ctx.strokeStyle = `rgba(120, 200, 255, ${Math.min(playCount * 0.15, 0.6)})`
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }
  }

  private drawHoveredBeat(ctx: CanvasRenderingContext2D): void {
    const tile = this.tiles[this.hoveredBeat]
    const n = this.tiles.length
    const arcLen = (Math.PI * 2) / n

    // Glow behind the hovered tile
    ctx.beginPath()
    ctx.arc(this.centerX, this.centerY, this.radius, tile.angle - arcLen, tile.angle + arcLen)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
    ctx.lineWidth = this.tileWidth + 8
    ctx.stroke()

    // Bright dot on the hovered beat
    ctx.beginPath()
    ctx.arc(tile.x, tile.y, 3, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
    ctx.fill()
  }

  private drawBranchArcs(ctx: CanvasRenderingContext2D): void {
    const beats = this.track!.analysis.beats
    for (const q of beats) {
      for (const edge of q.neighbors ?? []) {
        if (edge === this.hoveredEdge) continue // drawn on top later
        const alpha = 0.15 + (1 - edge.distance / 80) * 0.2
        this.drawArc(ctx, edge, 'rgba(180, 140, 220, ' + alpha + ')', 1.5, 1)
      }
    }
  }

  private drawArc(ctx: CanvasRenderingContext2D, edge: Edge, color: string, width: number, alpha: number): void {
    const t1 = this.tiles[edge.src.which]
    const t2 = this.tiles[edge.dest.which]
    if (!t1 || !t2) return

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.moveTo(t1.x, t1.y)
    ctx.quadraticCurveTo(this.centerX, this.centerY, t2.x, t2.y)
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
    ctx.restore()
  }

  private drawCurrentBeat(ctx: CanvasRenderingContext2D): void {
    const tile = this.tiles[this.currentBeat]
    const n = this.tiles.length
    const arcLen = (Math.PI * 2) / n

    // Bright highlight on current beat
    ctx.beginPath()
    ctx.arc(this.centerX, this.centerY, this.radius, tile.angle - arcLen, tile.angle + arcLen)
    ctx.strokeStyle = '#4af'
    ctx.lineWidth = this.tileWidth + 6
    ctx.stroke()

    // Pulsing dot
    ctx.beginPath()
    ctx.arc(tile.x, tile.y, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#fff'
    ctx.fill()
  }

  // ─── Branch ping animation ──────────────────────────────────────────────

  private static PING_DURATION_MS = 800

  private startAnimation(): void {
    if (this.animFrameId !== null) return
    const animate = () => {
      const now = performance.now()
      this.branchPings = this.branchPings.filter(
        (p) => now - p.startTime < Visualization.PING_DURATION_MS,
      )
      if (this.branchPings.length === 0) {
        this.animFrameId = null
        this.draw()
        return
      }
      this.draw()
      this.animFrameId = requestAnimationFrame(animate)
    }
    this.animFrameId = requestAnimationFrame(animate)
  }

  private drawBranchPings(ctx: CanvasRenderingContext2D): void {
    const now = performance.now()
    for (const ping of this.branchPings) {
      const elapsed = now - ping.startTime
      const progress = elapsed / Visualization.PING_DURATION_MS
      if (progress >= 1) continue

      const alpha = 1 - progress
      const expand = progress * 12

      // Highlight the branch arc
      this.drawArc(ctx, ping.edge, `rgba(80, 220, 255, ${alpha * 0.8})`, 2.5 + expand * 0.2, 1)

      // Ping ring at destination beat
      const destTile = this.tiles[ping.destIdx]
      if (destTile) {
        ctx.beginPath()
        ctx.arc(destTile.x, destTile.y, 4 + expand, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(80, 220, 255, ${alpha})`
        ctx.lineWidth = 2.5 * (1 - progress * 0.5)
        ctx.stroke()
      }

      // Ping ring at source beat
      const srcTile = this.tiles[ping.srcIdx]
      if (srcTile) {
        ctx.beginPath()
        ctx.arc(srcTile.x, srcTile.y, 4 + expand * 0.6, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 160, 80, ${alpha * 0.7})`
        ctx.lineWidth = 2 * (1 - progress * 0.5)
        ctx.stroke()
      }
    }
  }

  // ─── Arc hit testing ────────────────────────────────────────────────────

  /** Sample points along a quadratic Bezier and return min distance² to (mx,my) */
  private distToArc(edge: Edge, mx: number, my: number): number {
    const t1 = this.tiles[edge.src.which]
    const t2 = this.tiles[edge.dest.which]
    if (!t1 || !t2) return Infinity

    const cx = this.centerX
    const cy = this.centerY
    let minD2 = Infinity

    // Sample 16 points along the quadratic curve
    for (let s = 0; s <= 16; s++) {
      const t = s / 16
      const u = 1 - t
      const px = u * u * t1.x + 2 * u * t * cx + t * t * t2.x
      const py = u * u * t1.y + 2 * u * t * cy + t * t * t2.y
      const dx = mx - px
      const dy = my - py
      const d2 = dx * dx + dy * dy
      if (d2 < minD2) minD2 = d2
    }

    return minD2
  }

  // ─── Interaction ────────────────────────────────────────────────────────

  private setupInteraction(): void {
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e))
    this.canvas.addEventListener('mouseleave', () => {
      this.hoveredBeat = -1
      this.hoveredEdge = null
      this.draw()
    })
    this.canvas.addEventListener('click', (e) => this.onClick(e))
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.track) return

    const rect = this.canvas.getBoundingClientRect()
    const scaleX = this.cssWidth / rect.width
    const scaleY = this.cssHeight / rect.height
    const mx = (e.clientX - rect.left) * scaleX
    const my = (e.clientY - rect.top) * scaleY

    // Find closest beat tile
    let closestBeat = -1
    let closestDist = Infinity
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i]
      const dx = mx - t.x
      const dy = my - t.y
      const d = dx * dx + dy * dy
      if (d < closestDist && d < 600) { // within ~24px
        closestDist = d
        closestBeat = i
      }
    }

    // Find closest arc across ALL edges (not just the hovered beat's edges)
    let closestEdge: Edge | null = null
    const arcThreshold = 100 // ~10px distance
    let bestArcDist = arcThreshold

    const beats = this.track.analysis.beats
    for (const q of beats) {
      for (const edge of q.neighbors ?? []) {
        const d2 = this.distToArc(edge, mx, my)
        if (d2 < bestArcDist) {
          bestArcDist = d2
          closestEdge = edge
        }
      }
    }

    if (closestBeat !== this.hoveredBeat || closestEdge !== this.hoveredEdge) {
      this.hoveredBeat = closestBeat
      this.hoveredEdge = closestEdge
      this.draw()
    }
  }

  private onClick(e: MouseEvent): void {
    if (!this.track || this.tiles.length === 0) return

    const rect = this.canvas.getBoundingClientRect()
    const scaleX = this.cssWidth / rect.width
    const scaleY = this.cssHeight / rect.height
    const mx = (e.clientX - rect.left) * scaleX
    const my = (e.clientY - rect.top) * scaleY

    // Convert click position to angle, then to beat index
    const dx = mx - this.centerX
    const dy = my - this.centerY
    const dist = Math.sqrt(dx * dx + dy * dy)

    // Only respond to clicks near the ring
    if (dist < this.radius * 0.6 || dist > this.radius * 1.4) return

    let angle = Math.atan2(dy, dx) + Math.PI / 2 // offset to match layout (starts at top)
    if (angle < 0) angle += Math.PI * 2

    const n = this.tiles.length
    const beatIndex = Math.round((angle / (Math.PI * 2)) * n) % n

    this.onSeek?.(beatIndex)
  }
}
