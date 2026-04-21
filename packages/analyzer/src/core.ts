/**
 * Platform-agnostic core exports.
 *
 * Import from '@aidios/analyzer/core' when you only need the shared
 * pipeline, types, and DSP modules — no platform-specific code.
 */

export { SAMPLE_RATE, RHYTHM_SAMPLE_RATE, type DecodedAudio, type AudioDecoder } from './platform.ts'
export { EssentiaWrapper, type RhythmResult, type KeyResult, type SpectralFrame } from './essentia-wrapper.ts'
export { getEssentia, setEssentia } from './essentia-singleton.ts'
export { runPipeline, type PipelineOptions } from './pipeline-core.ts'
export { extractGlobalFeatures, type GlobalFeatures } from './globals.ts'
export { detectOnsets, buildSegmentBoundaries } from './segments.ts'
export { extractAllSegments } from './features.ts'
export { detectSections } from './sections.ts'
