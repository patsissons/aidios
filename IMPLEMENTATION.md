# aidios — Implementation Guide

## Project Goal

Build a TypeScript/Node.js audio analysis server that:
1. Accepts an audio file upload (any format)
2. Produces JSON matching the **Spotify Audio Analysis API format** exactly
3. Powers an **Infinite Jukebox** experience (never-repeating looping music via beat similarity branching)

The Spotify Audio Analysis format is the successor to EchoNest's format. The Infinite Jukebox algorithm (`github.com/rigdern/InfiniteJukeboxAlgorithm`) is the primary consumer of this data.

---

## Repository Layout

```
aidios/
├── package.json              # npm workspaces root
├── tsconfig.json             # base TypeScript config
├── PLAN.md                   # high-level plan
├── IMPLEMENTATION.md         # this file — detailed implementation guide
├── research/                 # reference docs (do not modify)
│   ├── infinite-jukebox-algorithm.md
│   ├── infinite-jukebox-src/     # verbatim JS source files to port
│   │   ├── calculateNearestNeighbors.js
│   │   └── remixTrack.js
│   ├── spotify-audio-analysis-format.md
│   ├── essentia-algorithms.md
│   ├── echonest-pyechonest-reference.md
│   └── spike-findings.md         # ← CRITICAL: read this first
├── spike/
│   └── index.mjs             # working prototype (reference implementation)
├── packages/
│   ├── types/                # Phase 1
│   ├── analyzer/             # Phases 2–7
│   ├── server/               # Phase 8
│   └── jukebox/              # Phase 9
└── test.mp4                  # test audio file (486s, 128 BPM, Eb minor)
```

---

## Environment

- **Node.js**: v25.3.0 (no Bun — not installed)
- **Package manager**: npm workspaces
- **TypeScript**: via `--experimental-strip-types` OR compile step
- **ffmpeg**: v8.1 at `/opt/homebrew/bin/ffmpeg`
- **Audio analysis**: `essentia.js` v0.1.3 (WASM, Node.js compatible, synchronous UMD)

---

## Verified Facts from Spike (MUST READ)

Full details in `research/spike-findings.md`. Summary of critical points:

### 1. essentia.js loads synchronously in Node.js CJS
```javascript
const { EssentiaWASM, Essentia } = require('essentia.js')
// EssentiaWASM is already loaded — NOT a factory function
const essentia = new Essentia(EssentiaWASM)
```

### 2. WASM heap management is critical
- `essentia.arrayToVector(Float32Array)` copies data INTO the WASM heap
- WASM heap is limited (~256MB total)
- Full 486s audio at 22050Hz = 10.7M samples = 42MB WASM heap
- **After extracting results, always call `vector.delete()`**
- Never keep two large vectors alive simultaneously
- Pattern: `vec = toVec(data)` → `results = algo(vec)` → `extracted = fromVec(results.field)` → `results.field.delete()` → `vec.delete()`

### 3. Correct algorithm signatures (positional args, NOT C++ docs)
```javascript
// Beat tracking
essentia.RhythmExtractor2013(signal, maxTempo=208, method='multifeature', minTempo=40)
// → { bpm, ticks (VectorFloat), confidence, bpmEstimates, estimates, intervals }

// Key/mode
essentia.KeyExtractor(signal, averageDetuningCorrection=true, frameSize=4096, hopSize=4096,
  hpcpSize=12, maxFrequency=3500, maxPeaks=60, minFrequency=25, spectralPeaksThreshold=0.2,
  profileType='bgate', sampleRate=44100, tuningFrequency=440, usePolyphony='cosine',
  windowSize='hann')
// → { key (string e.g. 'Eb'), scale ('major'|'minor'), strength (0-1) }

// Onset/segment detection — CHUNKED (60s max per call due to WASM heap)
essentia.SuperFluxExtractor(signal, combine=20, frameSize=2048, hopSize=256,
  ratioThreshold=16, sampleRate=44100, threshold=0.05)
// → { onsets (VectorFloat) } — onset times in seconds

// Windowing
essentia.Windowing(signal, normalized=true, size=1024, type='hann', zeroPadding=false)
// → { frame (VectorFloat) }

// Spectrum
essentia.Spectrum(signal, size=2048)
// → { spectrum (VectorFloat) } — magnitude spectrum, size = inputSize/2+1

// MFCC (timbre)
essentia.MFCC(spectrum, dctType=2, highFrequencyBound=11000, inputSize=1025, liftering=0,
  logType='dbamp', lowFrequencyBound=0, normalize='unit_sum', numberBands=40,
  numberCoefficients=13, sampleRate=44100, silenceThreshold=1e-10, type='power',
  warpingFormula='htkMel', weighting='warping')
// → { mfcc (VectorFloat 13 values), bands (VectorFloat 40 values) }

// SpectralPeaks (needed before HPCP)
essentia.SpectralPeaks(spectrum, magnitudeThreshold=0, maxFrequency=5000, maxPeaks=100,
  minFrequency=0, orderBy='frequency', sampleRate=44100)
// → { frequencies (VectorFloat), magnitudes (VectorFloat) }

// HPCP = chroma (pitches)
essentia.HPCP(frequencies, magnitudes, bandPreset=true, bandSplitFrequency=500, harmonics=0,
  maxFrequency=5000, maxShifted=false, minFrequency=40, nonLinear=false,
  normalized='unitMax', referenceFrequency=440, sampleRate=44100, size=12,
  weightType='squaredCosine', windowSize=1)
// → { hpcp (VectorFloat 12 values) } — with 'unitMax', already normalized to [0,1]
```

### 4. Key name mapping (Essentia returns flat names)
```javascript
const KEY_MAP = {
  C:0, 'C#':1, Db:1, D:2, 'D#':3, Eb:3, E:4, F:5,
  'F#':6, Gb:6, G:7, 'G#':8, Ab:8, A:9, 'A#':10, Bb:10, B:11
}
// mode: scale==='major' ? 1 : 0  (Spotify: 1=major, 0=minor)
```

### 5. StartStopSilence takes a single FRAME, not full audio
```javascript
// WRONG: essentia.StartStopSilence(fullAudioVec, -60)
// RIGHT: scan manually:
const FADE_BLOCK = 512
const silenceLinear = Math.pow(10, -60 / 20)
let endOfFadeIn = 0
for (let i = 0; i + FADE_BLOCK <= audio.length; i += FADE_BLOCK) {
  let s = 0; for (let j = i; j < i + FADE_BLOCK; j++) s += audio[j] ** 2
  if (Math.sqrt(s / FADE_BLOCK) > silenceLinear) { endOfFadeIn = i / SAMPLE_RATE; break }
}
```

### 6. Known issues / tuning needed

**Half-time beat detection**: `RhythmExtractor2013` returns 516 beats for a 486s @ 128 BPM song (expected ~1037). It tracks at half-tempo for fast music. Average detected beat = 0.94s (should be 0.47s at 128 BPM).
- Detection: if `duration / beats.length > 0.7s`, beats are at half-time → post-process by inserting half-beats
- Or: use tatum subdivision at 0.25-beat level
- For the Infinite Jukebox, this means fewer branching points but still functional

**Timbre[0] scale**: Our MFCC gives timbre[0] = -450 to -650 (dBamp scale, negative). Spotify's is +150 to +350. The Infinite Jukebox algorithm uses Euclidean distance — different scale means different distance ranges, so threshold of 80 in `calculateNearestNeighbors.js` may need tuning (probably needs to be larger). Values are internally consistent so branching still works, just with recalibrated thresholds.

**SuperFluxExtractor density varies by section**: threshold=0.05 gave 1-5 onsets/sec depending on musical density. This is actually desirable — denser sections get finer segmentation. Total 2287 segments for 486s = 4.7/sec avg.

### 7. Performance profile (486s test file)
- Decode to PCM: 400ms
- Beat extraction: 8s
- Key extraction: 450ms
- Onset detection (8×60s chunks): 4.7s
- Per-segment features (streaming, all 2287): ~60s estimated
- **Total estimated**: ~75s for a full 8-minute song

Critical: **DO NOT** call ffmpeg per segment. Decode ONCE to Float32Array, then slice views.

---

## Target Output Format

Full schema in `research/spotify-audio-analysis-format.md`. Quick reference:

```typescript
interface AudioAnalysis {
  meta: {
    analyzer_version: string  // 'aidios-0.1.0'
    platform: string          // 'Node.js'
    detailed_status: string   // 'OK'
    status_code: number       // 0
    timestamp: number         // unix seconds
    analysis_time: number     // seconds to analyze
    input_process: string     // 'ffmpeg'
  }
  track: {
    num_samples: number
    duration: number
    sample_md5: string
    offset_seconds: 0
    window_seconds: 0
    analysis_sample_rate: number  // 22050
    analysis_channels: 1
    end_of_fade_in: number
    start_of_fade_out: number
    loudness: number          // dBFS, e.g. -8.9
    tempo: number             // BPM
    tempo_confidence: number
    time_signature: number    // 4
    time_signature_confidence: number
    key: number               // 0-11
    key_confidence: number
    mode: number              // 1=major, 0=minor
    mode_confidence: number
    // fingerprint fields: leave as empty string
    codestring: ''
    code_version: 0
    echoprintstring: ''
    echoprint_version: 0
    synchstring: ''
    synch_version: 0
    rhythmstring: ''
    rhythm_version: 0
  }
  bars:    Array<{ start: number, duration: number, confidence: number }>
  beats:   Array<{ start: number, duration: number, confidence: number }>
  tatums:  Array<{ start: number, duration: number, confidence: number }>
  sections: Array<{
    start: number, duration: number, confidence: number
    loudness: number, tempo: number, tempo_confidence: number
    key: number, key_confidence: number
    mode: number, mode_confidence: number
    time_signature: number, time_signature_confidence: number
  }>
  segments: Array<{
    start: number, duration: number, confidence: number
    loudness_start: number
    loudness_max: number
    loudness_max_time: number  // offset from segment start
    loudness_end: number
    pitches: number[]          // 12-element chroma, each 0.0-1.0, max=1.0
    timbre: number[]           // 12 MFCC coefficients
  }>
}
```

---

## What the Infinite Jukebox Algorithm Uses

From `research/infinite-jukebox-algorithm.md`. The algorithm ONLY uses:

```
beats[i].start, .duration, .confidence
seg.timbre[0..11]         — primary distance metric (weighted euclidean, weight=1)
seg.pitches[0..11]        — secondary distance metric (euclidean, weight=10)
seg.loudness_start        — tertiary (weight=1)
seg.loudness_max          — quaternary (weight=1)
seg.duration              — penalty (weight=100)
seg.confidence            — penalty (weight=1)
beat.overlappingSegments  — derived by remixTrack.js from time overlap
beat.indexInParent        — derived (position of beat within its bar)
```

The similarity graph is built only from `beats` (not tatums, bars, or sections).
Branching occurs at beat boundaries.

---

## Package Architecture

### `packages/types`

Pure TypeScript interfaces. No runtime dependencies.

```
src/
  analysis.ts     ← AudioAnalysis, TrackSummary, Section, Segment, TimeInterval
  index.ts
```

### `packages/analyzer`

Core analysis engine. Depends on `essentia.js`.

```
src/
  decoder.ts      ← ffmpeg → Float32Array (full audio, then slice views)
  globals.ts      ← beats, bars, tatums, key, loudness, fades
  segments.ts     ← onset detection → segment boundaries
  features.ts     ← per-segment: MFCC, HPCP, loudness envelope
  sections.ts     ← coarser segmentation → sections
  pipeline.ts     ← orchestrates all → AudioAnalysis
  essentia.ts     ← Essentia wrapper (loads once, typed helpers)
  index.ts
```

### `packages/server`

HTTP API server. Depends on `@aidios/analyzer`.

```
src/
  routes/
    analyze.ts    ← POST /analyze (multipart upload)
    status.ts     ← GET /analyze/:id
  queue.ts        ← in-memory job queue
  index.ts        ← Hono or Fastify app
```

### `packages/jukebox`

TypeScript port of the Infinite Jukebox algorithm.

```
src/
  types.ts        ← Quantum, Edge, JukeboxTrack interfaces
  remixTrack.ts   ← port of remixTrack.js
  calculateNearestNeighbors.ts  ← port of calculateNearestNeighbors.js
  infiniteBeats.ts ← port of InfiniteBeats.js
  index.ts
```

---

## Implementation Phases

### Phase 1 — `packages/types` ✦ START HERE

Create TypeScript interfaces matching the Spotify Audio Analysis format.

**Files to create:**
- `packages/types/package.json`
- `packages/types/tsconfig.json`
- `packages/types/src/analysis.ts` ← all interfaces
- `packages/types/src/index.ts`

**`analysis.ts`** should export:
- `TimeInterval` — base: `{ start, duration, confidence }`
- `Section extends TimeInterval` — adds tempo/key/loudness/mode/time_signature + confidences
- `Segment extends TimeInterval` — adds loudness fields + `pitches[12]` + `timbre[12]`
- `TrackSummary` — global track properties
- `AnalysisMeta` — analysis metadata
- `AudioAnalysis` — root object with all arrays

Also export Zod schemas for runtime validation.

---

### Phase 2 — Audio Decoder

**File**: `packages/analyzer/src/decoder.ts`

```typescript
export interface DecodedAudio {
  data: Float32Array       // raw PCM samples, 22050Hz mono
  sampleRate: number       // 22050
  numSamples: number
  duration: number         // seconds
  md5: string              // of original file bytes
}

export async function decodeAudio(inputPath: string): Promise<DecodedAudio>
```

**Implementation**:
1. Compute MD5 of input file
2. Run ffmpeg synchronously:
   ```
   ffmpeg -i <file> -f f32le -ar 22050 -ac 1 -acodec pcm_f32le pipe:1
   ```
3. Read stdout into Buffer
4. Copy to Float32Array (safe copy to avoid Buffer pool alignment issues):
   ```typescript
   const audio = new Float32Array(raw.byteLength / 4)
   for (let i = 0; i < audio.length; i++) audio[i] = raw.readFloatLE(i * 4)
   ```
5. Return DecodedAudio

**Note on spawnSync**: Use `{ maxBuffer: 300 * 1024 * 1024 }` for up to ~7min audio.

---

### Phase 3 — Essentia Wrapper

**File**: `packages/analyzer/src/essentia.ts`

```typescript
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { EssentiaWASM, Essentia: EssentiaClass } = require('essentia.js')

class EssentiaWrapper {
  private e: any

  constructor() {
    this.e = new EssentiaClass(EssentiaWASM)
  }

  toVec(arr: Float32Array): WasmVector { ... }
  fromVec(vec: WasmVector): Float32Array { ... }

  // Typed wrappers for each algorithm we use:
  rhythmExtractor(signal: WasmVector): RhythmResult
  keyExtractor(signal: WasmVector, sampleRate: number): KeyResult
  superFluxExtractor(signal: WasmVector, sampleRate: number, threshold: number): Float32Array
  mfcc(spectrum: WasmVector, sampleRate: number, frameSize: number): Float32Array  // 13 coeffs
  hpcp(frequencies: WasmVector, magnitudes: WasmVector, sampleRate: number): Float32Array  // 12
  spectralPeaks(spectrum: WasmVector, sampleRate: number): { freq: WasmVector, mag: WasmVector }
  windowing(signal: WasmVector, frameSize: number): WasmVector
  spectrum(windowed: WasmVector, frameSize: number): WasmVector
}
```

All methods must delete intermediate WASM vectors before returning.

---

### Phase 4 — Global Analysis

**File**: `packages/analyzer/src/globals.ts`

Takes `DecodedAudio`, returns global track properties:

```typescript
export interface GlobalFeatures {
  bpm: number
  bpmConfidence: number
  beatTimes: number[]          // seconds for each beat
  keyInt: number               // 0-11
  keyConfidence: number
  modeInt: number              // 1=major, 0=minor
  modeConfidence: number
  overallLoudness: number      // dBFS
  endOfFadeIn: number          // seconds
  startOfFadeOut: number       // seconds
  timeSig: number              // 4 (assumed)
}
```

**Beat post-processing** (half-time fix):
```typescript
function maybeDoubleBeats(beats: number[], duration: number, bpm: number): number[] {
  const avgBeatDur = duration / beats.length
  // If avg beat duration > 0.7s, we're at half-tempo → insert midpoints
  if (avgBeatDur > 0.7) {
    const doubled: number[] = []
    for (let i = 0; i < beats.length - 1; i++) {
      doubled.push(beats[i])
      doubled.push((beats[i] + beats[i + 1]) / 2)
    }
    doubled.push(beats[beats.length - 1])
    return doubled
  }
  return beats
}
```

---

### Phase 5 — Onset Detection (Segments)

**File**: `packages/analyzer/src/segments.ts`

Takes `DecodedAudio`, returns segment boundary times.

**Key constraint**: Process in 60-second chunks. Delete vectors between chunks.

```typescript
const CHUNK_SECS = 60
const OVERLAP_SECS = 1.0
const ONSET_THRESHOLD = 0.05  // tunable

export async function detectSegments(audio: DecodedAudio): Promise<number[]>
// Returns sorted array of onset times (seconds)
// First onset is typically > 0 (silence at start)
// Last segment ends at audio.duration
```

**Post-processing**: Merge onsets that are <50ms apart (duplicate detections).

---

### Phase 6 — Per-Segment Feature Extraction

**File**: `packages/analyzer/src/features.ts`

**Critical**: Use `audio.data.slice(startSample, endSample)` NOT ffmpeg per segment.

```typescript
const FRAME_SIZE = 2048
const SAMPLE_RATE = 22050

export interface SegmentFeatures {
  start: number
  duration: number
  confidence: number
  loudness_start: number
  loudness_max: number
  loudness_max_time: number
  loudness_end: number
  pitches: number[]    // 12-element chroma
  timbre: number[]     // 12 MFCC coefficients
}

export function extractSegmentFeatures(
  audio: DecodedAudio,
  segmentStart: number,  // seconds
  segmentEnd: number,    // seconds
  essentia: EssentiaWrapper
): SegmentFeatures
```

**Implementation**:
1. Slice the audio Float32Array: `audio.data.slice(startSample, endSample)`
2. Take first `FRAME_SIZE` samples (zero-pad if shorter)
3. Windowing → Spectrum → MFCC + SpectralPeaks → HPCP
4. Compute loudness envelope (50ms RMS blocks, find max, record time)
5. Delete all intermediate WASM vectors
6. Return features

**Performance**: At ~5ms per segment (no ffmpeg overhead), 2287 segments ≈ 11 seconds.

---

### Phase 7 — Section Detection

**File**: `packages/analyzer/src/sections.ts`

Sections are coarser structural units (chorus, verse, bridge). Approach:
1. Group segments by timbral similarity (cluster adjacent similar segments)
2. Or: re-run SuperFluxExtractor with larger hopSize and lower sensitivity
3. Assign each section: avg loudness/tempo/key from constituent beats in that region

Simple approach (start with this):
```typescript
// Group beats into sections by finding large gaps in the similarity graph
// Or just use a fixed section length (e.g. ~30s) as a placeholder
// and refine later
```

For now, a workable heuristic:
- Run SuperFluxExtractor with `threshold=0.5` (10x higher than segments) on the full audio (in chunks)
- These coarser onsets become section boundaries
- For each section, compute avg loudness, use global key/tempo

---

### Phase 8 — Assembly Pipeline

**File**: `packages/analyzer/src/pipeline.ts`

```typescript
export async function analyzeAudio(filePath: string): Promise<AudioAnalysis> {
  const startTime = Date.now()
  const audio = await decodeAudio(filePath)

  // Phase 1: Global (beats, key, loudness, fades)
  const globals = await extractGlobalFeatures(audio)

  // Phase 2: Beat structures
  const beats = buildBeats(globals.beatTimes)
  const tatums = buildTatums(globals.beatTimes)
  const bars = buildBars(globals.beatTimes, globals.timeSig)

  // Phase 3: Segment boundaries
  const onsets = await detectSegments(audio)

  // Phase 4: Per-segment features (streaming from audio.data)
  const segments = extractAllSegments(audio, onsets)

  // Phase 5: Sections (coarser segmentation)
  const sections = await detectSections(audio, globals)

  // Assemble AudioAnalysis
  return {
    meta: buildMeta(audio, Date.now() - startTime),
    track: buildTrack(audio, globals),
    bars, beats, tatums, sections, segments
  }
}
```

---

### Phase 9 — HTTP Server

**File**: `packages/server/src/index.ts`

```typescript
// Framework: Hono (lightweight, TypeScript-first)
// npm install hono

const app = new Hono()

// POST /analyze — accepts multipart file upload
app.post('/analyze', async (c) => {
  const body = await c.req.parseBody()
  const file = body['audio'] as File
  // Save to temp file, queue analysis, return job ID
  return c.json({ id: jobId, status: 'queued' })
})

// GET /analyze/:id — poll for results
app.get('/analyze/:id', async (c) => {
  const job = queue.get(c.req.param('id'))
  if (!job) return c.json({ error: 'not found' }, 404)
  if (job.status === 'complete') return c.json({ status: 'complete', analysis: job.result })
  return c.json({ status: job.status })
})
```

---

### Phase 10 — Jukebox Algorithm Port

Port `research/infinite-jukebox-src/` to TypeScript with full types.

**Key types needed**:
```typescript
interface Quantum {
  start: number
  duration: number
  confidence: number
  which: number
  prev: Quantum | null
  next: Quantum | null
  parent?: Quantum
  children?: Quantum[]
  indexInParent?: number
  overlappingSegments?: Segment[]
  oseg?: Segment
  neighbors?: Edge[]
  all_neighbors?: Edge[]
  reach?: number
  track?: JukeboxTrack
}

interface Edge {
  id: number
  src: Quantum
  dest: Quantum
  distance: number
}

interface JukeboxTrack {
  analysis: {
    sections: Quantum[]
    bars: Quantum[]
    beats: Quantum[]
    tatums: Quantum[]
    segments: Segment[]
    fsegments?: Segment[]
  }
}
```

The algorithm operates on `track.analysis.beats` only for branching.
All 5 arrays must be present (sections, bars, beats, tatums, segments).

---

## Common Patterns

### Loading Essentia (CJS in ESM context)
```typescript
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { EssentiaWASM, Essentia } = require('essentia.js')
```

### Safe Float32Array from Node Buffer
```typescript
// DO NOT: new Float32Array(buffer.buffer, buffer.byteOffset, n)
// Buffer shares pool — byteOffset misalignment crashes WASM
// DO:
const audio = new Float32Array(raw.byteLength / 4)
for (let i = 0; i < audio.length; i++) audio[i] = raw.readFloatLE(i * 4)
```

### WASM Vector Lifecycle
```typescript
const vec = essentia.arrayToVector(data)
try {
  const result = essentia.Algorithm(vec, ...params)
  const extracted = Array.from(essentia.vectorToArray(result.field))
  result.field.delete()
  result.otherField?.delete()
  return extracted
} finally {
  vec.delete()
}
```

### Segment Feature Extraction (correct order)
```typescript
// 1. Slice audio
const segAudio = audio.data.slice(startSample, endSample)

// 2. Prepare frame (zero-padded to FRAME_SIZE)
const frame = new Float32Array(FRAME_SIZE)
frame.set(segAudio.slice(0, Math.min(segAudio.length, FRAME_SIZE)))

// 3. Pipeline
const fv = essentia.arrayToVector(frame)
const { frame: windowed } = essentia.Windowing(fv, true, FRAME_SIZE, 'hann', false)
fv.delete()
const { spectrum: spec } = essentia.Spectrum(windowed, FRAME_SIZE)
windowed.delete()

// 4. MFCC: (spec, dctType=2, hfBound=SR/2, inputSize=FRAME_SIZE/2+1, ...)
const { mfcc, bands } = essentia.MFCC(spec, 2, SR/2, FRAME_SIZE/2+1, 0, 'dbamp', 0, 'unit_sum', 40, 13, SR)
const timbre = Array.from(essentia.vectorToArray(mfcc)).slice(0, 12)
mfcc.delete(); bands.delete()

// 5. SpectralPeaks + HPCP
const { frequencies, magnitudes } = essentia.SpectralPeaks(spec, 0, SR/2, 100, 0, 'magnitude', SR)
const { hpcp } = essentia.HPCP(frequencies, magnitudes, true, 500, 0, SR/2, false, 40, false, 'unitMax', 440, SR, 12)
const pitches = Array.from(essentia.vectorToArray(hpcp))
frequencies.delete(); magnitudes.delete(); hpcp.delete()
spec.delete()
```

---

## Calibration

Use the Gangnam Style reference JSON for calibration:
- URL: `https://github.com/rigdern/InfiniteJukeboxAlgorithm/blob/master/data/gangnamStyleAnalysis.json`
- Ground truth: beats=~480, segments=~900, BPM=137.8, key=11 (B), mode=1 (major)

When implementing calibration tests:
1. Download Gangnam Style audio
2. Run our analyzer
3. Compare: segment count, beat positions (±20ms), chroma correlation

---

## Package.json Templates

### Root `package.json`
```json
{
  "name": "aidios",
  "version": "0.1.0",
  "private": true,
  "workspaces": ["packages/*", "spike"],
  "engines": { "node": ">=22" }
}
```

### `packages/types/package.json`
```json
{
  "name": "@aidios/types",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "zod": "^3.22.0"
  }
}
```

### `packages/analyzer/package.json`
```json
{
  "name": "@aidios/analyzer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "@aidios/types": "*",
    "essentia.js": "^0.1.3"
  }
}
```

### `packages/server/package.json`
```json
{
  "name": "@aidios/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "@aidios/analyzer": "*",
    "@aidios/types": "*",
    "hono": "^4.0.0"
  }
}
```

### `packages/jukebox/package.json`
```json
{
  "name": "@aidios/jukebox",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": {
    "@aidios/types": "*"
  }
}
```

---

## Open Questions / Known Gaps

1. **timbre[0] scale**: Our MFCC gives -450 to -650; Spotify gives +150 to +350. The Infinite Jukebox distance thresholds (80 max) may need to be raised to ~500 for our scale. **Needs calibration.**

2. **Half-time beats**: `maybeDoubleBeats()` heuristic works but needs testing on multiple songs. Edge case: songs that legitimately have slow tempos should not be doubled.

3. **Section detection**: Not yet implemented in spike. Placeholder approach using coarser SuperFlux is acceptable for MVP; sections aren't used by the Infinite Jukebox algorithm for branching.

4. **`timbre[0]` meaning**: Spotify's timbre[0] ≈ integrated loudness. Consider replacing MFCC[0] with the segment's mean dBFS loudness to match Spotify's convention more closely.

5. **Confidence scores**: Using placeholder 0.8 for segment confidence. Should derive from SuperFlux onset strength (higher onset strength = higher confidence). This affects `filterSegments` in remixTrack.js which merges low-confidence segments.

6. **Server auth/rate limiting**: Not needed for MVP (local use only).

7. **Caching**: Store analysis results by file MD5 to avoid re-analyzing the same file.
