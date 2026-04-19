import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export const SAMPLE_RATE = 22050
export const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg'

export interface DecodedAudio {
  data: Float32Array  // raw PCM samples at SAMPLE_RATE Hz mono
  sampleRate: number  // always 22050
  numSamples: number
  duration: number    // seconds
  md5: string         // hex MD5 of original file
}

export async function computeMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Decode any audio file to raw 32-bit float PCM at 22050Hz mono.
 * Uses ffmpeg — must be installed. Decodes entire file to memory.
 * maxBuffer supports up to ~15 minutes of audio (350MB).
 */
export async function decodeAudio(filePath: string): Promise<DecodedAudio> {
  const md5 = await computeMd5(filePath)

  const result = spawnSync(
    FFMPEG,
    [
      '-i', filePath,
      '-f', 'f32le',           // raw 32-bit little-endian float
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',              // mono
      '-acodec', 'pcm_f32le',
      'pipe:1',
    ],
    { maxBuffer: 350 * 1024 * 1024 },  // 350MB covers ~15 minutes
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? ''
    throw new Error(`ffmpeg exited with code ${result.status}: ${stderr.slice(-500)}`)
  }

  const raw: Buffer = result.stdout
  const numSamples = raw.byteLength / 4

  // Safe copy — Buffer may use pool with non-zero byteOffset, which breaks
  // Float32Array(buffer.buffer, buffer.byteOffset, n) alignment for WASM
  const data = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    data[i] = raw.readFloatLE(i * 4)
  }

  return {
    data,
    sampleRate: SAMPLE_RATE,
    numSamples,
    duration: numSamples / SAMPLE_RATE,
    md5,
  }
}
