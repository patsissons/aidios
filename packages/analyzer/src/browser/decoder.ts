/**
 * Browser audio decoder — uses Web Audio API (OfflineAudioContext).
 *
 * Replaces ffmpeg: the browser natively decodes mp3/mp4/wav/ogg/etc.
 * Resampling to the target sample rate is handled by OfflineAudioContext.
 *
 * NOTE: OfflineAudioContext is only available on the main thread, not in
 * Web Workers. Use decodeAudioBuffer() on the main thread, then pass the
 * resulting PreDecodedData to PreDecodedDecoder in the worker.
 */

import { SAMPLE_RATE, RHYTHM_SAMPLE_RATE, type AudioDecoder, type DecodedAudio } from '../platform.ts'

async function computeHash(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Decode compressed audio to mono PCM Float32Array at the target sample rate.
 * Must be called from the main thread (OfflineAudioContext not available in workers).
 */
async function decodeToFloat32(
  arrayBuffer: ArrayBuffer,
  targetSampleRate: number,
): Promise<Float32Array> {
  // First pass: decode at native rate to learn the duration
  const probeCtx = new OfflineAudioContext(1, 1, 44100)
  const nativeBuffer = await probeCtx.decodeAudioData(arrayBuffer.slice(0))

  // Second pass: decode + resample to target rate
  const numOutputSamples = Math.ceil(nativeBuffer.duration * targetSampleRate)
  const offlineCtx = new OfflineAudioContext(1, numOutputSamples, targetSampleRate)
  const buffer = await offlineCtx.decodeAudioData(arrayBuffer.slice(0))
  const source = offlineCtx.createBufferSource()
  source.buffer = buffer
  source.connect(offlineCtx.destination)
  source.start(0)

  const rendered = await offlineCtx.startRendering()
  return new Float32Array(rendered.getChannelData(0))
}

/** Pre-decoded PCM data ready to transfer to a worker. */
export interface PreDecodedData {
  audio: Float32Array       // PCM at SAMPLE_RATE (22050)
  rhythmAudio: Float32Array // PCM at RHYTHM_SAMPLE_RATE (44100)
  md5: string
}

/**
 * Decode audio on the main thread into PCM at both sample rates.
 * The returned data can be transferred to a Web Worker.
 */
export async function decodeAudioBuffer(arrayBuffer: ArrayBuffer): Promise<PreDecodedData> {
  const [audio, rhythmAudio, md5] = await Promise.all([
    decodeToFloat32(arrayBuffer, SAMPLE_RATE),
    decodeToFloat32(arrayBuffer, RHYTHM_SAMPLE_RATE),
    computeHash(arrayBuffer),
  ])
  return { audio, rhythmAudio, md5 }
}

/**
 * Decoder that wraps pre-decoded PCM data (for use in Web Workers).
 * Returns the appropriate sample rate data based on the requested rate.
 */
export class PreDecodedDecoder implements AudioDecoder<void> {
  constructor(private data: PreDecodedData) {}

  async decode(_source: void, sampleRate = SAMPLE_RATE): Promise<DecodedAudio> {
    const pcm = sampleRate === RHYTHM_SAMPLE_RATE ? this.data.rhythmAudio : this.data.audio
    const actualRate = sampleRate === RHYTHM_SAMPLE_RATE ? RHYTHM_SAMPLE_RATE : SAMPLE_RATE
    return {
      data: pcm,
      sampleRate: actualRate,
      numSamples: pcm.length,
      duration: pcm.length / actualRate,
      md5: this.data.md5,
    }
  }
}
