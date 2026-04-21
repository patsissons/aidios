/**
 * Node.js audio decoder — uses ffmpeg subprocess.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { SAMPLE_RATE, type AudioDecoder, type DecodedAudio } from '../platform.ts'

export const FFMPEG = process.env['FFMPEG_PATH'] ?? 'ffmpeg'

async function computeMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/**
 * Decode any audio file to raw 32-bit float PCM at the requested mono sample rate.
 * Uses ffmpeg — must be installed. Decodes entire file to memory.
 * maxBuffer supports up to ~15 minutes of audio (350MB).
 */
async function decodeAudio(
  filePath: string,
  sampleRate = SAMPLE_RATE,
): Promise<DecodedAudio> {
  const md5 = await computeMd5(filePath)

  const result = spawnSync(
    FFMPEG,
    [
      '-i', filePath,
      '-f', 'f32le',           // raw 32-bit little-endian float
      '-ar', String(sampleRate),
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
    sampleRate,
    numSamples,
    duration: numSamples / sampleRate,
    md5,
  }
}

export class NodeDecoder implements AudioDecoder<string> {
  async decode(filePath: string, sampleRate?: number): Promise<DecodedAudio> {
    return decodeAudio(filePath, sampleRate)
  }
}
