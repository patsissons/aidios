/**
 * Web Worker that runs the audio analysis pipeline in a background thread.
 *
 * Receives pre-decoded PCM data (decoded on the main thread via
 * OfflineAudioContext, which isn't available in workers).
 */

import { PreDecodedDecoder, loadBrowserEssentia } from '@aidios/analyzer/browser'
import type { PreDecodedData } from '@aidios/analyzer/browser'
import { runPipeline } from '@aidios/analyzer/core'

self.onmessage = async (e: MessageEvent<PreDecodedData>) => {
  try {
    self.postMessage({ type: 'progress', message: 'Loading analysis engine...' })
    await loadBrowserEssentia()

    const decoder = new PreDecodedDecoder(e.data)

    const result = await runPipeline(decoder, undefined as void, {
      onProgress: (msg: string) => self.postMessage({ type: 'progress', message: msg }),
      platformLabel: 'Browser',
    })

    self.postMessage({ type: 'complete', result })
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
