import type { AudioAnalysis, Segment } from '@aidios/types'

/**
 * A "quantum" is any time unit in the hierarchy: section, bar, beat, tatum.
 * remixTrack.js adds runtime properties (prev, next, parent, children, etc.)
 * to the plain TimeInterval objects from the AudioAnalysis.
 */
export interface Quantum {
  start: number
  duration: number
  confidence: number
  which: number                     // index in its array
  prev: Quantum | null
  next: Quantum | null
  track: JukeboxTrack
  parent?: Quantum                  // the containing level (e.g. bar for a beat)
  children?: Quantum[]              // contained level (e.g. beats in a bar)
  indexInParent?: number            // position of this quantum within its parent
  oseg?: Segment                    // first overlapping segment
  overlappingSegments?: Segment[]   // all overlapping segments
  neighbors?: Edge[]                // branching edges within threshold
  all_neighbors?: Edge[]            // all candidate edges (before threshold filter)
  reach?: number                    // reachability score for loop detection
}

export interface Edge {
  id: number
  src: Quantum
  dest: Quantum
  distance: number
}

export interface JukeboxTrack {
  analysis: {
    sections: Quantum[]
    bars: Quantum[]
    beats: Quantum[]
    tatums: Quantum[]
    segments: Segment[]
    fsegments?: Segment[]    // filtered segments (set by remixTrack)
  }
}

export interface NearestNeighborResult {
  lastBranchPoint: number
}
