/**
 * Phase 7 — Section detection
 *
 * Detects coarser structural sections (verse, chorus, bridge) by running
 * SuperFluxExtractor at a much higher threshold (10x) than segment detection.
 * Sections are not used by the Infinite Jukebox algorithm for branching,
 * but are required in the AudioAnalysis output format.
 */

import type { Section } from '@aidios/types'
import type { DecodedAudio } from './platform.ts'
import type { GlobalFeatures } from './globals.ts'
import { detectOnsets } from './segments.ts'

// 10x higher threshold than segments → coarser boundaries
const SECTION_ONSET_THRESHOLD = 0.5
const MIN_SECTION_DURATION = 5.0  // merge sections shorter than 5s

export function detectSections(
  audio: DecodedAudio,
  globals: GlobalFeatures,
): Section[] {
  const onsets = detectOnsets(audio, SECTION_ONSET_THRESHOLD)

  // Build raw section boundaries
  const boundaries: Array<{ start: number; end: number }> = []
  for (let i = 0; i < onsets.length; i++) {
    boundaries.push({
      start: onsets[i],
      end: i + 1 < onsets.length ? onsets[i + 1] : audio.duration,
    })
  }

  // Ensure there's at least one section covering the whole track
  if (boundaries.length === 0) {
    boundaries.push({ start: 0, end: audio.duration })
  } else if (boundaries[0].start > 0) {
    boundaries.unshift({ start: 0, end: boundaries[0].start })
  }

  // Merge short sections into the next
  const merged: Array<{ start: number; end: number }> = []
  for (const b of boundaries) {
    if (merged.length > 0 && b.end - b.start < MIN_SECTION_DURATION) {
      merged[merged.length - 1].end = b.end
    } else {
      merged.push({ ...b })
    }
  }

  return merged.map((b) => ({
    start: b.start,
    duration: b.end - b.start,
    confidence: 1.0,
    loudness: globals.overallLoudness,
    tempo: globals.bpm,
    tempo_confidence: globals.bpmConfidence,
    key: globals.keyInt,
    key_confidence: globals.keyConfidence,
    mode: globals.modeInt,
    mode_confidence: globals.modeConfidence,
    time_signature: globals.timeSig,
    time_signature_confidence: 1.0,
  }))
}
