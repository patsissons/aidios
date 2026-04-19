/**
 * Phase 4 — Global feature extraction
 * Extracts: beats, bars, tatums, key, mode, tempo, loudness, fade in/out
 */

import { SAMPLE_RATE, type DecodedAudio } from './decoder.ts'
import { getEssentia } from './essentia.ts'

export const FADE_BLOCK = 512          // ~23ms at 22050Hz
export const SILENCE_DB = -60          // threshold for fade detection
export const DEFAULT_TIME_SIG = 4      // assume 4/4 time

export interface GlobalFeatures {
  bpm: number
  bpmConfidence: number
  bpmEstimates: number[]
  beatTimes: number[]        // seconds for each beat (after half-time fix)
  timeSig: number            // beats per bar (always 4 for now)
  keyInt: number             // 0–11
  keyConfidence: number
  modeInt: number            // 1=major, 0=minor
  modeConfidence: number
  overallLoudness: number    // dBFS
  endOfFadeIn: number        // seconds
  startOfFadeOut: number     // seconds
}

/**
 * Fix beat grid issues from RhythmExtractor2013:
 * 1. If median beat spacing > 0.7s, it tracked at half-tempo → insert midpoints
 * 2. If beats don't cover the full track, extend the grid using median spacing
 *
 * Uses median spacing (not total/count) since beats may not span the full track.
 */
function fixBeatGrid(beats: number[], duration: number): number[] {
  if (beats.length < 2) return beats

  // Compute median spacing (robust against outliers/gaps)
  const spacings: number[] = []
  for (let i = 1; i < beats.length; i++) spacings.push(beats[i] - beats[i - 1])
  spacings.sort((a, b) => a - b)
  let medianSpacing = spacings[Math.floor(spacings.length / 2)]

  let result = [...beats]

  // Half-tempo fix: if median spacing > 0.7s, insert midpoints
  if (medianSpacing > 0.7) {
    const doubled: number[] = []
    for (let i = 0; i < result.length - 1; i++) {
      doubled.push(result[i])
      doubled.push((result[i] + result[i + 1]) / 2)
    }
    doubled.push(result[result.length - 1])
    result = doubled
    medianSpacing /= 2
  }

  // Extend beat grid to cover the full track duration
  const lastBeat = result[result.length - 1]
  if (lastBeat + medianSpacing * 2 < duration) {
    for (let t = lastBeat + medianSpacing; t < duration - medianSpacing / 2; t += medianSpacing) {
      result.push(t)
    }
  }

  return result
}

function computeOverallLoudness(data: Float32Array): number {
  let sumSq = 0
  for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i]
  return 20 * Math.log10(Math.max(Math.sqrt(sumSq / data.length), 1e-10))
}

function detectFades(data: Float32Array, duration: number): { endOfFadeIn: number; startOfFadeOut: number } {
  const silenceLinear = Math.pow(10, SILENCE_DB / 20)
  let endOfFadeIn = 0
  let startOfFadeOut = duration

  for (let i = 0; i + FADE_BLOCK <= data.length; i += FADE_BLOCK) {
    let s = 0
    for (let j = i; j < i + FADE_BLOCK; j++) s += data[j] * data[j]
    if (Math.sqrt(s / FADE_BLOCK) > silenceLinear) {
      endOfFadeIn = i / SAMPLE_RATE
      break
    }
  }

  for (let i = data.length - FADE_BLOCK; i >= 0; i -= FADE_BLOCK) {
    let s = 0
    for (let j = i; j < i + FADE_BLOCK; j++) s += data[j] * data[j]
    if (Math.sqrt(s / FADE_BLOCK) > silenceLinear) {
      startOfFadeOut = (i + FADE_BLOCK) / SAMPLE_RATE
      break
    }
  }

  return { endOfFadeIn, startOfFadeOut }
}

export function extractGlobalFeatures(audio: DecodedAudio): GlobalFeatures {
  const essentia = getEssentia()

  // Load full audio into WASM — must be deleted after global extractions
  const vec = essentia.toVec(audio.data)

  // Beat extraction
  const rhythm = essentia.rhythmExtractor(vec)

  // Key/mode extraction
  const key = essentia.keyExtractor(vec, audio.sampleRate)

  // Free WASM heap — critical before any subsequent large allocations
  vec.delete()

  // Fix beat grid: half-time correction and extend to cover full track
  const beatTimes = fixBeatGrid(rhythm.beatTimes, audio.duration)

  // Plain JS calculations (no WASM needed)
  const overallLoudness = computeOverallLoudness(audio.data)
  const { endOfFadeIn, startOfFadeOut } = detectFades(audio.data, audio.duration)

  return {
    bpm: rhythm.bpm,
    bpmConfidence: Math.min(rhythm.confidence / 5.0, 1.0),  // normalize: raw ~0-5
    bpmEstimates: rhythm.bpmEstimates,
    beatTimes,
    timeSig: DEFAULT_TIME_SIG,
    keyInt: key.keyInt,
    keyConfidence: key.strength,
    modeInt: key.modeInt,
    modeConfidence: key.strength,  // KeyExtractor returns one strength for both
    overallLoudness,
    endOfFadeIn,
    startOfFadeOut,
  }
}

// ─── Beat structure builders ─────────────────────────────────────────────────

export interface TimeIntervalRaw {
  start: number
  duration: number
  confidence: number
}

export function buildBeats(beatTimes: number[], confidence: number): TimeIntervalRaw[] {
  const beats: TimeIntervalRaw[] = []
  for (let i = 0; i < beatTimes.length; i++) {
    const start = beatTimes[i]
    const next = beatTimes[i + 1]
    const duration = next != null ? next - start : (i > 0 ? start - beatTimes[i - 1] : 0.5)
    beats.push({ start, duration, confidence })
  }
  return beats
}

export function buildTatums(beatTimes: number[], confidence: number): TimeIntervalRaw[] {
  // Insert half-beat between each pair of beats
  const tatumTimes: number[] = []
  for (let i = 0; i < beatTimes.length - 1; i++) {
    tatumTimes.push(beatTimes[i])
    tatumTimes.push((beatTimes[i] + beatTimes[i + 1]) / 2)
  }
  if (beatTimes.length > 0) tatumTimes.push(beatTimes[beatTimes.length - 1])

  return buildBeats(tatumTimes, confidence)
}

export function buildBars(beatTimes: number[], timeSig: number, confidence: number): TimeIntervalRaw[] {
  const bars: TimeIntervalRaw[] = []
  for (let i = 0; i < beatTimes.length; i += timeSig) {
    const start = beatTimes[i]
    const endIdx = Math.min(i + timeSig, beatTimes.length - 1)
    const end = beatTimes[endIdx]
    const duration = end - start
    if (duration > 0) bars.push({ start, duration, confidence })
  }
  return bars
}
