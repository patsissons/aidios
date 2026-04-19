# Spike Findings — essentia.js Pipeline Validation

Date: 2026-04-18
Test file: test.mp4 — 486.25s, AAC 128kbps, 44100Hz stereo

## What Works

### Beat Extraction (RhythmExtractor2013)
- **Result**: 516 beats at 127.97 BPM (confidence 1.60) for 486s song
- **Time**: ~8 seconds (full song)
- **Warning**: Getting half-time beats — expected ~1037 at 128 BPM, got 516
  - Each detected beat ≈ 0.94s (2 actual beats at 128 BPM)
  - RhythmExtractor2013 tracks at ~64 BPM instead of 128
  - Fix: Use BeatTrackerMultiFeature which gave same count here; may need to post-process to double beat density
  - Or use tatums (half-beats) as branching unit instead of beats

### Key Detection (KeyExtractor)
- **Result**: Eb minor (key=3, mode=0, strength=0.931)
- **Time**: ~450ms
- **Note**: Key returned as "Eb" not "D#" — must handle flat equivalents in key→int mapping

### Loudness (RMS-based)
- **Result**: -8.89 dBFS overall
- **Time**: negligible (plain JS)
- **Method**: Simple RMS across full audio → dBFS conversion

### Fade Detection
- **Result**: fade_in ends at 0.604s, fade_out starts at 483.4s
- **Method**: Scan 512-sample RMS blocks until energy exceeds -60dB threshold
- **Note**: StartStopSilence takes a single FRAME not the full signal — cannot use for full audio

### Onset Detection / Segmentation (SuperFluxExtractor)
- **Result**: 2287 segments (avg 0.213s) for 486s song
- **Time**: ~4.7 seconds (chunked, 60s chunks)
- **Parameters**: `SuperFluxExtractor(signal, combine=20, frameSize=2048, hopSize=256, ratioThreshold=16, sampleRate=22050, threshold=0.05)`
- **Threshold tuning**:
  - 0.05 → ~1.0 onset/sec (500 total) — too sparse
  - 0.02 → ~2.4 onset/sec (1150 total) — good
  - 0.01 → ~9.2 onset/sec (4460 total) — too dense
  - **Used 0.05** which gave 2287 (chunked behavior differs from single-chunk due to varying song density)
- **Chunking required**: SuperFluxExtractor crashes WASM with full 10M-sample vector if full audioVector is still in memory; process in 60s chunks with 1s overlap

### MFCC / Timbre (per segment)
- **Result**: 12 coefficients extracted successfully
- **timbre[0]** range: -450 to -650 (negative, dBamp scale)
- **Spotify timbre[0]** range: +150 to +350 (positive)
- **Other coefficients**: timbre[1..11] in similar range to Spotify (-200 to +300)
- **Scale difference**: timbre[0] is offset/scaled differently from Spotify
- **Impact**: As long as internally consistent, the Infinite Jukebox distance metric still works — thresholds may need tuning
- **Parameters** (correct signature):
  ```
  MFCC(spectrum, dctType=2, highFrequencyBound=SAMPLE_RATE/2, inputSize=FRAME_SIZE/2+1,
       liftering=0, logType='dbamp', lowFrequencyBound=0, normalize='unit_sum',
       numberBands=40, numberCoefficients=13, sampleRate=SAMPLE_RATE)
  → take mfcc[0..12], use first 12 as timbre[0..11]
  ```

### HPCP / Pitches (per segment)
- **Result**: 12 chroma coefficients, values 0.0–1.0 ✓
- **normalized='unitMax'** handles Spotify's "max=1.0" convention automatically
- **Parameters** (correct signature):
  ```
  SpectralPeaks(spectrum, magnitudeThreshold=0, maxFrequency=SAMPLE_RATE/2, maxPeaks=100,
                minFrequency=0, orderBy='magnitude', sampleRate=SAMPLE_RATE)
  HPCP(frequencies, magnitudes, bandPreset=true, bandSplitFrequency=500, harmonics=0,
       maxFrequency=SAMPLE_RATE/2, maxShifted=false, minFrequency=40, nonLinear=false,
       normalized='unitMax', referenceFrequency=440, sampleRate=SAMPLE_RATE, size=12)
  ```

### Per-Segment Loudness
- **Result**: loudness_start, loudness_max, loudness_max_time, loudness_end in dBFS
- **Method**: RMS of 50ms blocks within segment; scan for peak
- **Values**: -4 to -45 dBFS (reasonable)

## Critical WASM Issues Discovered

### 1. Parameter Orders Are Different from Docs
The essentia.js WASM API parameter order does NOT match the C++ Essentia documentation.
Always check actual JS wrapper signatures, not the C++ docs.

### 2. WASM Heap Exhaustion
- Full audio vector (10M samples = 40MB) uses significant WASM heap
- Cannot keep large vector alive while running other large operations
- **Fix**: Call `vector.delete()` immediately after extracting data
- SuperFluxExtractor on 60s chunks works; on full audio with existing vector → crash

### 3. Single-Process WASM Limitation
- WASM process limit: each Essentia process runs in one WASM instance
- Running multiple heavy operations sequentially with lingering vectors → OOM
- **Pattern**: decode → toVec → extract → fromVec → vec.delete() → next operation

### 4. SBic Not Available
- `SBic` algorithm is in the Essentia C++ library but NOT compiled into the essentia.js WASM package
- Use SuperFluxExtractor + onset-based segmentation instead

### 5. LoudnessEBUR128 Not Available
- Use RMS-based dBFS calculation instead
- Results are similar and sufficient for the use case

## Performance Profile (486s song)

| Phase | Time |
|---|---|
| ffmpeg decode → PCM | 0.4s |
| Beat extraction (full audio) | 8.0s |
| Key extraction (full audio) | 0.5s |
| Onset detection (8 × 60s chunks) | 4.7s |
| Per-segment MFCC+HPCP (10 samples) | 2.1s |
| **Total for 10 segments** | **15.7s** |
| **Estimated total (2287 segments)** | **~500s** ← TOO SLOW |

### Performance Problem: Per-Segment Feature Extraction is Too Slow

Decoding 2287 individual segments via ffmpeg subprocess is the bottleneck.
At ~200ms per ffmpeg decode + feature extraction = 457s for full song.

**Solution**: Frame-by-frame streaming approach
1. Decode full audio ONCE to disk (temp PCM file)
2. Load segments directly from the PCM buffer (no subprocess per segment)
3. Process all frames in a single streaming pass

Alternative: Compute all MFCC/HPCP in a sliding-window pass over the full audio,
then aggregate per-segment by averaging frames within each segment boundary.

## Tuning Still Needed

1. **Beat doubling**: RhythmExtractor2013 tracks half-time for this song; may need to detect and double beat rate
2. **timbre[0] normalization**: Consider using a different logType or manual offset to get positive timbre[0]
3. **Segment threshold**: 0.05 gives variable density (some sections 1/sec, some 5/sec); consider adaptive thresholding
4. **Confidence scores**: Currently using placeholder 0.8; should derive from onset strength

## Algorithm Signatures Reference (Node.js)

```javascript
// CORRECT essentia.js parameter orders (positional):
essentia.RhythmExtractor2013(signal, maxTempo=208, method='multifeature', minTempo=40)
essentia.KeyExtractor(signal, averageDetuningCorrection, frameSize, hopSize, hpcpSize,
                      maxFrequency, maxPeaks, minFrequency, spectralPeaksThreshold,
                      profileType, sampleRate, tuningFrequency, windowType, usePolyphony)
essentia.SuperFluxExtractor(signal, combine=20, frameSize=2048, hopSize=256,
                            ratioThreshold=16, sampleRate=44100, threshold=0.05)
essentia.MFCC(spectrum, dctType=2, highFrequencyBound=11000, inputSize=1025, liftering=0,
              logType='dbamp', lowFrequencyBound=0, normalize='unit_sum', numberBands=40,
              numberCoefficients=13, sampleRate=44100, silenceThreshold=1e-10,
              type='power', warpingFormula='htkMel', weighting='warping')
essentia.SpectralPeaks(spectrum, magnitudeThreshold=0, maxFrequency=5000, maxPeaks=100,
                       minFrequency=0, orderBy='frequency', sampleRate=44100)
essentia.HPCP(frequencies, magnitudes, bandPreset=true, bandSplitFrequency=500, harmonics=0,
              maxFrequency=5000, maxShifted=false, minFrequency=40, nonLinear=false,
              normalized='unitMax', referenceFrequency=440, sampleRate=44100, size=12,
              weightType='squaredCosine', windowSize=1)
essentia.Windowing(signal, normalized=true, size=1024, type='hann', zeroPadding=false)
essentia.Spectrum(signal, size=2048) → {spectrum}
```
