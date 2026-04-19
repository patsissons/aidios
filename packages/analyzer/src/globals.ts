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
 * Fix beat grid issues from RhythmExtractor2013.
 *
 * We intentionally do not extend a partial grid to the end of the track. Synthetic
 * tail beats produce identical/near-identical branch targets in fade-outs and
 * outros, which sounds like a repeated beat during playback.
 */
function fixBeatGrid(beats: number[], duration: number, endOfFadeIn: number): number[] {
  if (beats.length < 2) return beats

  // Compute median spacing (robust against outliers/gaps).
  const spacings: number[] = []
  for (let i = 1; i < beats.length; i++) spacings.push(beats[i] - beats[i - 1])
  spacings.sort((a, b) => a - b)
  let medianSpacing = spacings[Math.floor(spacings.length / 2)]

  let result = [...beats]

  // Half-tempo fix: if median spacing > 0.7s, insert midpoints.
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

  // If the first tick lands right on the fade-in boundary, it is often a pickup
  // or decoder onset rather than the first stable downbeat. Starting the bar grid
  // there shifts every branch target by one beat.
  if (
    result.length > 4
    && result[0] < Math.min(0.75, duration)
    && Math.abs(result[0] - endOfFadeIn) < Math.min(0.08, medianSpacing * 0.2)
  ) {
    result = result.slice(1)
  }

  return trimUnstableTail(result, medianSpacing)
}

function trimUnstableTail(beats: number[], medianSpacing: number): number[] {
  if (beats.length < 8) return beats

  const minSpacing = medianSpacing / 1.18
  const maxSpacing = medianSpacing * 1.18
  const searchStart = Math.floor(beats.length * 0.75)

  for (let i = searchStart; i < beats.length - 1; i++) {
    const spacing = beats[i + 1] - beats[i]
    if (spacing < minSpacing || spacing > maxSpacing) {
      return beats.slice(0, i + 1)
    }
  }

  return beats
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

export function extractGlobalFeatures(
  audio: DecodedAudio,
  rhythmAudio: DecodedAudio = audio,
): GlobalFeatures {
  const essentia = getEssentia()

  // RhythmExtractor2013 has no sample-rate argument in essentia.js and behaves
  // best with 44.1kHz input. Keep the rest of the analysis at SAMPLE_RATE.
  const rhythmVec = essentia.toVec(rhythmAudio.data)

  // Beat extraction
  const rhythm = essentia.rhythmExtractor(rhythmVec)
  rhythmVec.delete()

  // Load full analysis-rate audio into WASM — must be deleted after key extraction
  const vec = essentia.toVec(audio.data)

  // Key/mode extraction
  const key = essentia.keyExtractor(vec, audio.sampleRate)

  // Free WASM heap — critical before any subsequent large allocations
  vec.delete()

  // Plain JS calculations (no WASM needed)
  const overallLoudness = computeOverallLoudness(audio.data)
  const { endOfFadeIn, startOfFadeOut } = detectFades(audio.data, audio.duration)
  const beatTimes = fixBeatGrid(rhythm.beatTimes, audio.duration, endOfFadeIn)

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
