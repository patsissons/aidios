/**
 * Spike: validate essentia.js pipeline in Node.js against test.mp4
 *
 * Tests:
 *  1. ffmpeg decode → 22050Hz mono Float32Array
 *  2. RhythmExtractor2013 → beats + BPM
 *  3. KeyExtractor → key + mode
 *  4. Loudness (overall)
 *  5. HPCP chroma on a sample frame
 *  6. MFCC on a sample frame
 *  7. OnsetDetection → onset times (basis for segmentation)
 *  8. Compare beat count / BPM against expected for a known song
 */

import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const AUDIO_FILE = path.resolve(__dirname, '../test.mp4')
const SAMPLE_RATE = 22050
const FRAME_SIZE = 2048
const HOP_SIZE = 1024
// Limit audio to first N seconds for the spike (full song processing later)
const MAX_DURATION_SECS = 30

// ─── Step 1: Load essentia.js ────────────────────────────────────────────────

const { EssentiaWASM, Essentia } = require('essentia.js')
const essentia = new Essentia(EssentiaWASM)
console.log(`✓ Essentia ${essentia.version} loaded (${essentia.algorithmNames.split(',').length} algorithms)`)

// ─── Step 2: Decode audio via ffmpeg → raw 32-bit float PCM ─────────────────

console.log('\n── Decoding audio ──────────────────────────────────────────')
const start = Date.now()

const result = spawnSync('ffmpeg', [
  '-i', AUDIO_FILE,
  '-t', String(MAX_DURATION_SECS), // clip to first N seconds
  '-f', 'f32le',          // raw 32-bit little-endian float
  '-ar', String(SAMPLE_RATE),
  '-ac', '1',             // mono
  '-acodec', 'pcm_f32le',
  'pipe:1',               // write to stdout
], { maxBuffer: 200 * 1024 * 1024 }) // 200MB buffer

if (result.error) throw result.error
if (result.status !== 0) {
  console.error(result.stderr?.toString())
  throw new Error(`ffmpeg exited with ${result.status}`)
}

const rawBuffer = result.stdout
const numSamples = rawBuffer.byteLength / 4
const duration = numSamples / SAMPLE_RATE
const audioData = new Float32Array(rawBuffer.buffer, rawBuffer.byteOffset, numSamples)

console.log(`✓ Decoded in ${Date.now() - start}ms`)
console.log(`  Samples: ${numSamples.toLocaleString()}`)
console.log(`  Duration: ${duration.toFixed(2)}s`)
console.log(`  Sample rate: ${SAMPLE_RATE}Hz`)

// ─── Step 3: Convert to Essentia vector ──────────────────────────────────────

const audioVector = essentia.arrayToVector(audioData)
console.log(`✓ Loaded into Essentia vector`)

// ─── Step 4: Rhythm / Beat extraction ────────────────────────────────────────

console.log('\n── Rhythm extraction ───────────────────────────────────────')
const rhythmStart = Date.now()
const rhythm = essentia.RhythmExtractor2013(audioVector, 208, 'multifeature', 40)
const bpm: number = rhythm.bpm
const beats: number[] = Array.from(essentia.vectorToArray(rhythm.ticks) as Float32Array)
const bpmEstimates: number[] = Array.from(essentia.vectorToArray(rhythm.bpmEstimates) as Float32Array)
const confidence: number = rhythm.confidence

console.log(`✓ Done in ${Date.now() - rhythmStart}ms`)
console.log(`  BPM: ${bpm.toFixed(2)}`)
console.log(`  Beats: ${beats.length}`)
console.log(`  Confidence: ${confidence.toFixed(3)}`)
console.log(`  BPM estimates (top 5): ${bpmEstimates.slice(0, 5).map(b => b.toFixed(1)).join(', ')}`)
console.log(`  First 5 beat positions: ${beats.slice(0, 5).map(b => b.toFixed(3)).join(', ')}s`)

// Derive tatums (half-beat subdivisions)
const tatums: number[] = []
for (let i = 0; i < beats.length - 1; i++) {
  tatums.push(beats[i])
  tatums.push((beats[i] + beats[i + 1]) / 2)
}
if (beats.length > 0) tatums.push(beats[beats.length - 1])
console.log(`  Tatums (2x beats): ${tatums.length}`)

// ─── Step 5: Key / mode detection ────────────────────────────────────────────

console.log('\n── Key detection ───────────────────────────────────────────')
const keyStart = Date.now()
const keyResult = essentia.KeyExtractor(audioVector, true, 4096, 4096, 12, 3500, 60, 25, 0.2, 'bgate', SAMPLE_RATE, 0.0001, 440, 'cosine', 'hann')
const key: string = keyResult.key
const scale: string = keyResult.scale
const keyStrength: number = keyResult.strength

console.log(`✓ Done in ${Date.now() - keyStart}ms`)
console.log(`  Key: ${key} ${scale} (strength: ${keyStrength.toFixed(3)})`)

// Map key string to integer (C=0, C#=1, ..., B=11)
const KEY_MAP: Record<string, number> = {
  'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5,
  'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11
}
const keyInt = KEY_MAP[key] ?? -1
const modeInt = scale === 'major' ? 1 : 0
console.log(`  key=${keyInt}, mode=${modeInt} (Spotify format: 1=major, 0=minor)`)

// ─── Step 6: Overall loudness ─────────────────────────────────────────────────

console.log('\n── Loudness ────────────────────────────────────────────────')

// Compute RMS across whole track as dBFS
let sumSq = 0
for (let i = 0; i < audioData.length; i++) sumSq += audioData[i] * audioData[i]
const rms = Math.sqrt(sumSq / audioData.length)
const loudnessDb = 20 * Math.log10(rms)
console.log(`  Overall RMS loudness: ${loudnessDb.toFixed(3)} dBFS`)

// Also try Essentia's Loudness algorithm on a slice
const loudnessResult = essentia.Loudness(audioVector)
console.log(`  Essentia Loudness (Steven's): ${loudnessResult.loudness.toFixed(3)}`)

// ─── Step 7: Per-frame HPCP (chroma) and MFCC on a sample window ─────────────

console.log('\n── Per-frame feature extraction (sample window) ────────────')

// Use a frame around beat[4] as a representative sample
const sampleBeatIdx = 4
const sampleStart = Math.floor((beats[sampleBeatIdx] ?? 5.0) * SAMPLE_RATE)
const sampleEnd = Math.min(sampleStart + FRAME_SIZE, audioData.length)
const sampleFrame = audioData.slice(sampleStart, sampleEnd)

// Pad if needed
const frame = new Float32Array(FRAME_SIZE)
frame.set(sampleFrame.slice(0, Math.min(sampleFrame.length, FRAME_SIZE)))

const frameVector = essentia.arrayToVector(frame)

// Windowing
const windowed = essentia.Windowing(frameVector, true, FRAME_SIZE, 'hann', false)

// Spectrum
const spectrum = essentia.Spectrum(windowed.frame, FRAME_SIZE)

// MFCC (12 coefficients)
const mfccResult = essentia.MFCC(
  spectrum.spectrum,
  -1000, 0, 40, FRAME_SIZE, SAMPLE_RATE, 'standard', 13, 20, 3500, 'logrithmicExponential',
  1, 'standard'
)
const mfccCoeffs = Array.from(essentia.vectorToArray(mfccResult.mfcc) as Float32Array).slice(0, 12)
console.log(`  MFCC[12]: [${mfccCoeffs.map(v => v.toFixed(1)).join(', ')}]`)

// SpectralPeaks → HPCP (chroma)
const peaks = essentia.SpectralPeaks(spectrum.spectrum, 1, 100, SAMPLE_RATE, FRAME_SIZE, 'magnitude', 0, SAMPLE_RATE / 2)
const hpcpResult = essentia.HPCP(
  peaks.frequencies, peaks.magnitudes,
  12, 500, false, 0, 0, 'none', SAMPLE_RATE / 2, 40, 'unitNorm', 440, 0
)
const chromaRaw = Array.from(essentia.vectorToArray(hpcpResult.hpcp) as Float32Array)

// Normalize so max = 1.0 (Spotify convention)
const chromaMax = Math.max(...chromaRaw)
const chroma = chromaMax > 0 ? chromaRaw.map(v => v / chromaMax) : chromaRaw
console.log(`  Chroma[12]: [${chroma.map(v => v.toFixed(2)).join(', ')}]`)

// ─── Step 8: Onset detection (basis for segmentation) ────────────────────────

console.log('\n── Onset detection ──────────────────────────────────────────')
const onsetStart = Date.now()

// Use SuperFluxExtractor for robust onset detection
const superflux = essentia.SuperFluxExtractor(audioVector, FRAME_SIZE, HOP_SIZE, 30, SAMPLE_RATE, 50, 3, 0.05)
const onsets: number[] = Array.from(essentia.vectorToArray(superflux.onsets) as Float32Array)

console.log(`✓ Done in ${Date.now() - onsetStart}ms`)
console.log(`  Onset count: ${onsets.length}`)
console.log(`  Average segment duration: ${(duration / onsets.length).toFixed(3)}s`)
console.log(`  First 10 onsets: ${onsets.slice(0, 10).map(t => t.toFixed(3)).join(', ')}s`)

// ─── Step 9: Summary ──────────────────────────────────────────────────────────

console.log('\n── Summary ──────────────────────────────────────────────────')
console.log(`  Duration: ${duration.toFixed(2)}s`)
console.log(`  BPM: ${bpm.toFixed(2)} (confidence: ${confidence.toFixed(2)})`)
console.log(`  Key: ${key} ${scale} (${keyInt}, ${modeInt})`)
console.log(`  Loudness: ${loudnessDb.toFixed(2)} dBFS`)
console.log(`  Beats: ${beats.length}`)
console.log(`  Tatums: ${tatums.length}`)
console.log(`  Onsets (potential segments): ${onsets.length}`)
console.log(`\n  Branching quality estimate:`)
console.log(`    beats/6 target: ${Math.floor(beats.length / 6)} beats with neighbors`)
console.log(`    avg beat duration: ${(duration / beats.length).toFixed(3)}s`)
console.log(`\n✓ Spike complete in ${((Date.now() - start) / 1000).toFixed(1)}s total`)
