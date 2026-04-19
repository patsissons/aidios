# aidios — Project Plan

## Goal

Recreate an audio analysis server that produces output compatible with the **Spotify Audio Analysis API** format (the successor to EchoNest's audio analysis), then use that output to power an **Infinite Jukebox** experience: a song that loops forever by seamlessly branching between musically similar moments.

---

## Background

### EchoNest / Spotify Audio Analysis

EchoNest was an audio analysis platform acquired by Spotify. Spotify integrated its algorithms into the Spotify Audio Analysis API (`GET /audio-analysis/{id}`), which is now deprecated. The output format is well-documented and is exactly what the Infinite Jukebox algorithm expects.

### What the Infinite Jukebox Needs

The [InfiniteJukeboxAlgorithm](https://github.com/rigdern/InfiniteJukeboxAlgorithm) builds a nearest-neighbor graph of beats based on audio similarity, then randomly branches between similar beats during playback to create never-repeating music.

---

## Required Output Format

The analysis JSON must conform to this structure:

```typescript
interface AudioAnalysis {
  meta: AnalysisMeta;
  track: TrackSummary;
  bars: TimeInterval[];
  beats: TimeInterval[];
  tatums: TimeInterval[];
  sections: Section[];
  segments: Segment[];
}

interface TimeInterval {
  start: number;       // seconds
  duration: number;    // seconds
  confidence: number;  // 0.0–1.0
}

interface Section extends TimeInterval {
  loudness: number;
  tempo: number;
  tempo_confidence: number;
  key: number;              // 0–11 (C through B)
  key_confidence: number;
  mode: number;             // 0=minor, 1=major
  mode_confidence: number;
  time_signature: number;   // beats per measure
  time_signature_confidence: number;
}

interface Segment extends TimeInterval {
  loudness_start: number;     // dB at segment start
  loudness_max: number;       // peak dB within segment
  loudness_max_time: number;  // offset of peak from start (seconds)
  loudness_end: number;       // dB at segment end
  pitches: number[];          // 12-element chroma vector [0.0–1.0]
  timbre: number[];           // 12 MFCC-like spectral coefficients
}

interface TrackSummary {
  num_samples: number;
  duration: number;
  sample_md5: string;
  offset_seconds: number;
  window_seconds: number;
  analysis_sample_rate: number;
  analysis_channels: number;
  end_of_fade_in: number;
  start_of_fade_out: number;
  loudness: number;
  tempo: number;
  tempo_confidence: number;
  time_signature: number;
  time_signature_confidence: number;
  key: number;
  key_confidence: number;
  mode: number;
  mode_confidence: number;
}
```

### Properties Used by the Infinite Jukebox Algorithm

The algorithm uses these fields from `calculateNearestNeighbors.js`:

| Property | Source | Used For |
|---|---|---|
| `beats[].start` | beats array | Beat timestamp for audio scheduling |
| `beats[].duration` | beats array | Audio playback window |
| `beats[].confidence` | beats array | Weighting in similarity score |
| `seg.timbre[0..11]` | segments | Primary similarity metric (weighted) |
| `seg.pitches[0..11]` | segments | Secondary similarity metric (weighted) |
| `seg.loudness_start` | segments | Tertiary similarity metric |
| `seg.loudness_max` | segments | Quaternary similarity metric |
| `seg.duration` | segments | Duration matching penalty |
| `overlappingSegments` | derived | Which segments overlap each beat |

The hierarchy `sections > bars > beats > tatums > segments` is built by `remixTrack.js` which establishes parent/child/prev/next relationships between levels based on time overlap.

---

## Technology Stack

### Runtime: TypeScript + Node.js (Bun)

TypeScript is viable because **Essentia.js** provides a complete WASM port of the Essentia C++ library that runs in Node.js. Performance for offline analysis of audio files is acceptable — this is not a real-time constraint.

**Why not Python?**
- TypeScript preference stated
- Essentia.js covers all required algorithms
- Single-language stack simplifies deployment

**Why not native C++ bindings?**
- Essentia.js WASM avoids native compilation complexity
- Acceptable performance for file-based (non-realtime) analysis

### Core Dependencies

| Package | Purpose |
|---|---|
| `essentia.js` | Audio feature extraction (WASM, Node.js compatible) |
| `ffmpeg` (system) | Audio decoding to PCM (any input format → 22050Hz mono Float32) |
| `hono` | HTTP server (lightweight, TypeScript-first) |
| `zod` | Schema validation for output types |
| `bun` | Runtime + package manager |

### Audio Feature → Algorithm Mapping

| Output Field | Essentia.js Algorithm |
|---|---|
| `tempo`, `tempo_confidence` | `RhythmDescriptors` / `PercivalBpmEstimator` |
| `beats[]` | `BeatTrackerMultiFeature` |
| `tatums[]` | Subdivide beats by 2 (half-beat resolution) |
| `bars[]` | `BeatTrackerMultiFeature` + time signature grouping |
| `key`, `key_confidence` | `KeyExtractor` |
| `mode`, `mode_confidence` | `KeyExtractor` (returns mode alongside key) |
| `loudness` (overall) | `Loudness` / `DynamicComplexity` |
| Segment boundaries | `OnsetDetection` + `SBic` (structural segmentation) |
| `seg.loudness_start/max/end` | `Envelope` + `RMS` per segment window |
| `seg.pitches[12]` | `HPCP` (Harmonic Pitch Class Profile = chroma) |
| `seg.timbre[12]` | `MFCC` (12 coefficients per segment) |
| Sections (higher-level) | `SBic` at coarser granularity or segment clustering |
| `end_of_fade_in` | Onset + energy ramp detection |
| `start_of_fade_out` | Energy decay detection near end |

---

## Repository Structure

```
aidios/
├── PLAN.md
├── package.json          # Workspace root (bun workspaces)
├── tsconfig.base.json
│
├── packages/
│   ├── types/            # Shared TypeScript types
│   │   └── src/
│   │       ├── analysis.ts      # AudioAnalysis, Segment, Section, etc.
│   │       └── index.ts
│   │
│   ├── analyzer/         # Core audio analysis engine
│   │   └── src/
│   │       ├── decoder.ts       # ffmpeg → PCM Float32Array
│   │       ├── beats.ts         # Beat/bar/tatum extraction
│   │       ├── segments.ts      # Structural segmentation
│   │       ├── features.ts      # Per-segment chroma, MFCC, loudness
│   │       ├── globals.ts       # Key, tempo, loudness, fade detection
│   │       ├── pipeline.ts      # Orchestrates all extractors → AudioAnalysis
│   │       └── index.ts
│   │
│   ├── server/           # HTTP API server
│   │   └── src/
│   │       ├── routes/
│   │       │   ├── analyze.ts   # POST /analyze (upload audio)
│   │       │   └── results.ts   # GET /analyze/:id (retrieve cached)
│   │       ├── queue.ts         # Job queue (analysis can take 5-30s)
│   │       └── index.ts
│   │
│   └── jukebox/          # Infinite Jukebox algorithm (TypeScript port)
│       └── src/
│           ├── remixTrack.ts              # Build hierarchical quanta structure
│           ├── calculateNearestNeighbors.ts  # Similarity graph builder
│           ├── infiniteBeats.ts           # Branching playback controller
│           └── index.ts
```

---

## Implementation Phases

### Phase 1 — Types & Schema (Day 1)

Define all TypeScript types in `packages/types`:
- Full `AudioAnalysis` interface matching Spotify format
- Input/output types for each extractor
- Zod schemas for runtime validation of analysis output
- Export a sample analysis JSON for testing (`gangnam-style-analysis.json`)

**Deliverable**: `packages/types` compiles cleanly; sample JSON validates against schema.

### Phase 2 — Audio Decoder (Day 1–2)

Implement `packages/analyzer/src/decoder.ts`:
- Accept `Buffer` or file path
- Invoke `ffmpeg` to convert any format (mp3, flac, wav, ogg, m4a) to:
  - 22050 Hz sample rate
  - Mono (1 channel)
  - 32-bit float PCM
- Return `Float32Array` + metadata (sample rate, num samples, duration)

**Deliverable**: Can decode any common audio format to raw PCM.

### Phase 3 — Global Features (Day 2–3)

Implement `packages/analyzer/src/globals.ts` using Essentia.js:
- **Tempo & beats per minute**: `RhythmDescriptors` → `tempo`, `tempo_confidence`
- **Key & mode**: `KeyExtractor` → `key`, `key_confidence`, `mode`, `mode_confidence`
- **Time signature**: heuristic from beat groupings → `time_signature`
- **Overall loudness**: `Loudness` or `EBUR128` → `loudness`
- **Fade in/out**: energy envelope analysis → `end_of_fade_in`, `start_of_fade_out`

**Deliverable**: Given PCM input, returns `TrackSummary` without timing structures.

### Phase 4 — Beat/Bar/Tatum Tracking (Day 3–4)

Implement `packages/analyzer/src/beats.ts`:
- **Beats**: `BeatTrackerMultiFeature` → array of `{start, duration, confidence}`
- **Tatums**: subdivide each beat interval by 2 (or use `BeatTrackerDegara` at double resolution)
- **Bars**: group beats by `time_signature` count, assign bar-level timing

**Validation**: Cross-check with known-good analysis JSON (gangnam style sample).

**Deliverable**: `beats[]`, `tatums[]`, `bars[]` arrays.

### Phase 4.5 — Streaming PCM Buffer (prerequisite to Phases 5–6)

**Spike finding**: Decoding each segment individually via ffmpeg takes ~200ms × 2287 segments = ~8 minutes. Unacceptable.

**Solution**: Decode the full audio to a temp PCM buffer once, then slice Float32Array views for per-segment and per-frame work. No subprocess per segment.

```
ffmpeg → raw PCM Float32Array (disk-buffered if >100MB) → segment slices
```

### Phase 5 — Structural Segmentation (Day 4–6)

This is the most complex phase. Implement `packages/analyzer/src/segments.ts`:

**Approach**:
1. Compute a short-time spectral feature matrix (chroma + MFCC) using sliding windows (~100ms)
2. Compute a self-similarity matrix (SSM) from the feature matrix
3. Apply `SBic` (Sequential Bayesian Information Criterion) or checkerboard kernel novelty detection on the SSM to find segment boundaries
4. Each boundary pair → one `Segment`

**Fallback**: Use onset detection (`OnsetDetection` with `complex` method) as a simpler approximation if SSM-based segmentation is too complex to tune.

**Deliverable**: Segment boundaries as `{start, duration}` pairs.

### Phase 6 — Per-Segment Feature Extraction (Day 6–8)

Implement `packages/analyzer/src/features.ts`:

For each segment from Phase 5:
- **Chroma (pitches[12])**: Apply `HPCP` to the audio frames within the segment, average → normalize to [0,1]
- **Timbre (timbre[12])**: Apply `MFCC` (13 coefficients) to frames within segment, average → use first 12
- **Loudness envelope**:
  - `loudness_start`: RMS of first ~50ms of segment (in dB)
  - `loudness_max`: peak RMS across segment (in dB)
  - `loudness_max_time`: offset of peak from segment start
  - `loudness_end`: RMS of last ~50ms of segment (in dB)
- **Confidence**: derived from onset detection strength at segment boundary

**Deliverable**: Complete `Segment[]` array with all fields populated.

### Phase 7 — Section Detection (Day 8–9)

Implement higher-level structural segmentation in `packages/analyzer/src/pipeline.ts`:

Group segments into sections using coarser-grained structural analysis:
- Re-run `SBic` at a larger window to find section boundaries
- Or cluster segments by their average chroma/MFCC similarity
- Each section inherits tempo/key/mode from the predominant values of its constituent segments

**Deliverable**: `sections[]` array with all fields.

### Phase 8 — Analysis Pipeline (Day 9–10)

Wire everything together in `packages/analyzer/src/pipeline.ts`:

```
AudioFile → decode → PCM
  → globals (tempo, key, loudness, fades)
  → beats (beats, bars, tatums)
  → segments (boundaries → features)
  → sections
  → assemble AudioAnalysis JSON
  → validate with Zod schema
```

**Deliverable**: `analyzeAudio(buffer: Buffer): Promise<AudioAnalysis>`

### Phase 9 — HTTP Server (Day 10–11)

Implement `packages/server`:
- `POST /analyze` — accepts `multipart/form-data` with audio file
  - Enqueues analysis job
  - Returns `{ id: string, status: "queued" }`
- `GET /analyze/:id` — returns analysis result or status
  - `{ status: "processing" }` while running
  - `{ status: "complete", analysis: AudioAnalysis }` when done
  - `{ status: "error", message: string }` on failure
- Simple in-memory job queue (upgradeable to Redis/Bull later)

**Deliverable**: Server accepts audio upload, returns analysis JSON.

### Phase 10 — Infinite Jukebox Port (Day 11–13)

Port the JavaScript algorithm to TypeScript in `packages/jukebox`:

1. `remixTrack.ts` — builds hierarchical quanta structure with parent/child/prev/next links
2. `calculateNearestNeighbors.ts` — builds similarity graph using timbre, pitch, loudness, duration
3. `infiniteBeats.ts` — branching playback controller

Add TypeScript types for all internal structures. The algorithm itself is not changed — just typed and cleaned up.

**Deliverable**: Given `AudioAnalysis` JSON, `remixTrack()` returns typed quanta graph; `InfiniteBeats` provides the next beat to play.

---

## Calibration Strategy

The hardest problem is **accuracy** — making our extracted features close enough to the original EchoNest values that the Infinite Jukebox produces good-quality branches.

**Test approach**:
1. Use `gangnamStyleAnalysis.json` (known-good Spotify analysis) as ground truth
2. Run our analyzer on Gangnam Style audio
3. Compare output field-by-field
4. Tune algorithm parameters to minimize deviation

**Key calibration targets**:
- Segment count and boundary positions (±50ms tolerance)
- Chroma vector values per segment (correlation > 0.9)
- MFCC values per segment (correlation > 0.9)
- Beat positions (±10ms tolerance)
- Tempo within ±1 BPM

---

## Open Questions

1. **Essentia.js WASM performance in Bun**: Need to verify WASM loading works correctly in Bun runtime (vs. Node.js). May need to use Node.js if Bun has WASM limitations.

2. **Segment boundary accuracy**: The EchoNest segmentation algorithm is proprietary. Our SSM-based approach may produce different (but usable) boundaries. The Infinite Jukebox tolerates some variance as long as features are internally consistent.

3. **Timbre normalization**: The Spotify timbre coefficients have a specific normalization. MFCC values need to be scaled/centered to match — exact normalization may require calibration against known samples.

4. **tatums**: The original may use a more sophisticated sub-beat detection. Simple beat-halving is a reasonable approximation.

5. **Confidence scores**: Many confidence values in the original are derived from proprietary model probabilities. We will compute reasonable proxies (onset strength, detection confidence from Essentia algorithms).

---

## Stretch Goals

- **Waveform data**: Return waveform amplitude data for visualization
- **Caching**: SQLite or Redis cache for analyzed files (by md5)
- **Web client**: Browser-based player using Web Audio API + the jukebox algorithm
- **Batch API**: Analyze multiple files in parallel

---

## References

- [Spotify Audio Analysis API docs](https://developer.spotify.com/documentation/web-api/reference/get-audio-analysis)
- [InfiniteJukeboxAlgorithm](https://github.com/rigdern/InfiniteJukeboxAlgorithm)
- [pyechonest](https://github.com/echonest/pyechonest)
- [Essentia.js](https://mtg.github.io/essentia.js/)
- [Essentia C++ docs](https://essentia.upf.edu/documentation.html)
- Sample analysis: [gangnamStyleAnalysis.json](https://github.com/rigdern/InfiniteJukeboxAlgorithm/blob/master/data/gangnamStyleAnalysis.json)
