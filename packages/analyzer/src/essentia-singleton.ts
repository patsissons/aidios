/**
 * Essentia singleton registry.
 *
 * Platform-specific code (Node or Browser) calls setEssentia() during init.
 * DSP modules call getEssentia() to access the shared instance.
 */

import type { EssentiaWrapper } from './essentia-wrapper.ts'

let instance: EssentiaWrapper | null = null

export function getEssentia(): EssentiaWrapper {
  if (!instance) {
    throw new Error('Essentia not initialized. Call setEssentia() before running analysis.')
  }
  return instance
}

export function setEssentia(wrapper: EssentiaWrapper): void {
  instance = wrapper
}
