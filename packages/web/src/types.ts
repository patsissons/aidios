/** Client-side types for the jukebox web app */

export interface TimeInterval {
  start: number
  duration: number
  confidence: number
}

export interface Section extends TimeInterval {
  loudness: number
  tempo: number
  tempo_confidence: number
  key: number
  key_confidence: number
  mode: number
  mode_confidence: number
  time_signature: number
  time_signature_confidence: number
}

export interface Segment extends TimeInterval {
  loudness_start: number
  loudness_max: number
  loudness_max_time: number
  loudness_end: number
  pitches: number[]
  timbre: number[]
}

export interface TrackSummary {
  num_samples: number
  duration: number
  sample_md5: string
  analysis_sample_rate: number
  tempo: number
  tempo_confidence: number
  key: number
  key_confidence: number
  mode: number
  mode_confidence: number
  time_signature: number
  loudness: number
  end_of_fade_in: number
  start_of_fade_out: number
}

export interface AudioAnalysis {
  meta: { analyzer_version: string; analysis_time: number }
  track: TrackSummary
  bars: TimeInterval[]
  beats: TimeInterval[]
  tatums: TimeInterval[]
  sections: Section[]
  segments: Segment[]
}

/** Runtime quantum — beat/bar/tatum/section with graph links */
export interface Quantum extends TimeInterval {
  which: number
  prev: Quantum | null
  next: Quantum | null
  parent?: Quantum
  children?: Quantum[]
  indexInParent?: number
  oseg?: Segment
  overlappingSegments?: Segment[]
  neighbors?: Edge[]
  all_neighbors?: Edge[]
  reach?: number
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
    fsegments?: Segment[]
  }
}

export interface TuneParams {
  threshold: number
  minBranchProb: number
  maxBranchProb: number
  rampUpSpeed: number
  loopExtension: boolean
  reverseOnly: boolean
  longOnly: boolean
  noSequential: boolean
  volume: number
}

export const DEFAULT_TUNE: TuneParams = {
  threshold: 20,
  minBranchProb: 0.18,
  maxBranchProb: 0.50,
  rampUpSpeed: 0.018,   // +1.8% per beat — matches original EternalJukebox
  loopExtension: true,
  reverseOnly: false,
  longOnly: false,
  noSequential: false,
  volume: 0.8,
}
