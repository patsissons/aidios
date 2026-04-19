# Essentia & Essentia.js — Algorithm Reference

## Essentia.js

- npm package: `essentia.js`
- Website: https://mtg.github.io/essentia.js/
- GitHub: https://github.com/MTG/essentia.js
- Backend: WebAssembly port of the Essentia C++ library
- Supports: Browser AND Node.js runtime
- TypeScript: Yes (`src/typescript/` includes `core_api.ts`, `extractor/`, `machinelearning/`)

## Algorithm Inventory (relevant subset)

### Beat Tracking & Rhythm

| Algorithm | Description |
|---|---|
| `BeatTrackerDegara` | Estimates beat positions from input signal |
| `BeatTrackerMultiFeature` | More robust beat tracker using multiple features |
| `RhythmExtractor` | BPM + beat positions |
| `RhythmExtractor2013` | Beat positions + confidence + BPM |
| `PercivalBpmEstimator` | Tempo from input signal |
| `TempoTap` | Period/phase estimation for periodic signals |
| `TempoTapDegara` | Beat positions from onset detection function |

**Recommended for our use**: `RhythmExtractor2013` for beats + confidence, then derive tatums (half-beats) and bars (group by time_signature).

### Key & Mode Detection

| Algorithm | Description |
|---|---|
| `Key` | Key + scale from HPCP input |
| `KeyExtractor` | Full pipeline: audio → key + scale + strength |

`KeyExtractor` outputs: `key` (string), `scale` ("major"/"minor"), `strength` (0-1 confidence).

### Chroma / Pitch Class (→ `pitches[12]`)

| Algorithm | Description |
|---|---|
| `HPCP` | Harmonic Pitch Class Profile — the standard Essentia chroma |
| `Chromagram` | Constant-Q chromagram via FFT |
| `NNLSChroma` | Treble and bass chromagrams from log-frequency spectrum |

**Recommended**: `HPCP` — most similar to the EchoNest approach. Requires spectral peaks as input.
Pipeline: `FrameGenerator` → `Windowing` → `Spectrum` → `SpectralPeaks` → `SpectralWhitening` → `HPCP`
Output: 12-bin vector (can configure size 12, 24, 36 — use 12 to match Spotify format)

### Timbre / Spectral Features (→ `timbre[12]`)

| Algorithm | Description |
|---|---|
| `MFCC` | Mel-frequency cepstral coefficients |
| `GFCC` | Gammatone frequency cepstral coefficients |
| `MelBands` | Energy in mel-frequency bands |

**Recommended**: `MFCC` with 13 coefficients, drop coefficient 0 OR use all 13 → scale to 12.
The original EchoNest timbre uses an internal representation similar to MFCC.
Pipeline: `FrameGenerator` → `Windowing` → `Spectrum` → `MelBands` → `MFCC`

Note: Spotify timbre[0] ≈ 150-350 (energy-like); timbre[1..11] roughly centered at 0.
We may need to apply the same normalization after computing MFCCs.

### Loudness / Dynamics (→ `loudness_start/max/end`)

| Algorithm | Description |
|---|---|
| `Loudness` | Steven's power law loudness |
| `RMS` | Root mean square (quadratic mean) |
| `LoudnessEBUR128` | EBU R128 loudness descriptors |
| `LoudnessVickers` | Vickers's loudness |
| `ReplayGain` | Replay Gain value |
| `DynamicComplexity` | Temporal intensity variations |

**Recommended**:
- Overall track loudness: `LoudnessEBUR128` (integrated loudness in LUFS, scale to dB)
- Per-segment `loudness_start`: `RMS` of first ~50ms of segment → convert to dBFS
- Per-segment `loudness_max`: max `RMS` across frames within segment
- Per-segment `loudness_end`: `RMS` of last ~50ms of segment

### Onset Detection (→ segment boundaries)

| Algorithm | Description |
|---|---|
| `OnsetDetection` | Various onset detection functions |
| `OnsetDetectionGlobal` | Global onset functions |
| `Onsets` | Onset positions from detection functions |
| `SuperFluxExtractor` | Onsets using SuperFlux algorithm |

**Recommended**: `SuperFluxExtractor` for note-level onsets, then `SBic` for structural segments.

### Structural Segmentation (→ `segments[]` boundaries)

| Algorithm | Description |
|---|---|
| `SBic` | Segments audio using Bayesian Information Criterion on a feature matrix |

`SBic` is the key algorithm for reproducing EchoNest-style segmentation.
Input: matrix of frame-level features (chroma + MFCC concatenated, or just MFCC)
Output: list of segment boundary frame indices

Pipeline for segmentation:
1. Compute frame-level features (MFCC or MFCC+HPCP) over sliding windows
2. Build feature matrix (frames × features)
3. Run `SBic` to find structural change points → segment boundaries
4. Extract per-segment features from the audio within each boundary pair

## Essentia.js TypeScript Extractor

Location: `src/typescript/extractor/extractor.ts`

The built-in extractor computes:
- **Mel spectrogram**: `melSpectrumExtractor()` → `{bands}`
- **HPCP chroma**: `hpcpExtractor()` → `{hpcp}`

Config: `sampleRate` (default 44100), `frameSize` (default 2048)

The full algorithm list via WASM matches the C++ library — all standard-mode algorithms
are available via `essentia.AlgorithmName(params)`.

## Machine Learning Extractors

Location: `src/typescript/machinelearning/`

- `EssentiaTFInputExtractor` — computes mel spectrograms for ML models:
  - MusiCNN: 96 mel bands
  - VGGish: 64 mel bands
  - TempoCNN: 40 mel bands

These are for ML inference (danceability, mood, etc.) — not directly needed for our use case.

## Performance Notes

- Essentia.js is faster than Meyda for most algorithms in browsers
- Meyda is faster than Essentia.js in Node.js for MFCCs and HPCP
- For offline file analysis (non-realtime), either is acceptable
- Consider using Essentia.js for consistency with the broader Essentia ecosystem

## Node.js Usage Pattern

```typescript
import Essentia from 'essentia.js';
import EssentiaWASM from 'essentia.js/dist/essentia-wasm.node.js';

const essentia = new Essentia(EssentiaWASM);

// Example: compute HPCP from audio frames
const spectrum = essentia.Spectrum(windowedFrame);
const peaks = essentia.SpectralPeaks(spectrum.spectrum);
const hpcp = essentia.HPCP(peaks.frequencies, peaks.magnitudes);
// hpcp.hpcp = Float32Array of 12 values
```

## Alternative Libraries to Consider

| Library | Language | Beat | Key | HPCP | MFCC | Segmentation |
|---|---|---|---|---|---|---|
| Essentia.js | TS/WASM | ✓ | ✓ | ✓ | ✓ | ✓ (SBic) |
| aubio (node-aubio) | C/Node | ✓ | ✗ | ✗ | ✓ | ✗ |
| Meyda | JS | ✗ | ✓ | ✓ | ✓ | ✗ |
| librosa | Python | ✓ | ✓ | ✓ | ✓ | ✓ |

**Decision: Essentia.js** is the only Node.js-compatible library that covers all required
features including structural segmentation (SBic).
