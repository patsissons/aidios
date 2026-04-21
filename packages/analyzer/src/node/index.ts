/**
 * Node.js entry point for @aidios/analyzer.
 *
 * Provides the backwards-compatible analyzeAudio(filePath, opts) API
 * using ffmpeg for decoding and CJS essentia.js.
 */

import { NodeDecoder } from './decoder.ts'
import { loadNodeEssentia } from './essentia-loader.ts'
import { runPipeline, type PipelineOptions } from '../pipeline-core.ts'
import type { AudioAnalysis } from '@aidios/types'

const decoder = new NodeDecoder()

export interface AnalysisOptions {
  onsetThreshold?: number
  logProgress?: boolean
}

/**
 * Full audio analysis pipeline (Node.js).
 * Accepts a file path, returns AudioAnalysis JSON.
 */
export async function analyzeAudio(
  filePath: string,
  opts: AnalysisOptions = {},
): Promise<AudioAnalysis> {
  await loadNodeEssentia()
  return runPipeline(decoder, filePath, {
    onsetThreshold: opts.onsetThreshold,
    logProgress: opts.logProgress,
    platformLabel: `Node.js ${process.version}`,
  })
}
