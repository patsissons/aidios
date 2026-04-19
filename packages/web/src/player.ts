/**
 * Web Audio API player for beat-level infinite jukebox playback.
 *
 * Decodes the audio file into an AudioBuffer, then schedules
 * beat-by-beat playback using the similarity graph for branching.
 */

import type { JukeboxTrack, Quantum, TuneParams } from './types'
import { DEFAULT_TUNE } from './types'

export type PlayerEvent =
  | { type: 'beat'; beat: Quantum; isBranch: boolean }
  | { type: 'stop' }

export class Player {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private gainNode: GainNode | null = null
  private track: JukeboxTrack | null = null
  private playing = false
  private currentBeat: Quantum | null = null
  private nextTime = 0
  private timerId: number | null = null
  private branchProb = 0.18
  private beatsPlayed = 0
  private startWallTime = 0
  private params: TuneParams = { ...DEFAULT_TUNE }
  private listener: ((e: PlayerEvent) => void) | null = null

  async loadAudio(file: File): Promise<void> {
    this.ctx = new AudioContext()
    this.gainNode = this.ctx.createGain()
    this.gainNode.connect(this.ctx.destination)
    this.gainNode.gain.value = this.params.volume

    const arrayBuffer = await file.arrayBuffer()
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer)
  }

  setTrack(track: JukeboxTrack): void {
    this.track = track
  }

  setParams(params: TuneParams): void {
    this.params = params
    if (this.gainNode) {
      this.gainNode.gain.value = params.volume
    }
  }

  onEvent(listener: (e: PlayerEvent) => void): void {
    this.listener = listener
  }

  isPlaying(): boolean {
    return this.playing
  }

  getListenTime(): number {
    if (!this.playing || !this.ctx) return 0
    return this.ctx.currentTime - this.startWallTime
  }

  getBeatsPlayed(): number {
    return this.beatsPlayed
  }

  play(): void {
    if (!this.ctx || !this.buffer || !this.track) return
    if (this.ctx.state === 'suspended') this.ctx.resume()

    if (!this.playing) {
      this.playing = true
      this.currentBeat = this.track.analysis.beats[0]
      this.nextTime = this.ctx.currentTime + 0.05 // small lead-in
      this.startWallTime = this.ctx.currentTime
      this.beatsPlayed = 0
      this.branchProb = this.params.minBranchProb
      this.scheduleNext()
    }
  }

  stop(): void {
    this.playing = false
    if (this.timerId !== null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
    this.listener?.({ type: 'stop' })
  }

  toggle(): void {
    if (this.playing) this.stop()
    else this.play()
  }

  seekTo(beatIndex: number): void {
    if (!this.track || !this.ctx || !this.buffer) return
    const beats = this.track.analysis.beats
    if (beatIndex < 0 || beatIndex >= beats.length) return

    const wasPlaying = this.playing
    if (wasPlaying) {
      // Cancel pending schedule
      if (this.timerId !== null) {
        clearTimeout(this.timerId)
        this.timerId = null
      }
    }

    this.currentBeat = beats[beatIndex]
    this.branchProb = this.params.minBranchProb

    if (wasPlaying) {
      this.nextTime = this.ctx.currentTime + 0.02
      this.scheduleNext()
    }

    this.listener?.({ type: 'beat', beat: this.currentBeat, isBranch: false })
  }

  private scheduleNext(): void {
    if (!this.playing || !this.ctx || !this.buffer || !this.currentBeat) return

    const beat = this.currentBeat
    this.playBeatAudio(beat, this.nextTime)

    const isBranch = this.beatsPlayed > 0 && beat !== this.currentBeat
    this.listener?.({ type: 'beat', beat, isBranch: false })
    this.beatsPlayed++

    // Determine next beat
    const next = this.pickNext(beat)
    const wasBranch = next !== beat.next && next !== this.track!.analysis.beats[0]

    if (wasBranch) {
      this.listener?.({ type: 'beat', beat: next, isBranch: true })
    }

    this.currentBeat = next
    this.nextTime += beat.duration

    // Schedule the next iteration
    const delay = Math.max(0, (this.nextTime - this.ctx.currentTime) * 1000 - 30)
    this.timerId = window.setTimeout(() => this.scheduleNext(), delay)
  }

  private playBeatAudio(beat: Quantum, when: number): void {
    if (!this.ctx || !this.buffer || !this.gainNode) return

    const source = this.ctx.createBufferSource()
    source.buffer = this.buffer
    source.connect(this.gainNode)

    // Schedule exact playback window for this beat
    const offset = Math.max(0, beat.start)
    const duration = beat.duration
    source.start(when, offset, duration)
  }

  private pickNext(beat: Quantum): Quantum {
    const neighbors = beat.neighbors ?? []

    if (neighbors.length > 0 && Math.random() < this.branchProb) {
      // Branch! Pick a random neighbor
      const edge = neighbors[Math.floor(Math.random() * neighbors.length)]
      this.branchProb = this.params.minBranchProb
      return edge.dest
    }

    // No branch — ramp up probability
    this.branchProb = Math.min(
      this.branchProb + this.params.rampUpSpeed,
      this.params.maxBranchProb,
    )

    // Advance sequentially; wrap at end
    return beat.next ?? this.track!.analysis.beats[0]
  }
}
