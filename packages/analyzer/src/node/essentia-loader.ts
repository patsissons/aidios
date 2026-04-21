/**
 * Node.js essentia loader — uses createRequire for CJS essentia.js module.
 */

import { createRequire } from 'node:module'
import { EssentiaWrapper } from '../essentia-wrapper.ts'
import { setEssentia } from '../essentia-singleton.ts'

let loaded = false

/**
 * Load essentia.js via Node CJS require and register the singleton.
 * Safe to call multiple times — only loads once.
 */
export async function loadNodeEssentia(): Promise<void> {
  if (loaded) return
  const require = createRequire(import.meta.url)
  const { EssentiaWASM, Essentia } = require('essentia.js')
  // EssentiaWASM is already loaded — do NOT call it as a function
  setEssentia(new EssentiaWrapper(new Essentia(EssentiaWASM)))
  loaded = true
}
