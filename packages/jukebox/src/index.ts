export type { Quantum, Edge, JukeboxTrack, NearestNeighborResult } from './types.ts'
export { remixTrack } from './remixTrack.ts'
export { calculateNearestNeighbors } from './calculateNearestNeighbors.ts'
export { InfiniteBeats } from './infiniteBeats.ts'

import type { AudioAnalysis } from '@aidios/types'
import type { JukeboxTrack } from './types.ts'
import { remixTrack } from './remixTrack.ts'
import { calculateNearestNeighbors } from './calculateNearestNeighbors.ts'

/**
 * Prepare a JukeboxTrack from raw AudioAnalysis JSON.
 * Runs remixTrack (builds hierarchy) and calculateNearestNeighbors (builds graph).
 *
 * @returns The prepared track, ready to pass to InfiniteBeats.
 */
export function prepareTrack(analysis: AudioAnalysis): JukeboxTrack {
  // Cast plain objects to Quantum (remixTrack adds runtime properties in place)
  const track = { analysis } as unknown as JukeboxTrack
  remixTrack(track)
  calculateNearestNeighbors(track)
  return track
}
