/**
 * TypeScript port of calculateNearestNeighbors.js
 * Source: https://github.com/rigdern/InfiniteJukeboxAlgorithm/blob/master/js/algorithm/calculateNearestNeighbors.js
 * License: MIT (Copyright 2021 UnderMybrella, derived from EternalJukebox)
 *
 * Builds a similarity graph over beats. Each beat gets up to 4 neighbors
 * (other beats that sound similar). Branching during playback happens at beats
 * that have neighbors below the distance threshold.
 *
 * Distance weights (per segment pair):
 *   timbre:          weight=1   (weighted euclidean over 12 coefficients)
 *   pitches:         weight=10  (euclidean over 12 chroma values)
 *   loudness_start:  weight=1   (absolute difference)
 *   loudness_max:    weight=1   (absolute difference)
 *   duration:        weight=100 (absolute difference in seconds)
 *   confidence:      weight=1   (absolute difference)
 *   bar position:    +100 if indexInParent differs (penalizes cross-bar-position branches)
 */

import type { Segment } from '@aidios/types'
import type { JukeboxTrack, Edge, Quantum, NearestNeighborResult } from './types.ts'

const MAX_BRANCHES = 4
const MAX_BRANCH_THRESHOLD = 80

const timbreWeight = 1
const pitchWeight = 10
const loudStartWeight = 1
const loudMaxWeight = 1
const durationWeight = 100
const confidenceWeight = 1

export function calculateNearestNeighbors(track: JukeboxTrack): NearestNeighborResult {
  if (!track) throw new Error('track is null')
  return dynamicCalculateNearestNeighbors('beats')

  // ─── Inner functions (closure over track) ─────────────────────────────────

  function dynamicCalculateNearestNeighbors(type: 'beats'): NearestNeighborResult {
    const quanta = track.analysis[type]
    const targetBranchCount = quanta.length / 6

    precalculateNearestNeighbors(type, MAX_BRANCHES, MAX_BRANCH_THRESHOLD)

    let count = 0
    let threshold = 10
    for (; threshold < MAX_BRANCH_THRESHOLD; threshold += 5) {
      count = collectNearestNeighbors(type, threshold)
      if (count >= targetBranchCount) break
    }

    const lastBranchPoint = postProcessNearestNeighbors(type, threshold)
    return { lastBranchPoint }
  }

  function precalculateNearestNeighbors(type: 'beats', maxNeighbors: number, maxThreshold: number): void {
    const quanta = track.analysis[type]
    if ('all_neighbors' in quanta[0]) return  // already done

    let nextEdgeId = 0
    for (let qi = 0; qi < quanta.length; qi++) {
      const q1 = quanta[qi]
      nextEdgeId = calculateNearestNeighborsForQuantum(type, maxNeighbors, maxThreshold, q1, nextEdgeId)
    }
  }

  function calculateNearestNeighborsForQuantum(
    type: 'beats',
    maxNeighbors: number,
    maxThreshold: number,
    q1: Quantum,
    nextEdgeId: number,
  ): number {
    const quanta = track.analysis[type]
    const edges: Edge[] = []

    for (let i = 0; i < quanta.length; i++) {
      if (i === q1.which) continue
      const q2 = quanta[i]

      let sum = 0
      const segs1 = q1.overlappingSegments ?? []
      const segs2 = q2.overlappingSegments ?? []

      for (let j = 0; j < segs1.length; j++) {
        const seg1 = segs1[j]
        let distance = 100
        if (j < segs2.length) {
          const seg2 = segs2[j]
          distance = seg1.which === (seg2 as Segment & { which?: number }).which
            ? 100
            : getSegDistance(seg1, seg2)
        }
        sum += distance
      }

      const pdistance = q1.indexInParent === q2.indexInParent ? 0 : 100
      const totalDistance = (segs1.length > 0 ? sum / segs1.length : 100) + pdistance

      if (totalDistance < maxThreshold) {
        edges.push({ id: edges.length, src: q1, dest: q2, distance: totalDistance })
      }
    }

    edges.sort((a, b) => a.distance - b.distance)

    q1.all_neighbors = []
    for (let i = 0; i < maxNeighbors && i < edges.length; i++) {
      const edge = edges[i]
      edge.id = nextEdgeId++
      q1.all_neighbors.push(edge)
    }

    return nextEdgeId
  }

  function getSegDistance(seg1: Segment, seg2: Segment): number {
    const timbre = weightedEuclidean(seg1.timbre, seg2.timbre)
    const pitch = euclidean(seg1.pitches, seg2.pitches)
    const sloudStart = Math.abs(seg1.loudness_start - seg2.loudness_start)
    const sloudMax = Math.abs(seg1.loudness_max - seg2.loudness_max)
    const duration = Math.abs(seg1.duration - seg2.duration)
    const confidence = Math.abs(seg1.confidence - seg2.confidence)
    return (
      timbre * timbreWeight +
      pitch * pitchWeight +
      sloudStart * loudStartWeight +
      sloudMax * loudMaxWeight +
      duration * durationWeight +
      confidence * confidenceWeight
    )
  }

  function weightedEuclidean(v1: number[], v2: number[]): number {
    let sum = 0
    for (let i = 0; i < v1.length; i++) {
      const delta = v2[i] - v1[i]
      sum += delta * delta  // weight=1.0 for all coefficients
    }
    return Math.sqrt(sum)
  }

  function euclidean(v1: number[], v2: number[]): number {
    let sum = 0
    for (let i = 0; i < v1.length; i++) {
      const delta = v2[i] - v1[i]
      sum += delta * delta
    }
    return Math.sqrt(sum)
  }

  function collectNearestNeighbors(type: 'beats', maxThreshold: number): number {
    const quanta = track.analysis[type]
    let branchingCount = 0
    for (const q of quanta) {
      q.neighbors = (q.all_neighbors ?? []).filter((e) => e.distance <= maxThreshold)
      if (q.neighbors.length > 0) branchingCount++
    }
    return branchingCount
  }

  function postProcessNearestNeighbors(type: 'beats', threshold: number): number {
    if (longestBackwardBranch(type) < 50) {
      insertBestBackwardBranch(type, threshold, 65)
    } else {
      insertBestBackwardBranch(type, threshold, 55)
    }
    calculateReachability(type)
    const lastBranchPoint = findBestLastBeat(type)
    filterOutBadBranches(type, lastBranchPoint)
    return lastBranchPoint
  }

  function longestBackwardBranch(type: 'beats'): number {
    const quanta = track.analysis[type]
    let longest = 0
    for (let i = 0; i < quanta.length; i++) {
      for (const neighbor of quanta[i].neighbors ?? []) {
        const delta = i - neighbor.dest.which
        if (delta > longest) longest = delta
      }
    }
    return (longest * 100) / quanta.length
  }

  function insertBestBackwardBranch(type: 'beats', threshold: number, maxThreshold: number): void {
    const quanta = track.analysis[type]
    const branches: Array<[number, number, number, Quantum, Edge]> = []

    for (let i = 0; i < quanta.length; i++) {
      const q = quanta[i]
      for (const neighbor of q.all_neighbors ?? []) {
        const delta = i - neighbor.dest.which
        if (delta > 0 && neighbor.distance < maxThreshold) {
          const percent = (delta * 100) / quanta.length
          branches.push([percent, i, neighbor.dest.which, q, neighbor])
        }
      }
    }

    if (branches.length === 0) return

    branches.sort((a, b) => b[0] - a[0])
    const [, , , bestQ, bestNeighbor] = branches[0]
    if (bestNeighbor.distance > threshold) {
      bestQ.neighbors!.push(bestNeighbor)
    }
  }

  function calculateReachability(type: 'beats'): void {
    const quanta = track.analysis[type]
    for (const q of quanta) q.reach = quanta.length - q.which

    for (let iter = 0; iter < 1000; iter++) {
      let changeCount = 0
      for (let qi = 0; qi < quanta.length; qi++) {
        const q = quanta[qi]
        let changed = false

        for (const e of q.neighbors ?? []) {
          if (e.dest.reach! > q.reach!) {
            q.reach = e.dest.reach
            changed = true
          }
        }

        if (qi < quanta.length - 1) {
          const q2 = quanta[qi + 1]
          if (q2.reach! > q.reach!) {
            q.reach = q2.reach
            changed = true
          }
        }

        if (changed) {
          changeCount++
          for (let j = 0; j < q.which; j++) {
            if (quanta[j].reach! < q.reach!) quanta[j].reach = q.reach
          }
        }
      }
      if (changeCount === 0) break
    }
  }

  function findBestLastBeat(type: 'beats'): number {
    const quanta = track.analysis[type]
    const reachThreshold = 50
    let longest = 0
    let longestReach = 0

    for (let i = quanta.length - 1; i >= 0; i--) {
      const q = quanta[i]
      const distanceToEnd = quanta.length - i
      const reach = ((q.reach! - distanceToEnd) * 100) / quanta.length

      if (reach > longestReach && (q.neighbors?.length ?? 0) > 0) {
        longestReach = reach
        longest = i
        if (reach >= reachThreshold) break
      }
    }
    return longest
  }

  function filterOutBadBranches(type: 'beats', lastIndex: number): void {
    const quanta = track.analysis[type]
    for (let i = 0; i < lastIndex; i++) {
      const q = quanta[i]
      q.neighbors = (q.neighbors ?? []).filter((e) => e.dest.which < lastIndex)
    }
  }
}
