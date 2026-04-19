/**
 * InfiniteBeats — branching playback controller
 *
 * Walks the beat similarity graph built by calculateNearestNeighbors.
 * At each beat, there's an 18% chance of branching to a similar beat.
 * After a successful branch, the probability resets to 18%.
 * If no branch occurs, probability increases toward 50% over time.
 *
 * Usage:
 *   const jukebox = new InfiniteBeats(track)
 *   while (true) {
 *     const beat = jukebox.nextBeat()
 *     // schedule audio playback at beat.start for beat.duration seconds
 *   }
 */

import type { Quantum, JukeboxTrack } from './types.ts'

const INITIAL_BRANCH_PROBABILITY = 0.18
const MAX_BRANCH_PROBABILITY = 0.5
const BRANCH_PROBABILITY_INCREMENT = 0.02

export class InfiniteBeats {
  private track: JukeboxTrack
  private current: Quantum
  private branchProbability = INITIAL_BRANCH_PROBABILITY

  constructor(track: JukeboxTrack) {
    this.track = track
    const beats = track.analysis.beats
    if (beats.length === 0) throw new Error('Track has no beats')
    this.current = beats[0]
  }

  /**
   * Advance to the next beat and return it.
   * May branch to a similar beat based on the similarity graph.
   */
  nextBeat(): Quantum {
    const beat = this.current
    this.current = this.advance(beat)
    return beat
  }

  /** Returns the current beat without advancing. */
  currentBeat(): Quantum {
    return this.current
  }

  private advance(beat: Quantum): Quantum {
    const neighbors = beat.neighbors ?? []

    // Attempt a branch if neighbors exist and random chance fires
    if (neighbors.length > 0 && Math.random() < this.branchProbability) {
      const dest = this.pickNeighbor(neighbors)
      if (dest) {
        this.branchProbability = INITIAL_BRANCH_PROBABILITY
        return dest
      }
    }

    // No branch — increase probability for next time, cap at max
    this.branchProbability = Math.min(
      this.branchProbability + BRANCH_PROBABILITY_INCREMENT,
      MAX_BRANCH_PROBABILITY,
    )

    // Normal sequential advance; wrap at end of beats array
    return beat.next ?? this.track.analysis.beats[0]
  }

  private pickNeighbor(neighbors: typeof this.current.neighbors & object): Quantum | null {
    if (!neighbors || neighbors.length === 0) return null
    // Pick randomly from available neighbors (all are within the threshold)
    const edge = neighbors[Math.floor(Math.random() * neighbors.length)]
    return edge.dest
  }

  /** Reset to the beginning of the track. */
  reset(): void {
    this.current = this.track.analysis.beats[0]
    this.branchProbability = INITIAL_BRANCH_PROBABILITY
  }
}
