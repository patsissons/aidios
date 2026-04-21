/**
 * Phase 6 — Per-segment feature extraction
 *
 * Extracts timbre (MFCC), pitches (HPCP), and loudness envelope for each segment.
 * Uses Float32Array slicing from the pre-decoded audio buffer — NO ffmpeg per segment.
 * At ~5ms per segment, 2287 segments ≈ ~15 seconds total.
 */

import { SAMPLE_RATE, type DecodedAudio } from './platform.ts'
import { getEssentia } from './essentia-singleton.ts'
import type { SegmentBoundary } from './segments.ts'
import type { Segment } from '@aidios/types'

const FRAME_SIZE = 2048
const LOUDNESS_BLOCK_SECS = 0.05   // 50ms RMS blocks for loudness envelope
const LOUDNESS_FLOOR_DB = -60

function rmsDb(samples: Float32Array): number {
  if (samples.length === 0) return LOUDNESS_FLOOR_DB
  let s = 0
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i]
  return Math.max(LOUDNESS_FLOOR_DB, 20 * Math.log10(Math.max(Math.sqrt(s / samples.length), 1e-10)))
}

function computeLoudnessEnvelope(segAudio: Float32Array, sampleRate: number): {
  loudnessStart: number
  loudnessMax: number
  loudnessMaxTime: number
  loudnessEnd: number
} {
  const blockSize = Math.floor(sampleRate * LOUDNESS_BLOCK_SECS)
  const loudnessStart = rmsDb(segAudio.slice(0, Math.min(blockSize, segAudio.length)))
  const loudnessEnd = rmsDb(segAudio.slice(Math.max(0, segAudio.length - blockSize)))

  let loudnessMax = -Infinity
  let loudnessMaxTime = 0
  const step = Math.max(1, Math.floor(blockSize / 4))
  for (let i = 0; i + blockSize <= segAudio.length; i += step) {
    const v = rmsDb(segAudio.slice(i, i + blockSize))
    if (v > loudnessMax) {
      loudnessMax = v
      loudnessMaxTime = i / sampleRate
    }
  }
  if (!isFinite(loudnessMax)) loudnessMax = loudnessStart

  return { loudnessStart, loudnessMax, loudnessMaxTime, loudnessEnd }
}

function extractSegmentFeatures(
  audio: DecodedAudio,
  boundary: SegmentBoundary,
  confidence: number,
): Segment {
  const essentia = getEssentia()
  const { sampleRate, data } = audio

  const startSample = Math.round(boundary.start * sampleRate)
  const endSample = Math.min(Math.round(boundary.end * sampleRate), data.length)
  const segAudio = data.slice(startSample, endSample)
  const duration = boundary.end - boundary.start

  // Prepare FRAME_SIZE window (zero-pad if segment is shorter)
  const frame = new Float32Array(FRAME_SIZE)
  frame.set(segAudio.slice(0, Math.min(segAudio.length, FRAME_SIZE)))

  let timbre: number[]
  let pitches: number[]

  if (segAudio.length >= 64) {
    // Enough samples for spectral analysis
    const { timbre: t, pitches: p } = essentia.extractSpectralFeatures(frame, sampleRate, FRAME_SIZE)
    timbre = t
    pitches = p
  } else {
    // Too short — use zeros
    timbre = new Array(12).fill(0)
    pitches = new Array(12).fill(0)
  }

  const loudness = computeLoudnessEnvelope(segAudio, sampleRate)

  return {
    start: boundary.start,
    duration,
    confidence,
    loudness_start: loudness.loudnessStart,
    loudness_max: loudness.loudnessMax,
    loudness_max_time: loudness.loudnessMaxTime,
    loudness_end: loudness.loudnessEnd,
    pitches,
    timbre,
  }
}

/**
 * Extract features for all segments from the pre-decoded audio.
 * Processes sequentially to manage WASM heap pressure.
 */
export function extractAllSegments(
  audio: DecodedAudio,
  boundaries: SegmentBoundary[],
  confidence = 0.8,
): Segment[] {
  return boundaries.map((b) => extractSegmentFeatures(audio, b, confidence))
}
