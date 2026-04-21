/**
 * Platform abstraction layer.
 *
 * Defines shared constants, types, and interfaces that platform-specific
 * implementations (Node.js / Browser) must satisfy. The core DSP modules
 * import only from this file — never from platform-specific code.
 */

export const SAMPLE_RATE = 22050
export const RHYTHM_SAMPLE_RATE = 44100

export interface DecodedAudio {
  data: Float32Array  // raw PCM samples, mono
  sampleRate: number
  numSamples: number
  duration: number    // seconds
  md5: string         // hex hash of original file (MD5 on Node, SHA-256 on browser)
}

/**
 * Platform-specific audio decoder.
 *
 * Node implementation uses ffmpeg; browser implementation uses OfflineAudioContext.
 * The `source` type varies by platform (file path string vs ArrayBuffer).
 */
export interface AudioDecoder<S = unknown> {
  decode(source: S, sampleRate?: number): Promise<DecodedAudio>
}
