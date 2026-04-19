/**
 * Spike: full end-to-end validation of essentia.js pipeline against test.mp4
 *
 * Key findings from investigation:
 * - SuperFluxExtractor(signal, combine, frameSize, hopSize, ratioThreshold, sampleRate, threshold)
 * - WASM heap OOM if large vector stays alive during subsequent allocations → delete() after use
 * - threshold=0.01 → ~3 segs/sec, avg 0.32s (Spotify-like density)
 * - 516 beats for 486s at 128 BPM (half-time detection, ~64 effective BPM detected)
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const AUDIO_FILE = path.resolve(__dirname, '../test.mp4')
const SAMPLE_RATE = 22050
const FRAME_SIZE = 2048
const HOP_SIZE = 256           // SuperFlux default
const ONSET_THRESHOLD = 0.05  // ~1 onset/sec base; will merge close onsets
const CHUNK_SECS = 60          // Process in 60s chunks to avoid WASM OOM

const KEY_MAP = {
  C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11
}

const { EssentiaWASM, Essentia } = require('essentia.js')
const essentia = new Essentia(EssentiaWASM)
console.log(`✓ Essentia ${essentia.version} (${essentia.algorithmNames.split(',').length} algorithms)\n`)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function decodeAudio(offsetSecs, durationSecs) {
  const args = ['-i', AUDIO_FILE]
  if (offsetSecs > 0) args.push('-ss', String(offsetSecs))
  if (durationSecs != null) args.push('-t', String(durationSecs))
  args.push('-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-acodec', 'pcm_f32le', 'pipe:1')
  const r = spawnSync('ffmpeg', args, { maxBuffer: 300 * 1024 * 1024 })
  if (r.status !== 0) throw new Error('ffmpeg failed')
  const raw = r.stdout
  const audio = new Float32Array(raw.byteLength / 4)
  for (let i = 0; i < audio.length; i++) audio[i] = raw.readFloatLE(i * 4)
  return audio
}

function toVec(audio) { return essentia.arrayToVector(audio) }
function fromVec(vec) { return Array.from(essentia.vectorToArray(vec)) }

function rmsDb(samples) {
  let s = 0
  for (let i = 0; i < samples.length; i++) s += samples[i] ** 2
  return 20 * Math.log10(Math.max(Math.sqrt(s / samples.length), 1e-10))
}

// ─── Phase 1: Global analysis (beats, key, loudness) ─────────────────────────

const T_TOTAL = Date.now()
console.log('── Phase 1: Global analysis ──────────────────────────────────')
const fullAudio = decodeAudio(0, null)
const totalDuration = fullAudio.length / SAMPLE_RATE
console.log(`  Audio: ${fullAudio.length.toLocaleString()} samples, ${totalDuration.toFixed(2)}s`)

let vec = toVec(fullAudio)

// Beats
let t = Date.now()
const rhythm = essentia.RhythmExtractor2013(vec)
const bpm = rhythm.bpm
const beatTimes = fromVec(rhythm.ticks)
console.log(`  Beats: ${beatTimes.length} @ ${bpm.toFixed(2)} BPM (confidence ${rhythm.confidence.toFixed(2)}) [${Date.now()-t}ms]`)

// Key
t = Date.now()
const keyRes = essentia.KeyExtractor(vec, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate', SAMPLE_RATE, 0.0001, 440, 'cosine', 'hann')
const keyInt = KEY_MAP[keyRes.key] ?? -1
const modeInt = keyRes.scale === 'major' ? 1 : 0
console.log(`  Key: ${keyRes.key} ${keyRes.scale} (${keyInt}, ${modeInt}) strength=${keyRes.strength.toFixed(3)} [${Date.now()-t}ms]`)

// Loudness
let sumSq = 0
for (let i = 0; i < fullAudio.length; i++) sumSq += fullAudio[i] ** 2
const overallLoudness = 20 * Math.log10(Math.max(Math.sqrt(sumSq / fullAudio.length), 1e-10))
console.log(`  Loudness: ${overallLoudness.toFixed(3)} dBFS`)

// Fade in/out: scan RMS in 512-sample blocks (StartStopSilence takes single frames, not full signal)
const FADE_BLOCK = 512
const silenceLinear = Math.pow(10, -60 / 20)
let endOfFadeIn = 0, startOfFadeOut = totalDuration
for (let i = 0; i + FADE_BLOCK <= fullAudio.length; i += FADE_BLOCK) {
  let s = 0; for (let j = i; j < i + FADE_BLOCK; j++) s += fullAudio[j] ** 2
  if (Math.sqrt(s / FADE_BLOCK) > silenceLinear) { endOfFadeIn = i / SAMPLE_RATE; break }
}
for (let i = fullAudio.length - FADE_BLOCK; i >= 0; i -= FADE_BLOCK) {
  let s = 0; for (let j = i; j < i + FADE_BLOCK; j++) s += fullAudio[j] ** 2
  if (Math.sqrt(s / FADE_BLOCK) > silenceLinear) { startOfFadeOut = (i + FADE_BLOCK) / SAMPLE_RATE; break }
}
console.log(`  Fade in: ${endOfFadeIn.toFixed(3)}s, Fade out starts: ${startOfFadeOut.toFixed(3)}s`)

// Free the full audio vector — critical for subsequent WASM operations
vec.delete()
vec = null
console.log(`  Vector freed\n`)

// ─── Derived beat structures ───────────────────────────────────────────────────

// Tatums: insert half-beat between each pair
const tatumTimes = []
for (let i = 0; i < beatTimes.length - 1; i++) {
  tatumTimes.push(beatTimes[i])
  tatumTimes.push((beatTimes[i] + beatTimes[i + 1]) / 2)
}
if (beatTimes.length > 0) tatumTimes.push(beatTimes[beatTimes.length - 1])

// Bars: group every 4 beats (time_signature = 4)
const TIME_SIG = 4
const bars = []
for (let i = 0; i < beatTimes.length; i += TIME_SIG) {
  const end = beatTimes[Math.min(i + TIME_SIG, beatTimes.length - 1)]
  bars.push({ start: beatTimes[i], duration: end - beatTimes[i], confidence: rhythm.confidence })
}

console.log(`  Bars: ${bars.length}, Beats: ${beatTimes.length}, Tatums: ${tatumTimes.length}`)

// ─── Phase 2: Onset detection (chunked) ───────────────────────────────────────

console.log('\n── Phase 2: Onset detection (chunked) ────────────────────────')
t = Date.now()
const allOnsets = []
const OVERLAP = 1.0  // 1s overlap between chunks

for (let offset = 0; offset < totalDuration; offset += CHUNK_SECS - OVERLAP) {
  const chunkDur = Math.min(CHUNK_SECS, totalDuration - offset)
  if (chunkDur < 1) break

  const chunk = decodeAudio(offset, chunkDur)
  const cv = toVec(chunk)
  // SuperFluxExtractor(signal, combine=20, frameSize=2048, hopSize=256, ratioThreshold=16, sampleRate, threshold)
  const sf = essentia.SuperFluxExtractor(cv, 20, FRAME_SIZE, HOP_SIZE, 16, SAMPLE_RATE, ONSET_THRESHOLD)
  const chunkOnsets = fromVec(sf.onsets)
  cv.delete()

  const skipBefore = offset > 0 ? OVERLAP : 0
  let added = 0
  for (const ot of chunkOnsets) {
    if (ot >= skipBefore) { allOnsets.push(ot + offset); added++ }
  }
  process.stdout.write(`  [${offset.toFixed(0)}s] chunk onsets: ${chunkOnsets.length} (added ${added})\r`)
}

console.log(`  Total onset boundaries: ${allOnsets.length} [${Date.now()-t}ms]                    `)
console.log(`  Avg segment duration: ${(totalDuration / allOnsets.length).toFixed(3)}s`)
console.log(`  First 10: ${allOnsets.slice(0, 10).map(t => t.toFixed(3)).join(', ')}s`)

// ─── Phase 3: Per-segment feature extraction ──────────────────────────────────

console.log('\n── Phase 3: Per-segment features (sample 10 segments) ────────')
t = Date.now()

// Build segment list from onsets
const segments = []
for (let i = 0; i < allOnsets.length; i++) {
  const start = allOnsets[i]
  const end = i + 1 < allOnsets.length ? allOnsets[i + 1] : totalDuration
  segments.push({ start, duration: end - start })
}

// Process 10 evenly-spaced sample segments to validate feature extraction
const sampleIndices = Array.from({ length: 10 }, (_, i) => Math.floor(i * segments.length / 10))

console.log(`  Processing ${sampleIndices.length} sample segments...`)
const extractedSegments = []

for (const idx of sampleIndices) {
  const seg = segments[idx]

  // Decode the segment's audio
  const segAudio = decodeAudio(seg.start, seg.duration)
  if (segAudio.length < FRAME_SIZE) continue

  // Frame for spectral analysis (first FRAME_SIZE samples or zero-padded)
  const frame = new Float32Array(FRAME_SIZE)
  frame.set(segAudio.slice(0, Math.min(segAudio.length, FRAME_SIZE)))
  const fv = toVec(frame)

  // Windowing → Spectrum
  const windowed = essentia.Windowing(fv, true, FRAME_SIZE, 'hann', false)
  const spectrum = essentia.Spectrum(windowed.frame, FRAME_SIZE)
  fv.delete()
  windowed.frame.delete()

  // MFCC: (spectrum, dctType=2, highFrequencyBound=11000, inputSize=1025, liftering=0,
  //        logType='dbamp', lowFrequencyBound=0, normalize='unit_sum', numberBands=40,
  //        numberCoefficients=13, sampleRate=44100, silenceThreshold=1e-10, type='power',
  //        warpingFormula='htkMel', weighting='warping')
  const mfccRes = essentia.MFCC(
    spectrum.spectrum,
    2, SAMPLE_RATE / 2, FRAME_SIZE / 2 + 1, 0, 'dbamp', 0, 'unit_sum', 40, 13, SAMPLE_RATE
  )
  const timbre = fromVec(mfccRes.mfcc).slice(0, 12)
  mfccRes.mfcc.delete()
  mfccRes.bands.delete()

  // SpectralPeaks: (spectrum, magnitudeThreshold=0, maxFrequency=5000, maxPeaks=100,
  //                 minFrequency=0, orderBy='frequency', sampleRate=44100)
  const peaks = essentia.SpectralPeaks(
    spectrum.spectrum, 0, SAMPLE_RATE / 2, 100, 0, 'magnitude', SAMPLE_RATE
  )

  // HPCP: (frequencies, magnitudes, bandPreset=true, bandSplitFrequency=500, harmonics=0,
  //        maxFrequency=5000, maxShifted=false, minFrequency=40, nonLinear=false,
  //        normalized='unitMax', referenceFrequency=440, sampleRate=44100, size=12,
  //        weightType='squaredCosine', windowSize=1)
  const hpcpRes = essentia.HPCP(
    peaks.frequencies, peaks.magnitudes,
    true, 500, 0, SAMPLE_RATE / 2, false, 40, false, 'unitMax', 440, SAMPLE_RATE, 12
  )
  // 'unitMax' already normalizes max to 1.0 — matches Spotify pitches convention
  const pitches = fromVec(hpcpRes.hpcp)
  peaks.frequencies.delete(); peaks.magnitudes.delete()
  hpcpRes.hpcp.delete()
  spectrum.spectrum.delete()

  // Loudness envelope
  const BLOCK = Math.floor(SAMPLE_RATE * 0.05)
  const loudnessStart = rmsDb(segAudio.slice(0, Math.min(BLOCK, segAudio.length)))
  const loudnessEnd = rmsDb(segAudio.slice(Math.max(0, segAudio.length - BLOCK)))
  let loudnessMax = -Infinity, loudnessMaxTime = 0
  const step = Math.max(1, Math.floor(BLOCK / 4))
  for (let i = 0; i + BLOCK <= segAudio.length; i += step) {
    const v = rmsDb(segAudio.slice(i, i + BLOCK))
    if (v > loudnessMax) { loudnessMax = v; loudnessMaxTime = i / SAMPLE_RATE }
  }

  extractedSegments.push({
    index: idx,
    start: seg.start,
    duration: seg.duration,
    confidence: 0.8,  // placeholder — will derive from onset strength later
    loudness_start: loudnessStart,
    loudness_max: loudnessMax,
    loudness_max_time: loudnessMaxTime,
    loudness_end: loudnessEnd,
    pitches,
    timbre,
  })
}

console.log(`  Done in ${Date.now()-t}ms\n`)
console.log('  Sample segment analysis:')
console.log('  idx  start    dur   l_start l_max  l_end  pitches[0..2]      timbre[0..2]')
for (const s of extractedSegments) {
  const p = s.pitches.slice(0,3).map(v=>v.toFixed(2)).join(' ')
  const tm = s.timbre.slice(0,3).map(v=>v.toFixed(1)).join(' ')
  console.log(`  ${String(s.index).padStart(3)}  ${s.start.toFixed(2).padStart(6)}s  ${s.duration.toFixed(2).padStart(4)}s  ${s.loudness_start.toFixed(1).padStart(7)}  ${s.loudness_max.toFixed(1).padStart(5)}  ${s.loudness_end.toFixed(1).padStart(5)}  [${p}]  [${tm}]`)
}

// ─── Final summary ────────────────────────────────────────────────────────────

console.log('\n── Summary ───────────────────────────────────────────────────')
console.log(`  Duration:             ${totalDuration.toFixed(2)}s`)
console.log(`  BPM:                  ${bpm.toFixed(2)}`)
console.log(`  Key:                  ${keyRes.key} ${keyRes.scale} (int: ${keyInt}, mode: ${modeInt})`)
console.log(`  Overall loudness:     ${overallLoudness.toFixed(2)} dBFS`)
console.log(`  Fade in ends:         ${endOfFadeIn.toFixed(3)}s`)
console.log(`  Fade out starts:      ${startOfFadeOut.toFixed(3)}s`)
console.log(`  Beats:                ${beatTimes.length}`)
console.log(`  Tatums:               ${tatumTimes.length}`)
console.log(`  Bars:                 ${bars.length}`)
console.log(`  Segments (onsets):    ${allOnsets.length}`)
console.log(`  Avg seg duration:     ${(totalDuration / allOnsets.length).toFixed(3)}s`)
console.log(`\n  Infinite Jukebox readiness:`)
console.log(`    beats/6 target:     ${Math.floor(beatTimes.length / 6)} beats need at least 1 neighbor`)
console.log(`    avg segs/beat:      ${(allOnsets.length / beatTimes.length).toFixed(1)} (more = better discrimination)`)
console.log(`    timbre[0] range:    ${extractedSegments.map(s=>s.timbre[0].toFixed(1)).join(', ')}`)
console.log(`\n  ✓ Total spike time: ${((Date.now() - T_TOTAL) / 1000).toFixed(1)}s`)
