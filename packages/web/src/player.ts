/**
 * Web Audio API player for beat-level infinite jukebox playback.
 *
 * Decodes the audio file into an AudioBuffer, then schedules
 * beat-by-beat playback using the similarity graph for branching.
 */

import type { JukeboxTrack, Quantum, TuneParams } from './types'
import { DEFAULT_TUNE } from './types'

const START_LEAD_SECONDS = 0.08
const SEEK_LEAD_SECONDS = 0.03
const RETUNE_LEAD_SECONDS = 0.02
const RETUNE_CROSSFADE_SECONDS = 0.025
const MIN_GAIN = 0.0001
const FADE_CURVE_STEPS = 32

interface ScheduledRun {
  source: AudioBufferSourceNode
  gain: GainNode
  startTime: number
  sourceOffset: number
}

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
  private nextBeatIsBranch = false
  private audibleBeat: Quantum | null = null
  private audibleBeatStartTime = 0
  private params: TuneParams = { ...DEFAULT_TUNE }
  private listener: ((e: PlayerEvent) => void) | null = null
  private currentRun: ScheduledRun | null = null
  private activeRuns = new Set<ScheduledRun>()
  private eventTimerIds = new Set<number>()

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

  setTransitionParams(params: TuneParams): void {
    this.setParams(params)
    this.rescheduleFromAudiblePosition()
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
      this.nextTime = this.ctx.currentTime + START_LEAD_SECONDS
      this.startWallTime = this.ctx.currentTime
      this.beatsPlayed = 0
      this.nextBeatIsBranch = false
      this.audibleBeat = this.currentBeat
      this.audibleBeatStartTime = this.nextTime
      this.branchProb = this.params.minBranchProb
      this.currentRun = this.startRun(this.currentBeat, this.nextTime, 0)
      this.scheduleNext()
    }
  }

  stop(): void {
    this.playing = false
    this.clearTimers()
    this.stopActiveSources()
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
      this.clearTimers()
      this.stopActiveSources()
    }

    this.currentBeat = beats[beatIndex]
    this.audibleBeat = this.currentBeat
    this.branchProb = this.params.minBranchProb
    this.nextBeatIsBranch = false

    if (wasPlaying) {
      this.nextTime = this.ctx.currentTime + SEEK_LEAD_SECONDS
      this.audibleBeatStartTime = this.nextTime
      this.currentRun = this.startRun(this.currentBeat, this.nextTime, 0)
      this.scheduleNext()
    }

    this.listener?.({ type: 'beat', beat: this.currentBeat, isBranch: false })
  }

  private scheduleNext(): void {
    if (!this.playing || !this.ctx || !this.buffer || !this.currentBeat) return

    const beat = this.currentBeat
    const isBranchIntoBeat = this.nextBeatIsBranch

    // Determine next beat before scheduling so branch transitions can crossfade.
    const next = this.pickNext(beat)
    const isJump = next !== beat.next
    const nextIsBranch = isJump && next !== this.track!.analysis.beats[0]

    this.emitAt(this.nextTime, { type: 'beat', beat, isBranch: isBranchIntoBeat })
    this.beatsPlayed++

    if (isJump) {
      this.scheduleJump(next, this.nextTime + beat.duration)
    }

    this.currentBeat = next
    this.nextBeatIsBranch = nextIsBranch
    this.nextTime += beat.duration

    // Schedule the next iteration
    const delay = Math.max(0, (this.nextTime - this.ctx.currentTime - this.params.scheduleAheadMs / 1000) * 1000)
    this.timerId = window.setTimeout(() => this.scheduleNext(), delay)
  }

  private startRun(beat: Quantum, when: number, fadeInSeconds: number): ScheduledRun | null {
    return this.startRunAtOffset(beat, when, Math.max(0, beat.start), fadeInSeconds)
  }

  private startRunAtOffset(
    beat: Quantum,
    when: number,
    offset: number,
    fadeInSeconds: number,
  ): ScheduledRun | null {
    if (!this.ctx || !this.buffer || !this.gainNode) return null

    const source = this.ctx.createBufferSource()
    const sourceGain = this.ctx.createGain()
    source.buffer = this.buffer
    source.connect(sourceGain)
    sourceGain.connect(this.gainNode)

    sourceGain.gain.cancelScheduledValues(when)
    if (fadeInSeconds > 0) {
      sourceGain.gain.setValueAtTime(MIN_GAIN, when)
      sourceGain.gain.setValueCurveAtTime(fadeInCurve(this.params.fadeCurve), when, fadeInSeconds)
    } else {
      sourceGain.gain.setValueAtTime(1, when)
    }

    const run: ScheduledRun = {
      source,
      gain: sourceGain,
      startTime: when,
      sourceOffset: offset,
    }
    this.activeRuns.add(run)
    source.onended = () => {
      this.activeRuns.delete(run)
      if (this.currentRun === run) this.currentRun = null
      source.disconnect()
      sourceGain.disconnect()
    }

    source.start(when, offset)
    return run
  }

  private scheduleJump(nextBeat: Quantum, when: number): void {
    if (!this.ctx || !this.buffer) return

    const requestedFadeSeconds = this.params.branchCrossfadeMs / 1000
    const fadeSeconds = Math.min(requestedFadeSeconds, nextBeat.duration / 2)
    const preRollSeconds = Math.min(this.params.branchPreRollMs / 1000, nextBeat.start, nextBeat.duration / 2)
    const targetOffsetSeconds = this.params.branchTargetOffsetMs / 1000
    const targetStart = Math.min(this.buffer.duration - 0.001, Math.max(0, nextBeat.start + targetOffsetSeconds))
    const transitionSeconds = fadeSeconds + preRollSeconds
    const scheduledStart = when - transitionSeconds
    const actualStart = Math.max(this.ctx.currentTime, scheduledStart)
    const skippedTransitionSeconds = actualStart - scheduledStart
    const sourceOffset = Math.max(0, targetStart - transitionSeconds + skippedTransitionSeconds)
    const previousRun = this.currentRun
    const nextRun = this.startRunAtOffset(
      nextBeat,
      actualStart,
      sourceOffset,
      Math.max(0, transitionSeconds - skippedTransitionSeconds),
    )
    if (!nextRun) return

    this.currentRun = nextRun
    if (!previousRun) return

    const fadeStart = Math.max(this.ctx.currentTime, when - fadeSeconds)
    previousRun.gain.gain.cancelScheduledValues(fadeStart)
    previousRun.gain.gain.setValueAtTime(previousRun.gain.gain.value || 1, fadeStart)
    if (fadeSeconds > 0) {
      previousRun.gain.gain.setValueCurveAtTime(fadeOutCurve(this.params.fadeCurve), fadeStart, Math.max(0.001, when - fadeStart))
    }
    previousRun.source.stop(when)
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

  private emitAt(when: number, event: PlayerEvent): void {
    if (!this.ctx) return

    const delayMs = Math.max(0, (when - this.ctx.currentTime) * 1000)
    const timerId = window.setTimeout(() => {
      this.eventTimerIds.delete(timerId)
      if (event.type === 'beat') {
        this.audibleBeat = event.beat
        this.audibleBeatStartTime = when
      }
      if (this.playing) this.listener?.(event)
    }, delayMs)
    this.eventTimerIds.add(timerId)
  }

  private rescheduleFromAudiblePosition(): void {
    if (!this.playing || !this.ctx || !this.buffer || !this.track) return

    const beat = this.audibleBeat ?? this.track.analysis.beats[0]
    const now = this.ctx.currentTime
    const elapsed = Math.min(Math.max(0, now - this.audibleBeatStartTime), beat.duration)
    const restartAt = now + RETUNE_LEAD_SECONDS
    const offset = Math.min(beat.start + elapsed + RETUNE_LEAD_SECONDS, this.buffer.duration)
    const remaining = Math.max(0.01, beat.duration - elapsed - RETUNE_LEAD_SECONDS)
    const oldRuns = [...this.activeRuns]

    this.clearTimers()

    const nextRun = this.startRunAtOffset(beat, restartAt, offset, RETUNE_CROSSFADE_SECONDS)
    if (nextRun) this.currentRun = nextRun

    for (const run of oldRuns) {
      run.gain.gain.cancelScheduledValues(now)
      run.gain.gain.setValueAtTime(run.gain.gain.value || 1, now)
      run.gain.gain.setValueCurveAtTime(fadeOutCurve(this.params.fadeCurve), now, RETUNE_CROSSFADE_SECONDS)
      try {
        run.source.stop(now + RETUNE_CROSSFADE_SECONDS)
      } catch {
        // The source may already have stopped or not be cancelable.
      }
    }

    this.currentBeat = beat.next ?? this.track.analysis.beats[0]
    this.nextBeatIsBranch = false
    this.nextTime = restartAt + remaining
    this.scheduleNext()
  }

  private clearTimers(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
    for (const timerId of this.eventTimerIds) clearTimeout(timerId)
    this.eventTimerIds.clear()
  }

  private stopActiveSources(): void {
    for (const run of this.activeRuns) {
      try {
        run.source.stop()
      } catch {
        // The source may already have ended or not reached its scheduled start.
      }
      run.source.disconnect()
      run.gain.disconnect()
    }
    this.activeRuns.clear()
    this.currentRun = null
  }
}

function fadeInCurve(type: TuneParams['fadeCurve']): Float32Array {
  const curve = new Float32Array(FADE_CURVE_STEPS)
  for (let i = 0; i < curve.length; i++) {
    const progress = i / (curve.length - 1)
    curve[i] = Math.max(MIN_GAIN, type === 'linear' ? progress : Math.sin(progress * Math.PI / 2))
  }
  return curve
}

function fadeOutCurve(type: TuneParams['fadeCurve']): Float32Array {
  const curve = new Float32Array(FADE_CURVE_STEPS)
  for (let i = 0; i < curve.length; i++) {
    const progress = i / (curve.length - 1)
    curve[i] = Math.max(MIN_GAIN, type === 'linear' ? 1 - progress : Math.cos(progress * Math.PI / 2))
  }
  return curve
}
