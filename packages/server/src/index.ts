import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { analyzeAudio } from '@aidios/analyzer'
import { createJob, getJob, saveTempFile, runJob, hashBuffer, getCachedAnalysis } from './queue.ts'

const app = new Hono()

// POST /analyze — multipart/form-data with field "audio"
app.post('/analyze', async (c) => {
  const body = await c.req.parseBody()
  const file = body['audio']

  if (!file || typeof file === 'string') {
    return c.json({ error: 'Missing "audio" file field in multipart body' }, 400)
  }

  const arrayBuffer = await file.arrayBuffer()
  const contentHash = hashBuffer(arrayBuffer)

  // Return cached result immediately if available
  const cached = getCachedAnalysis(contentHash)
  if (cached) {
    const job = createJob()
    job.result = cached
    job.status = 'complete'
    job.completedAt = Date.now()
    console.log(`Cache hit for ${file.name} (${contentHash.slice(0, 8)}…)`)
    return c.json({ id: job.id, status: 'queued' }, 202)
  }

  const job = createJob()
  const tempFile = await saveTempFile(job.id, arrayBuffer, file.name)
  job.tempFile = tempFile

  // Run analysis in background — do not await
  runJob(job, (path) => analyzeAudio(path, { logProgress: true }), contentHash).catch(() => {})

  return c.json({ id: job.id, status: 'queued' }, 202)
})

// GET /analyze/:id — poll for job status and result
app.get('/analyze/:id', (c) => {
  const job = getJob(c.req.param('id'))
  if (!job) return c.json({ error: 'Job not found' }, 404)

  if (job.status === 'complete') {
    return c.json({ id: job.id, status: 'complete', analysis: job.result })
  }
  if (job.status === 'error') {
    return c.json({ id: job.id, status: 'error', message: job.error })
  }
  return c.json({ id: job.id, status: job.status })
})

// Health check
app.get('/', (c) => c.json({ service: 'aidios', status: 'ok' }))

const PORT = Number(process.env['PORT'] ?? 3000)
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`aidios server running on http://localhost:${PORT}`)
})

export { app }
