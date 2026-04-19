# EchoNest / pyechonest — Reference

Source: https://github.com/echonest/pyechonest
Docs: https://echonest.github.io/pyechonest/track.html

## Overview

EchoNest was an audio analysis platform acquired by Spotify in 2014. Spotify integrated
EchoNest's algorithms into the Spotify Web API as the Audio Analysis endpoint. The data
format we are recreating IS the Spotify Audio Analysis format (EchoNest's format, live
under a different name until the API was deprecated in 2024).

## Track Properties — Complete List

### Always Available (from track/profile)

| Property | Type | Description |
|---|---|---|
| `id` | str | Echo Nest Track ID (e.g. 'TRTOBXJ1296BCDA33B') |
| `md5` | str | 32-char checksum of original audio file |
| `song_id` | str | Echo Nest song ID if known |
| `title` | str or None | Song title |
| `artist` | str or None | Artist name |
| `artist_id` | str | Echo Nest artist ID |
| `acousticness` | float 0-1 | Confidence track is acoustic |
| `danceability` | float 0-1 | Relative danceability |
| `energy` | float 0-1 | Relative energy |
| `liveness` | float 0-1 | Confidence track is live |
| `loudness` | float dB | Overall loudness |
| `speechiness` | float 0-1 | Likelihood of speech content |
| `tempo` | float BPM | Overall beats per minute |
| `valence` | float 0-1 | Negative to positive emotional content |
| `key` | int 0-11 | 0=C, 1=C#, ..., 11=B |
| `mode` | int | 0=major, 1=minor (NOTE: inverted in Spotify API!) |
| `time_signature` | int | Beats per measure |
| `duration` | float | Length in seconds |
| `status` | str | 'complete', 'pending', 'error' |

### Available After get_analysis() — Timing Structures

| Property | Type | Description |
|---|---|---|
| `bars` | list[dict] | Measure timing — {start, duration, confidence} |
| `beats` | list[dict] | Beat timing — {start, duration, confidence} |
| `tatums` | list[dict] | Sub-beat timing — {start, duration, confidence} |
| `segments` | list[dict] | Acoustic segments — see below |
| `sections` | list[dict] | Large structural sections — see below |
| `analysis_channels` | int | Audio channels during analysis |
| `analysis_sample_rate` | int | Sample rate during analysis |
| `num_samples` | int | Total decoded samples |
| `end_of_fade_in` | float | Seconds where fade-in ends |
| `start_of_fade_out` | float | Seconds where fade-out begins |
| `key_confidence` | float | Confidence for key detection |
| `mode_confidence` | float | Confidence for mode detection |
| `tempo_confidence` | float | Confidence for tempo detection |
| `time_signature_confidence` | float | Confidence for time_signature |
| `sample_md5` | str | Checksum of decoded audio |
| `codestring` | str | ENMFP fingerprint |
| `code_version` | str | ENMFP version |
| `echoprintstring` | str | Echoprint fingerprint |
| `echoprint_version` | str | Echoprint version |
| `synchstring` | str | Synchronization points |
| `synch_version` | str | Synch string version |
| `meta` | dict | {bitrate, album, genre, filename, analysis_time, etc.} |
| `decoder` | str | Audio decoder used (e.g. 'ffmpeg') |
| `offset_seconds` | int | Always 0 |
| `window_seconds` | int | Always 0 |

### Segment Structure (most detail)

```python
{
    'start':             float,   # onset time (seconds)
    'duration':          float,   # segment length (seconds)
    'confidence':        float,   # 0.0–1.0
    'loudness_start':    float,   # dB at start
    'loudness_max':      float,   # peak dB
    'loudness_max_time': float,   # offset to peak (seconds)
    'loudness_end':      float,   # dB at end
    'pitches':           [float * 12],  # chroma vector, each 0.0–1.0
    'timbre':            [float * 12],  # spectral shape, roughly centered at 0
}
```

### Section Structure

```python
{
    'start':                     float,
    'duration':                  float,
    'confidence':                float,
    'loudness':                  float,  # dB
    'tempo':                     float,  # BPM
    'tempo_confidence':          float,
    'key':                       int,    # 0–11
    'key_confidence':            float,
    'mode':                      int,    # 1=major, 0=minor
    'mode_confidence':           float,
    'time_signature':            int,
    'time_signature_confidence': float,
}
```

## API Endpoints (historical reference)

```
POST /v1/track/upload   — upload audio file for analysis
GET  /v1/track/profile  — get track profile by ID or md5
GET  /v1/track/analyze  — trigger analysis of existing track
```

The `analysis_url` field in a track profile response pointed to a time-expiring
URL that returned the full detailed analysis JSON (bars, beats, segments, etc.).

## Note on mode encoding

pyechonest docs say: `mode: int: 0 (major) or 1 (minor)`
Spotify API says:    `mode: 1=major, 0=minor`

These are OPPOSITE conventions. The Spotify format (1=major, 0=minor) is correct
for the data we need to produce — the pyechonest wrapper had the description wrong.
Use Spotify convention: **1=major, 0=minor**.

## What We Don't Need to Reproduce

- `codestring` / `echoprintstring` / `synchstring` / `rhythmstring` — return empty strings
- `analysis_url` — we return the full analysis directly in the response body
- `song_id`, `artist_id` — optional metadata, can be null/empty
- `danceability`, `energy`, `valence`, `liveness`, `speechiness`, `acousticness` — not used
  by the Infinite Jukebox algorithm (nice to have but not required)
