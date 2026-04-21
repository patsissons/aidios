/**
 * Browser essentia loader — uses ESM imports of the browser WASM build.
 */

import { EssentiaWrapper } from '../essentia-wrapper.ts'
import { setEssentia } from '../essentia-singleton.ts'

let loaded = false

/**
 * Load essentia.js WASM in the browser and register the singleton.
 * Safe to call multiple times — only loads once.
 *
 * The essentia.js package provides browser-ready builds:
 * - essentia-wasm.es.js exports { EssentiaWASM } — a factory that fetches + instantiates WASM
 * - essentia.js-core.es.js exports Essentia as default — the JS API wrapper
 */
export async function loadBrowserEssentia(): Promise<void> {
  if (loaded) return

  // Dynamic imports so these are only pulled into browser bundles
  const [wasmModule, coreModule] = await Promise.all([
    import('essentia.js/dist/essentia-wasm.es.js'),
    import('essentia.js/dist/essentia.js-core.es.js'),
  ])

  // EssentiaWASM is already loaded — do NOT call it as a function
  const EssentiaWASM = wasmModule.EssentiaWASM
  const Essentia = coreModule.default
  const essentia = new Essentia(EssentiaWASM)

  setEssentia(new EssentiaWrapper(essentia))
  loaded = true
}
