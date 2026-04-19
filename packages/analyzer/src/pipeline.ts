/**
 * Phase 8 — Full analysis pipeline
 *
 * Orchestrates all extractors to produce a complete AudioAnalysis JSON.
 */

import { createHash } from 'node:crypto'
import type { AudioAnalysis, TrackSummary, AnalysisMeta } from '@aidios/types'
import { decodeAudio, SAMPLE_RATE, type DecodedAudio } from './decoder.ts'
import {
  extractGlobalFeatures,
  buildBeats, buildTatums, buildBars,
  type GlobalFeatures,
} from './globals.ts'
import { detectOnsets, buildSegmentBoundaries } from './segments.ts'
import { extractAllSegments } from './features.ts'
import { detectSections } from './sections.ts'

const ANALYZER_VERSION = 'aidios-0.1.0'

function buildMeta(analysisMs: number): AnalysisMeta {
  return {
    analyzer_version: ANALYZER_VERSION,
    platform: `Node.js ${process.version}`,
    detailed_status: 'OK',
    status_code: 0,
    timestamp: Math.floor(Date.now() / 1000),
    analysis_time: analysisMs / 1000,
    input_process: 'ffmpeg',
  }
}

function buildTrack(audio: DecodedAudio, globals: GlobalFeatures): TrackSummary {
  return {
    num_samples: audio.numSamples,
    duration: audio.duration,
    sample_md5: audio.md5,
    offset_seconds: 0,
    window_seconds: 0,
    analysis_sample_rate: audio.sampleRate,
    analysis_channels: 1,
    end_of_fade_in: globals.endOfFadeIn,
    start_of_fade_out: globals.startOfFadeOut,
    loudness: globals.overallLoudness,
    tempo: globals.bpm,
    tempo_confidence: globals.bpmConfidence,
    time_signature: globals.timeSig,
    time_signature_confidence: 1.0,
    key: globals.keyInt,
    key_confidence: globals.keyConfidence,
    mode: globals.modeInt,
    mode_confidence: globals.modeConfidence,
    // EchoNest fingerprint fields — not computed by aidios
    codestring: '',
    code_version: 0,
    echoprintstring: '',
    echoprint_version: 0,
    synchstring: '',
    synch_version: 0,
    rhythmstring: '',
    rhythm_version: 0,
  }
}

export interface AnalysisOptions {
  onsetThreshold?: number   // SuperFlux threshold for segments (default 0.05)
  logProgress?: boolean     // log phase timings to console
}

/**
 * Full audio analysis pipeline.
 * Accepts a file path, returns AudioAnalysis JSON.
 * Typical runtime: ~75s for a 8-minute track.
 */
export async function analyzeAudio(
  filePath: string,
  opts: AnalysisOptions = {},
): Promise<AudioAnalysis> {
  const { onsetThreshold = 0.05, logProgress = false } = opts
  const t0 = Date.now()
  const log = logProgress ? (msg: string) => console.log(msg) : () => {}

  // Phase 1: Decode
  log('[1/6] Decoding audio...')
  const audio = await decodeAudio(filePath)
  log(`  Done: ${audio.duration.toFixed(1)}s, ${audio.numSamples.toLocaleString()} samples [${Date.now()-t0}ms]`)

  // Phase 2: Global features (beats, key, loudness, fades)
  log('[2/6] Extracting global features...')
  const t2 = Date.now()
  const globals = extractGlobalFeatures(audio)
  log(`  BPM: ${globals.bpm.toFixed(1)}, Key: ${globals.keyInt}/${globals.modeInt}, Beats: ${globals.beatTimes.length} [${Date.now()-t2}ms]`)

  // Phase 3: Beat structures
  const beats = buildBeats(globals.beatTimes, globals.bpmConfidence)
  const tatums = buildTatums(globals.beatTimes, globals.bpmConfidence)
  const bars = buildBars(globals.beatTimes, globals.timeSig, globals.bpmConfidence)
  log(`  Bars: ${bars.length}, Beats: ${beats.length}, Tatums: ${tatums.length}`)

  // Phase 4: Onset detection → segment boundaries
  log('[3/6] Detecting segment onsets...')
  const t4 = Date.now()
  const onsets = detectOnsets(audio, onsetThreshold)
  const segmentBoundaries = buildSegmentBoundaries(onsets, audio.duration)
  log(`  ${segmentBoundaries.length} segments (avg ${(audio.duration / segmentBoundaries.length).toFixed(2)}s) [${Date.now()-t4}ms]`)

  // Phase 5: Per-segment feature extraction
  log('[4/6] Extracting segment features...')
  const t5 = Date.now()
  const segments = extractAllSegments(audio, segmentBoundaries)
  log(`  Done [${Date.now()-t5}ms]`)

  // Phase 6: Section detection (coarser)
  log('[5/6] Detecting sections...')
  const t6 = Date.now()
  const sections = detectSections(audio, globals)
  log(`  ${sections.length} sections [${Date.now()-t6}ms]`)

  // Assemble
  log('[6/6] Assembling output...')
  const totalMs = Date.now() - t0
  const analysis: AudioAnalysis = {
    meta: buildMeta(totalMs),
    track: buildTrack(audio, globals),
    bars,
    beats,
    tatums,
    sections,
    segments,
  }

  log(`  Total: ${(totalMs / 1000).toFixed(1)}s`)
  return analysis
}
