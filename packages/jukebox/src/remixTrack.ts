/**
 * TypeScript port of remixTrack.js
 * Source: https://github.com/rigdern/InfiniteJukeboxAlgorithm/blob/master/js/algorithm/remixTrack.js
 * License: MIT (Copyright 2021 UnderMybrella, derived from EternalJukebox)
 *
 * Builds the hierarchical quanta structure with parent/child/prev/next links,
 * overlapping segment associations, and filtered segment list.
 */

import type { AudioAnalysis, Segment } from '@aidios/types'
import type { Quantum, JukeboxTrack } from './types.ts'

export function remixTrack(track: JukeboxTrack): void {
  preprocessTrack(track)
}

function preprocessTrack(track: JukeboxTrack): void {
  const analysis = track.analysis

  const types = ['sections', 'bars', 'beats', 'tatums', 'segments'] as const
  for (const type of types) {
    const qlist = analysis[type] as Quantum[]
    qlist.forEach((q, index) => {
      q.track = track
      q.which = index
      q.prev = index > 0 ? qlist[index - 1] : null
      q.next = index < qlist.length - 1 ? qlist[index + 1] : null
    })
  }

  connectQuanta(analysis, 'sections', 'bars')
  connectQuanta(analysis, 'bars', 'beats')
  connectQuanta(analysis, 'beats', 'tatums')
  connectQuanta(analysis, 'tatums', 'segments')

  connectFirstOverlappingSegment(analysis, 'bars')
  connectFirstOverlappingSegment(analysis, 'beats')
  connectFirstOverlappingSegment(analysis, 'tatums')

  connectAllOverlappingSegments(analysis, 'bars')
  connectAllOverlappingSegments(analysis, 'beats')
  connectAllOverlappingSegments(analysis, 'tatums')

  filterSegments(analysis)
}

function filterSegments(analysis: JukeboxTrack['analysis']): void {
  const threshold = 0.3
  const fsegs: Segment[] = []
  fsegs.push(analysis.segments[0])

  for (let i = 1; i < analysis.segments.length; i++) {
    const seg = analysis.segments[i]
    const last = fsegs[fsegs.length - 1]
    if (isSimilar(seg, last) && seg.confidence < threshold) {
      fsegs[fsegs.length - 1].duration += seg.duration
    } else {
      fsegs.push(seg)
    }
  }

  analysis.fsegments = fsegs
}

function isSimilar(seg1: Segment, seg2: Segment): boolean {
  return timbralDistance(seg1, seg2) < 1.0
}

function timbralDistance(s1: Segment, s2: Segment): number {
  return euclideanDistance3(s1.timbre, s2.timbre)
}

// Only uses first 3 timbre coefficients (as in original)
function euclideanDistance3(v1: number[], v2: number[]): number {
  let sum = 0
  for (let i = 0; i < 3; i++) {
    const delta = v2[i] - v1[i]
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

type QuantumArrayKey = 'sections' | 'bars' | 'beats' | 'tatums' | 'segments'

function connectQuanta(
  analysis: JukeboxTrack['analysis'],
  parent: QuantumArrayKey,
  child: QuantumArrayKey,
): void {
  let last = 0
  const qparents = analysis[parent] as Quantum[]
  const qchildren = analysis[child] as Quantum[]

  for (const qparent of qparents) {
    qparent.children = []
    for (let j = last; j < qchildren.length; j++) {
      const qchild = qchildren[j]
      if (qchild.start >= qparent.start && qchild.start < qparent.start + qparent.duration) {
        qchild.parent = qparent
        qchild.indexInParent = qparent.children.length
        qparent.children.push(qchild)
        last = j
      } else if (qchild.start > qparent.start) {
        break
      }
    }
  }
}

function connectFirstOverlappingSegment(
  analysis: JukeboxTrack['analysis'],
  quantaName: 'bars' | 'beats' | 'tatums',
): void {
  let last = 0
  const quanta = analysis[quantaName] as Quantum[]
  const segs = analysis.segments

  for (const q of quanta) {
    for (let j = last; j < segs.length; j++) {
      const qseg = segs[j]
      if (qseg.start >= q.start) {
        q.oseg = qseg
        last = j
        break
      }
    }
  }
}

function connectAllOverlappingSegments(
  analysis: JukeboxTrack['analysis'],
  quantaName: 'bars' | 'beats' | 'tatums',
): void {
  let last = 0
  const quanta = analysis[quantaName] as Quantum[]
  const segs = analysis.segments

  for (const q of quanta) {
    q.overlappingSegments = []
    for (let j = last; j < segs.length; j++) {
      const qseg = segs[j]
      if (qseg.start + qseg.duration < q.start) continue
      if (qseg.start > q.start + q.duration) break
      last = j
      q.overlappingSegments.push(qseg)
    }
  }
}
