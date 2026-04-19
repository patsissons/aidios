import { randomUUID, createHash } from 'node:crypto'
import { writeFile, mkdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AudioAnalysis } from '@aidios/types'

export type JobStatus = 'queued' | 'processing' | 'complete' | 'error'

export interface Job {
  id: string
  status: JobStatus
  createdAt: number
  completedAt?: number
  result?: AudioAnalysis
  error?: string
  tempFile?: string
}

const jobs = new Map<string, Job>()
const analysisCache = new Map<string, AudioAnalysis>()

export function hashBuffer(data: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(data)).digest('hex')
}

export function getCachedAnalysis(hash: string): AudioAnalysis | undefined {
  return analysisCache.get(hash)
}

export function setCachedAnalysis(hash: string, analysis: AudioAnalysis): void {
  analysisCache.set(hash, analysis)
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

export function createJob(): Job {
  const id = randomUUID()
  const job: Job = { id, status: 'queued', createdAt: Date.now() }
  jobs.set(id, job)
  return job
}

export async function saveTempFile(id: string, data: ArrayBuffer, filename: string): Promise<string> {
  const dir = join(tmpdir(), 'aidios')
  await mkdir(dir, { recursive: true })
  const ext = filename.split('.').pop() ?? 'audio'
  const path = join(dir, `${id}.${ext}`)
  await writeFile(path, Buffer.from(data))
  return path
}

export async function runJob(
  job: Job,
  analyze: (path: string) => Promise<AudioAnalysis>,
  contentHash?: string,
): Promise<void> {
  if (!job.tempFile) throw new Error('No temp file for job')
  job.status = 'processing'

  try {
    job.result = await analyze(job.tempFile)
    job.status = 'complete'
    if (contentHash) {
      setCachedAnalysis(contentHash, job.result)
    }
  } catch (err) {
    job.status = 'error'
    job.error = err instanceof Error ? err.message : String(err)
  } finally {
    job.completedAt = Date.now()
    // Clean up temp file
    if (job.tempFile) {
      unlink(job.tempFile).catch(() => {})
      job.tempFile = undefined
    }
  }
}
