/**
 * Phase 5 — Onset detection → segment boundaries
 *
 * Uses SuperFluxExtractor in 60-second chunks to avoid WASM heap exhaustion.
 * Returns sorted array of onset times in seconds.
 */

import { SAMPLE_RATE, type DecodedAudio } from './platform.ts'
import { getEssentia } from './essentia-singleton.ts'

const CHUNK_SECS = 60        // max chunk size (WASM heap constraint)
const OVERLAP_SECS = 1.0     // overlap between chunks to catch boundary onsets
const ONSET_THRESHOLD = 0.05 // SuperFlux threshold (~1–5 onsets/sec depending on density)
const MIN_ONSET_GAP = 0.05   // merge onsets closer than 50ms (duplicate detections)

export function detectOnsets(
  audio: DecodedAudio,
  threshold = ONSET_THRESHOLD,
): number[] {
  const essentia = getEssentia()
  const allOnsets: number[] = []
  const { data, duration, sampleRate } = audio

  for (let offset = 0; offset < duration; offset += CHUNK_SECS - OVERLAP_SECS) {
    const chunkDur = Math.min(CHUNK_SECS, duration - offset)
    if (chunkDur < 1) break

    const startSample = Math.round(offset * sampleRate)
    const endSample = Math.min(startSample + Math.round(chunkDur * sampleRate), data.length)
    const chunkData = data.slice(startSample, endSample)

    const vec = essentia.toVec(chunkData)
    const chunkOnsets = essentia.superFluxOnsets(vec, sampleRate, threshold)
    vec.delete()

    // Skip onsets in the overlap region from prior chunk (except first chunk)
    const skipBefore = offset > 0 ? OVERLAP_SECS : 0
    for (const t of chunkOnsets) {
      if (t >= skipBefore) allOnsets.push(t + offset)
    }
  }

  allOnsets.sort((a, b) => a - b)
  return mergeCloseOnsets(allOnsets, MIN_ONSET_GAP)
}

function mergeCloseOnsets(onsets: number[], minGap: number): number[] {
  if (onsets.length === 0) return []
  const merged: number[] = [onsets[0]]
  for (let i = 1; i < onsets.length; i++) {
    if (onsets[i] - merged[merged.length - 1] >= minGap) {
      merged.push(onsets[i])
    }
  }
  return merged
}

/**
 * Convert onset times into segment objects with start/duration.
 * The last segment runs to the end of the track.
 */
export interface SegmentBoundary {
  start: number
  end: number
}

export function buildSegmentBoundaries(
  onsets: number[],
  trackDuration: number,
): SegmentBoundary[] {
  if (onsets.length === 0) {
    return [{ start: 0, end: trackDuration }]
  }
  const boundaries: SegmentBoundary[] = []
  if (onsets[0] > 0) {
    boundaries.push({
      start: 0,
      end: onsets[0],
    })
  }
  for (let i = 0; i < onsets.length; i++) {
    boundaries.push({
      start: onsets[i],
      end: i + 1 < onsets.length ? onsets[i + 1] : trackDuration,
    })
  }
  return boundaries
}
