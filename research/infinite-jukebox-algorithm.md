# Infinite Jukebox Algorithm — Research

Source: https://github.com/rigdern/InfiniteJukeboxAlgorithm

## Repository Structure

```
js/
  algorithm/
    InfiniteBeats.js           # Main class — branching playback controller
    calculateNearestNeighbors.js  # Builds similarity graph between beats
    remixTrack.js              # Preprocesses Spotify analysis into quanta hierarchy
    random.js                  # Deterministic pseudo-random (1000-value cycle)
  examples/
    basic/main.js              # Minimal usage example
    playerAndVisualizer/       # Full browser player with visualization
tools/
  spotifyAudioAnalysisClient/  # Node.js tool to fetch Spotify analysis JSON
  spotifyBeatMetronome/        # Tool for beat sync verification
data/
  gangnamStyleAnalysis.json    # Sample Spotify analysis (754KB) — ground truth
```

## Input Data Format

The algorithm expects exactly the Spotify Audio Analysis API response format
(`GET /v1/audio-analysis/{id}`). Top-level structure:

```json
{
  "meta": { ... },
  "track": { ... },
  "bars":     [{ "start": float, "duration": float, "confidence": float }],
  "beats":    [{ "start": float, "duration": float, "confidence": float }],
  "tatums":   [{ "start": float, "duration": float, "confidence": float }],
  "sections": [{ "start", "duration", "confidence", "loudness", "tempo",
                 "tempo_confidence", "key", "key_confidence", "mode",
                 "mode_confidence", "time_signature", "time_signature_confidence" }],
  "segments": [{ "start", "duration", "confidence",
                 "loudness_start", "loudness_max", "loudness_max_time", "loudness_end",
                 "pitches": [12 floats],
                 "timbre": [12 floats] }]
}
```

The algorithm accesses these as `track.analysis.beats`, `track.analysis.segments`, etc.
The wrapper in `InfiniteBeats.js` maps the root JSON into `{ analysis: { beats, bars, ... } }`.

## Algorithm Overview

### Step 1 — remixTrack(track)

Preprocesses the flat Spotify JSON into a rich quanta hierarchy:

1. Adds `.which` (index), `.prev`, `.next` to every element in all 5 arrays
2. Builds parent→children relationships:
   - sections → bars → beats → tatums → segments (by time overlap)
3. Connects each beat/bar/tatum to:
   - `.oseg` — first overlapping segment
   - `.overlappingSegments[]` — all segments that overlap this quantum
4. Runs `filterSegments()` — merges low-confidence segments that are
   timbrally similar to their predecessor (threshold: confidence < 0.3 AND
   euclidean distance of first 3 timbre coefficients < 1.0)
   Result stored as `trackAnalysis.fsegments`

### Step 2 — calculateNearestNeighbors(track)

Builds a similarity graph using `dynamicCalculateNearestNeighbors('beats')`:

**Distance metric** for two beats (via their overlapping segments):

```
distance = (
  timbre_weighted_euclidean(seg1, seg2) * 1    +   // timbreWeight
  pitch_euclidean(seg1, seg2)           * 10   +   // pitchWeight
  |seg1.loudness_start - seg2.loudness_start|  * 1 +   // loudStartWeight
  |seg1.loudness_max   - seg2.loudness_max|    * 1 +   // loudMaxWeight
  |seg1.duration       - seg2.duration|        * 100 + // durationWeight
  |seg1.confidence     - seg2.confidence|      * 1    // confidenceWeight
) / num_overlapping_segments

+ (indexInParent differs ? 100 : 0)   // position-in-bar penalty
```

Note: `pitchWeight = 10` makes pitch 10x more important than timbre.
`durationWeight = 100` strongly penalises duration mismatch.

**Timbre distance**: weighted euclidean over all 12 coefficients (weight=1.0 each)
**Pitch distance**: standard euclidean over all 12 chroma values

**Neighbor selection**:
- Max 4 neighbors per beat (`maxBranches = 4`)
- Global max threshold: 80 (`maxBranchThreshold`)
- Dynamic threshold: starts at 10, increases by 5 until `beats.length / 6` beats have at least one neighbor
- Post-processing ensures at least one long backward branch exists (>50% of song)
- `calculateReachability()` propagates reach scores
- `findBestLastBeat()` finds optimal loop point (>50% reach threshold)
- `filterOutBadBranches()` removes branches past the last branch point

### Step 3 — InfiniteBeats(spotifyAnalysis)

Playback controller:

```javascript
// Branching probability:
minRandomBranchChance = 0.18   // 18% minimum
maxRandomBranchChance = 0.50   // 50% maximum
randomBranchChanceDelta = 0.018  // +1.8% per beat, reset to 18% after branch

// At lastBranchPoint: always branch (forced loop)
// Otherwise: branch if random() < curChance AND beat has neighbors
```

- `getNextBeat(currentBeat)` — returns next beat (or undefined at end)
- `_selectRandomNextBeat(beat)` — rotates through neighbors using a circular queue
- Non-sequential jumps require a seek operation in the audio player

## Key Implementation Notes

1. The algorithm ONLY uses `beats` for branching (not bars or tatums)
2. `timbre` weighted euclidean uses weight=1.0 for ALL 12 coefficients
   (a commented-out line suggests first 4 were considered at one point)
3. `filterSegments` uses only FIRST 3 timbre coefficients for similarity check
4. `indexInParent` (position of beat within its bar) adds a 100-point penalty
   for branching between beats at different positions in a bar — this keeps
   branches musically sensible
5. The algorithm deep-clones the input JSON before modifying it

## Exact Field Access Patterns

```javascript
// In remixTrack.js:
track.analysis.sections / bars / beats / tatums / segments
q.start, q.duration, q.confidence
q.which, q.prev, q.next, q.parent, q.children, q.indexInParent
q.oseg, q.overlappingSegments[]
seg.timbre[], seg.pitches[]  // (pitches used in distance; timbre in filter)

// In calculateNearestNeighbors.js:
track.analysis[type]         // type = 'beats'
q.which, q.overlappingSegments[], q.indexInParent
q.all_neighbors[], q.neighbors[], q.reach
seg.timbre[0..11], seg.pitches[0..11]  (pitches called via seg[field])
seg.loudness_start, seg.loudness_max
seg.duration, seg.confidence
edge.id, edge.src, edge.dest, edge.distance

// In InfiniteBeats.js:
beat.which, beat.neighbors[]
```
