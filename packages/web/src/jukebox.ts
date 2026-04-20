/**
 * Client-side jukebox engine.
 * Ports remixTrack + calculateNearestNeighbors for the browser.
 * Supports live parameter tuning (threshold, branch filters).
 */

import type {
  AudioAnalysis, JukeboxTrack, Quantum, Edge, Segment, TuneParams,
} from './types'

const MAX_BRANCHES = 4
const PRECALC_MAX_THRESHOLD = 300

// ─── remixTrack ─────────────────────────────────────────────────────────────

export function remixTrack(track: JukeboxTrack): void {
  const a = track.analysis
  const types = ['sections', 'bars', 'beats', 'tatums', 'segments'] as const

  for (const type of types) {
    const list = a[type] as Quantum[]
    for (let i = 0; i < list.length; i++) {
      const q = list[i]
      q.which = i
      q.prev = i > 0 ? list[i - 1] : null
      q.next = i < list.length - 1 ? list[i + 1] : null
    }
  }

  connectQuanta(a, 'sections', 'bars')
  connectQuanta(a, 'bars', 'beats')
  connectQuanta(a, 'beats', 'tatums')
  connectQuanta(a, 'tatums', 'segments')

  for (const t of ['bars', 'beats', 'tatums'] as const) {
    connectFirstOverlappingSegment(a, t)
    connectAllOverlappingSegments(a, t)
  }

  filterSegments(a)
}

function connectQuanta(
  a: JukeboxTrack['analysis'],
  parent: 'sections' | 'bars' | 'beats' | 'tatums',
  child: 'bars' | 'beats' | 'tatums' | 'segments',
): void {
  let last = 0
  const parents = a[parent] as Quantum[]
  const children = a[child] as Quantum[]

  for (const p of parents) {
    p.children = []
    for (let j = last; j < children.length; j++) {
      const c = children[j]
      if (c.start >= p.start && c.start < p.start + p.duration) {
        ;(c as Quantum).parent = p
        ;(c as Quantum).indexInParent = p.children!.length
        p.children!.push(c as Quantum)
        last = j
      } else if (c.start > p.start) {
        break
      }
    }
  }
}

function connectFirstOverlappingSegment(
  a: JukeboxTrack['analysis'],
  name: 'bars' | 'beats' | 'tatums',
): void {
  let last = 0
  const quanta = a[name] as Quantum[]
  for (const q of quanta) {
    for (let j = last; j < a.segments.length; j++) {
      if (a.segments[j].start >= q.start) {
        q.oseg = a.segments[j]
        last = j
        break
      }
    }
  }
}

function connectAllOverlappingSegments(
  a: JukeboxTrack['analysis'],
  name: 'bars' | 'beats' | 'tatums',
): void {
  let last = 0
  const quanta = a[name] as Quantum[]
  for (const q of quanta) {
    q.overlappingSegments = []
    for (let j = last; j < a.segments.length; j++) {
      const s = a.segments[j]
      if (s.start + s.duration < q.start) continue
      if (s.start > q.start + q.duration) break
      last = j
      q.overlappingSegments.push(s)
    }
  }
}

function filterSegments(a: JukeboxTrack['analysis']): void {
  const fsegs: Segment[] = [a.segments[0]]
  for (let i = 1; i < a.segments.length; i++) {
    const seg = a.segments[i]
    const prev = fsegs[fsegs.length - 1]
    if (seg.confidence < 0.3 && timbralDist3(seg, prev) < 1.0) {
      prev.duration += seg.duration
    } else {
      fsegs.push(seg)
    }
  }
  a.fsegments = fsegs
}

function timbralDist3(a: Segment, b: Segment): number {
  let sum = 0
  for (let i = 0; i < 3; i++) {
    const d = b.timbre[i] - a.timbre[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

// ─── calculateNearestNeighbors ──────────────────────────────────────────────

export function calculateNearestNeighbors(
  track: JukeboxTrack,
  maxThreshold: number,
): { lastBranchPoint: number; threshold: number } {
  const beats = track.analysis.beats
  const targetBranches = beats.length / 6

  precalculate(beats, Math.max(maxThreshold, PRECALC_MAX_THRESHOLD))

  let threshold = 10
  let count = 0
  for (; threshold <= maxThreshold; threshold += 5) {
    count = collectNeighbors(beats, threshold)
    if (count >= targetBranches) break
  }

  const lastBranchPoint = postProcess(beats, threshold, maxThreshold)
  return { lastBranchPoint, threshold }
}

function precalculate(beats: Quantum[], maxThreshold: number): void {
  let nextId = 0
  for (const q of beats) {
    const edges: Edge[] = []
    for (const q2 of beats) {
      if (q2.which === q.which) continue
      const segs1 = q.overlappingSegments ?? []
      const segs2 = q2.overlappingSegments ?? []
      let sum = 0
      for (let j = 0; j < segs1.length; j++) {
        if (j < segs2.length) {
          sum += segDistance(segs1[j], segs2[j])
        } else {
          sum += 100
        }
      }
      const pdist = q.indexInParent === q2.indexInParent ? 0 : 100
      const total = (segs1.length > 0 ? sum / segs1.length : 100) + pdist
      if (total < maxThreshold) {
        edges.push({ id: 0, src: q, dest: q2, distance: total })
      }
    }
    edges.sort((a, b) => a.distance - b.distance)
    q.all_neighbors = []
    for (let i = 0; i < MAX_BRANCHES && i < edges.length; i++) {
      edges[i].id = nextId++
      q.all_neighbors.push(edges[i])
    }
  }
}

function segDistance(s1: Segment, s2: Segment): number {
  return (
    weightedEuclid(s1.timbre, s2.timbre) * 1 +
    euclid(s1.pitches, s2.pitches) * 10 +
    Math.abs(s1.loudness_start - s2.loudness_start) * 1 +
    Math.abs(s1.loudness_max - s2.loudness_max) * 1 +
    Math.abs(s1.duration - s2.duration) * 100 +
    Math.abs(s1.confidence - s2.confidence) * 1
  )
}

function weightedEuclid(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) { const d = b[i] - a[i]; sum += d * d }
  return Math.sqrt(sum)
}

function euclid(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) { const d = b[i] - a[i]; sum += d * d }
  return Math.sqrt(sum)
}

function collectNeighbors(beats: Quantum[], maxThreshold: number): number {
  let count = 0
  for (const q of beats) {
    q.neighbors = (q.all_neighbors ?? []).filter((e) => e.distance <= maxThreshold)
    if (q.neighbors.length > 0) count++
  }
  return count
}

function postProcess(beats: Quantum[], threshold: number, maxThreshold: number): number {
  const lbb = longestBackwardBranch(beats)
  insertBestBackwardBranch(beats, threshold, lbb < 50 ? 65 : 55)
  calculateReachability(beats)
  const last = findBestLastBeat(beats)
  filterBadBranches(beats, last)
  return last
}

function longestBackwardBranch(beats: Quantum[]): number {
  let longest = 0
  for (let i = 0; i < beats.length; i++) {
    for (const n of beats[i].neighbors ?? []) {
      const delta = i - n.dest.which
      if (delta > longest) longest = delta
    }
  }
  return (longest * 100) / beats.length
}

function insertBestBackwardBranch(beats: Quantum[], threshold: number, maxTh: number): void {
  let best: [number, Quantum, Edge] | null = null
  for (let i = 0; i < beats.length; i++) {
    for (const n of beats[i].all_neighbors ?? []) {
      const delta = i - n.dest.which
      if (delta > 0 && n.distance < maxTh) {
        const pct = (delta * 100) / beats.length
        if (!best || pct > best[0]) best = [pct, beats[i], n]
      }
    }
  }
  if (best && best[2].distance > threshold) {
    best[1].neighbors!.push(best[2])
  }
}

function calculateReachability(beats: Quantum[]): void {
  for (const q of beats) q.reach = beats.length - q.which
  for (let iter = 0; iter < 1000; iter++) {
    let changes = 0
    for (let i = 0; i < beats.length; i++) {
      const q = beats[i]
      let changed = false
      for (const e of q.neighbors ?? []) {
        if (e.dest.reach! > q.reach!) { q.reach = e.dest.reach; changed = true }
      }
      if (i < beats.length - 1 && beats[i + 1].reach! > q.reach!) {
        q.reach = beats[i + 1].reach; changed = true
      }
      if (changed) {
        changes++
        for (let j = 0; j < i; j++) {
          if (beats[j].reach! < q.reach!) beats[j].reach = q.reach
        }
      }
    }
    if (changes === 0) break
  }
}

function findBestLastBeat(beats: Quantum[]): number {
  let longest = 0, longestReach = 0
  for (let i = beats.length - 1; i >= 0; i--) {
    const dist = beats.length - i
    const reach = ((beats[i].reach! - dist) * 100) / beats.length
    if (reach > longestReach && (beats[i].neighbors?.length ?? 0) > 0) {
      longestReach = reach
      longest = i
      if (reach >= 50) break
    }
  }
  return longest
}

function filterBadBranches(beats: Quantum[], lastIdx: number): void {
  for (let i = 0; i < lastIdx; i++) {
    beats[i].neighbors = (beats[i].neighbors ?? []).filter((e) => e.dest.which < lastIdx)
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function prepareTrack(analysis: AudioAnalysis, threshold: number): JukeboxTrack {
  const track = { analysis: { ...analysis } } as unknown as JukeboxTrack
  remixTrack(track)
  calculateNearestNeighbors(track, threshold)
  return track
}

/** Re-run neighbor collection with a new threshold (fast — no precalc) */
export function updateThreshold(track: JukeboxTrack, threshold: number): { threshold: number; lastBranchPoint: number } {
  const beats = track.analysis.beats
  const targetBranches = beats.length / 6

  let th = 10
  let count = 0
  for (; th <= threshold; th += 5) {
    count = collectNeighbors(beats, th)
    if (count >= targetBranches) break
  }

  const last = postProcess(beats, th, threshold)
  return { threshold: th, lastBranchPoint: last }
}

/** Apply branch filters from tune params */
export function applyBranchFilters(track: JukeboxTrack, params: TuneParams): void {
  const beats = track.analysis.beats
  for (const q of beats) {
    if (!q.neighbors) continue
    q.neighbors = q.neighbors.filter((e) => {
      if (params.reverseOnly && e.dest.which >= q.which) return false
      if (params.longOnly && Math.abs(e.dest.which - q.which) < beats.length * 0.1) return false
      if (params.noSequential && Math.abs(e.dest.which - q.which) === 1) return false
      return true
    })
  }
}

/** Compute stats for the tune panel */
export function computeStats(track: JukeboxTrack): {
  totalBeats: number
  totalBranches: number
  longestLoop: number
  longestLoopPct: number
} {
  const beats = track.analysis.beats
  let totalBranches = 0
  let longestLoop = 0

  for (let i = 0; i < beats.length; i++) {
    const neighbors = beats[i].neighbors ?? []
    totalBranches += neighbors.length
    for (const n of neighbors) {
      const loop = Math.abs(i - n.dest.which)
      if (loop > longestLoop) longestLoop = loop
    }
  }

  return {
    totalBeats: beats.length,
    totalBranches,
    longestLoop,
    longestLoopPct: beats.length > 0 ? Math.round((longestLoop * 100) / beats.length) : 0,
  }
}
