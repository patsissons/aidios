# Spotify Audio Analysis API — Data Format Reference

Source: https://developer.spotify.com/documentation/web-api/reference/get-audio-analysis
Sample: https://github.com/rigdern/InfiniteJukeboxAlgorithm/blob/master/data/gangnamStyleAnalysis.json

This is the format our audio analysis server must produce.

## Root Object

```typescript
{
  meta:     AnalysisMeta
  track:    TrackSummary
  bars:     TimeInterval[]
  beats:    TimeInterval[]
  tatums:   TimeInterval[]
  sections: Section[]
  segments: Segment[]
}
```

## meta

```typescript
{
  analyzer_version: string   // e.g. "4.0.0-1c7f4b4"
  platform:         string   // e.g. "Linux"
  detailed_status:  string   // "OK" on success
  status_code:      number   // 0 = success, 1 = error
  timestamp:        number   // unix timestamp
  analysis_time:    number   // seconds to analyze
  input_process:    string   // e.g. "libavcodec"
}
```

## track

```typescript
{
  num_samples:              number   // total audio samples
  duration:                 number   // seconds
  sample_md5:               string   // always empty string in Spotify
  offset_seconds:           number   // always 0
  window_seconds:           number   // always 0
  analysis_sample_rate:     number   // e.g. 22050
  analysis_channels:        number   // e.g. 1
  end_of_fade_in:           number   // seconds
  start_of_fade_out:        number   // seconds
  loudness:                 number   // dB (negative, e.g. -15.379)
  tempo:                    number   // BPM (e.g. 137.788)
  tempo_confidence:         number   // 0.0–1.0
  time_signature:           number   // beats per bar (e.g. 4)
  time_signature_confidence: number  // 0.0–1.0
  key:                      number   // 0=C, 1=C#, ..., 11=B (-1 if undetected)
  key_confidence:           number   // 0.0–1.0
  mode:                     number   // 1=major, 0=minor (-1 if undetected)
  mode_confidence:          number   // 0.0–1.0
  codestring:               string   // ENMFP fingerprint (can be empty)
  code_version:             number
  echoprintstring:          string   // Echoprint fingerprint (can be empty)
  echoprint_version:        number
  synchstring:              string   // sync points (can be empty)
  synch_version:            number
  rhythmstring:             string   // rhythm pattern (can be empty)
  rhythm_version:           number
}
```

## bars / beats / tatums (identical structure)

```typescript
{
  start:      number  // onset time in seconds
  duration:   number  // interval length in seconds
  confidence: number  // 0.0–1.0
}
```

- **bars**: one per measure; typically 4 beats each
- **beats**: one per beat; duration ≈ 60/BPM seconds
- **tatums**: smallest metrical unit; typically 2 per beat (half-beat)

From Gangnam Style sample:
```json
{ "start": 0.8603, "duration": 1.71119, "confidence": 0.83 }   // bar
{ "start": 0.8603, "duration": 0.42132, "confidence": 0.574 }  // beat
```

## sections

```typescript
{
  start:                     number
  duration:                  number
  confidence:                number  // 0.0–1.0 (1.0 for first section)
  loudness:                  number  // dB
  tempo:                     number  // BPM
  tempo_confidence:          number  // 0.0–1.0
  key:                       number  // 0–11 (-1 undetected)
  key_confidence:            number
  mode:                      number  // 1=major, 0=minor, -1=undetected
  mode_confidence:           number
  time_signature:            number  // beats per measure
  time_signature_confidence: number
}
```

From Gangnam Style sample (first section):
```json
{
  "start": 0, "duration": 6.61277, "confidence": 1,
  "loudness": -15.379, "tempo": 137.788, "tempo_confidence": 0.467,
  "key": 11, "key_confidence": 0.263,
  "mode": 0, "mode_confidence": 0.353,
  "time_signature": 4, "time_signature_confidence": 0.818
}
```

## segments ← most important for the algorithm

```typescript
{
  start:             number   // onset time in seconds
  duration:          number   // segment length in seconds
  confidence:        number   // segmentation confidence 0.0–1.0
  loudness_start:    number   // dB at segment start (e.g. -23.5)
  loudness_max:      number   // peak dB within segment (e.g. -12.1)
  loudness_max_time: number   // offset from start to peak (seconds)
  loudness_end:      number   // dB at segment end (often same as next loudness_start)
  pitches:           number[] // 12-element chroma vector, each value 0.0–1.0
                              // index 0=C, 1=C#, 2=D, ... 11=B
                              // normalized so max value = 1.0
  timbre:            number[] // 12 spectral coefficients (MFCC-like)
                              // NOT normalized to [0,1]; values roughly centered ~0
                              // coefficient 0 ≈ loudness/energy (always positive, ~150-350)
                              // coefficients 1-11 encode timbral shape
}
```

## Fingerprint fields (codestring, echoprintstring, synchstring, rhythmstring)

These are encoded binary fingerprints. For the Infinite Jukebox algorithm they
are **not used** — we can return empty strings for all of them.

## Notes on Internal Consistency

The Infinite Jukebox algorithm requires that **similar-sounding beats produce
similar feature vectors**. Absolute accuracy vs. the original Spotify values
matters less than internal consistency:

- Two beats that sound alike should have small `pitches` and `timbre` distances
- The 10x higher weight on pitch means chroma accuracy is critical
- The 100x weight on duration means segment boundaries must be stable
- `confidence` is used as a weight; low-confidence segments are sometimes merged

## Calibration Reference

Gangnam Style Spotify track ID: `03UrZgTINDqvnUMbbIMhql`
Sample JSON: https://github.com/rigdern/InfiniteJukeboxAlgorithm/blob/master/data/gangnamStyleAnalysis.json
