/**
 * Main-thread wrapper for browser-based audio analysis.
 *
 * 1. Decodes audio on the main thread (OfflineAudioContext requires main thread)
 * 2. Transfers pre-decoded PCM to a Web Worker
 * 3. Worker runs essentia.js WASM analysis pipeline
 */

import type { AudioAnalysis } from './types'
import { decodeAudioBuffer } from '@aidios/analyzer/browser'

export async function analyzeInBrowser(
  file: File,
  onProgress?: (message: string) => void,
): Promise<AudioAnalysis> {
  // Step 1: Decode on main thread
  onProgress?.('Decoding audio...')
  const arrayBuffer = await file.arrayBuffer()
  const decoded = await decodeAudioBuffer(arrayBuffer)

  // Step 2: Send decoded PCM to worker for analysis
  onProgress?.('Starting analysis...')

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./analysis-worker.ts', import.meta.url),
      { type: 'module' },
    )

    worker.onmessage = (e: MessageEvent) => {
      const { type } = e.data
      if (type === 'progress') {
        onProgress?.(e.data.message)
      } else if (type === 'complete') {
        resolve(e.data.result as AudioAnalysis)
        worker.terminate()
      } else if (type === 'error') {
        reject(new Error(e.data.message))
        worker.terminate()
      }
    }

    worker.onerror = (e) => {
      reject(new Error(e.message))
      worker.terminate()
    }

    // Transfer the Float32Array buffers (zero-copy)
    worker.postMessage(decoded, [
      decoded.audio.buffer,
      decoded.rhythmAudio.buffer,
    ])
  })
}
