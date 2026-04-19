import { z } from 'zod'

// ─── Core types ───────────────────────────────────────────────────────────────

export interface TimeInterval {
  start: number       // seconds from track start
  duration: number    // seconds
  confidence: number  // 0.0–1.0
}

export interface Section extends TimeInterval {
  loudness: number
  tempo: number
  tempo_confidence: number
  key: number               // 0–11 (C through B)
  key_confidence: number
  mode: number              // 0=minor, 1=major
  mode_confidence: number
  time_signature: number    // beats per measure (typically 4)
  time_signature_confidence: number
}

export interface Segment extends TimeInterval {
  loudness_start: number      // dB at segment start
  loudness_max: number        // peak dB within segment
  loudness_max_time: number   // offset of peak from segment start (seconds)
  loudness_end: number        // dB at segment end
  pitches: number[]           // 12-element chroma vector, each 0.0–1.0, max=1.0
  timbre: number[]            // 12 MFCC-like spectral coefficients
}

export interface TrackSummary {
  num_samples: number
  duration: number
  sample_md5: string
  offset_seconds: number
  window_seconds: number
  analysis_sample_rate: number
  analysis_channels: number
  end_of_fade_in: number
  start_of_fade_out: number
  loudness: number
  tempo: number
  tempo_confidence: number
  time_signature: number
  time_signature_confidence: number
  key: number
  key_confidence: number
  mode: number
  mode_confidence: number
  // EchoNest fingerprint fields — empty for aidios output
  codestring: string
  code_version: number
  echoprintstring: string
  echoprint_version: number
  synchstring: string
  synch_version: number
  rhythmstring: string
  rhythm_version: number
}

export interface AnalysisMeta {
  analyzer_version: string    // e.g. 'aidios-0.1.0'
  platform: string            // e.g. 'Node.js'
  detailed_status: string     // e.g. 'OK'
  status_code: number         // 0 = success
  timestamp: number           // unix epoch seconds
  analysis_time: number       // seconds elapsed to produce this analysis
  input_process: string       // e.g. 'ffmpeg'
}

export interface AudioAnalysis {
  meta: AnalysisMeta
  track: TrackSummary
  bars: TimeInterval[]
  beats: TimeInterval[]
  tatums: TimeInterval[]
  sections: Section[]
  segments: Segment[]
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

export const TimeIntervalSchema = z.object({
  start: z.number(),
  duration: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
})

export const SectionSchema = TimeIntervalSchema.extend({
  loudness: z.number(),
  tempo: z.number().positive(),
  tempo_confidence: z.number().min(0).max(1),
  key: z.number().int().min(0).max(11),
  key_confidence: z.number().min(0).max(1),
  mode: z.number().int().min(0).max(1),
  mode_confidence: z.number().min(0).max(1),
  time_signature: z.number().int().positive(),
  time_signature_confidence: z.number().min(0).max(1),
})

export const SegmentSchema = TimeIntervalSchema.extend({
  loudness_start: z.number(),
  loudness_max: z.number(),
  loudness_max_time: z.number().nonnegative(),
  loudness_end: z.number(),
  pitches: z.array(z.number().min(0).max(1)).length(12),
  timbre: z.array(z.number()).length(12),
})

export const TrackSummarySchema = z.object({
  num_samples: z.number().int().nonnegative(),
  duration: z.number().positive(),
  sample_md5: z.string(),
  offset_seconds: z.number(),
  window_seconds: z.number(),
  analysis_sample_rate: z.number().positive(),
  analysis_channels: z.number().int().positive(),
  end_of_fade_in: z.number().nonnegative(),
  start_of_fade_out: z.number().nonnegative(),
  loudness: z.number(),
  tempo: z.number().positive(),
  tempo_confidence: z.number().min(0).max(1),
  time_signature: z.number().int().positive(),
  time_signature_confidence: z.number().min(0).max(1),
  key: z.number().int().min(0).max(11),
  key_confidence: z.number().min(0).max(1),
  mode: z.number().int().min(0).max(1),
  mode_confidence: z.number().min(0).max(1),
  codestring: z.string(),
  code_version: z.number(),
  echoprintstring: z.string(),
  echoprint_version: z.number(),
  synchstring: z.string(),
  synch_version: z.number(),
  rhythmstring: z.string(),
  rhythm_version: z.number(),
})

export const AnalysisMetaSchema = z.object({
  analyzer_version: z.string(),
  platform: z.string(),
  detailed_status: z.string(),
  status_code: z.number().int(),
  timestamp: z.number(),
  analysis_time: z.number().nonnegative(),
  input_process: z.string(),
})

export const AudioAnalysisSchema = z.object({
  meta: AnalysisMetaSchema,
  track: TrackSummarySchema,
  bars: z.array(TimeIntervalSchema),
  beats: z.array(TimeIntervalSchema),
  tatums: z.array(TimeIntervalSchema),
  sections: z.array(SectionSchema),
  segments: z.array(SegmentSchema),
})
