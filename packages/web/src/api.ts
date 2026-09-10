import type { AudioAnalysis } from './types'

const FORCE_BROWSER = import.meta.env.VITE_BROWSER_ANALYSIS === 'true'
/** Origin of the YouTube fetch service (e.g. a Deno Deploy app); empty = same origin. */
const YOUTUBE_API_BASE = (import.meta.env.VITE_YOUTUBE_API_BASE ?? '').replace(/\/$/, '')

/**
 * Analyze an audio file — auto-detects whether to use the server API
 * or browser-based analysis.
 *
 * - In production builds (Vercel), always uses browser analysis.
 * - In dev, tries the server first; falls back to browser if unavailable.
 * - VITE_BROWSER_ANALYSIS=true forces browser mode.
 */
export async function analyzeFile(
  file: File,
  onProgress: (status: string) => void,
): Promise<AudioAnalysis> {
  if (FORCE_BROWSER || import.meta.env.PROD) {
    const useBrowser = FORCE_BROWSER || !(await isServerAvailable())
    if (useBrowser) {
      return analyzeBrowser(file, onProgress)
    }
  }

  return uploadAndAnalyze(file, onProgress)
}

async function analyzeBrowser(
  file: File,
  onProgress: (status: string) => void,
): Promise<AudioAnalysis> {
  onProgress('Preparing browser analysis...')
  const { analyzeInBrowser } = await import('./browser-analyzer')
  return analyzeInBrowser(file, onProgress)
}

async function isServerAvailable(): Promise<boolean> {
  try {
    // POST without a body — server returns 400 ("Missing audio file field")
    // which confirms the server is there. A proxy timeout or connection
    // refused means no server.
    const res = await fetch('/analyze', { method: 'POST' })
    return res.status === 400
  } catch {
    return false
  }
}

async function uploadAndAnalyze(
  file: File,
  onProgress: (status: string) => void,
): Promise<AudioAnalysis> {
  onProgress('Uploading...')

  const form = new FormData()
  form.append('audio', file)

  const res = await fetch('/analyze', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)

  const { id } = (await res.json()) as { id: string; status: string }
  onProgress('Analyzing...')

  // Poll for completion
  for (let i = 0; i < 600; i++) {
    await sleep(1000)
    const poll = await fetch(`/analyze/${id}`)
    if (!poll.ok) throw new Error(`Poll failed: ${poll.status}`)

    const data = await poll.json()
    if (data.status === 'complete') {
      onProgress('Done!')
      return data.analysis as AudioAnalysis
    }
    if (data.status === 'error') {
      throw new Error(data.message ?? 'Analysis failed')
    }
    onProgress(`Analyzing... (${i + 1}s)`)
  }

  throw new Error('Analysis timed out')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── YouTube ────────────────────────────────────────────────────────────────

export interface DownloadProgress {
  received: number
  total?: number
}

/**
 * Safari (desktop and iOS, including iPadOS reporting itself as a Mac) has
 * historically decoded WebM/Opus inconsistently, so ask the server for AAC.
 */
export function prefersM4a(): boolean {
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg/.test(ua)
  return ios || safari
}

/**
 * Fetch the audio track of a YouTube video through the backend and return it
 * as a File, ready for the same path an uploaded file takes.
 */
export async function fetchYouTubeAudio(
  url: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<File> {
  const params = new URLSearchParams({ url })
  if (prefersM4a()) params.set('prefer', 'm4a')

  const res = await fetch(`${YOUTUBE_API_BASE}/api/youtube?${params}`)
  if (!res.ok) {
    let msg = `YouTube fetch failed (${res.status})`
    try {
      const j = (await res.json()) as { error?: string }
      if (j.error) msg = j.error
    } catch {
      // non-JSON error body
    }
    throw new Error(friendlyYouTubeError(res.status, msg))
  }
  if (!res.body) throw new Error('YouTube returned no audio data')

  const type = res.headers.get('Content-Type') ?? 'application/octet-stream'
  const total = Number(res.headers.get('X-Filesize-Approx')) || undefined
  const title = safeDecode(res.headers.get('X-Title')) || res.headers.get('X-Video-Id') || 'youtube'
  const ext = type.includes('mp4') ? 'm4a' : type.includes('webm') ? 'webm' : type.includes('ogg') ? 'ogg' : 'audio'

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    // Rejects if the server errors the stream part-way (yt-dlp failure).
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress({ received, total })
  }
  if (received === 0) throw new Error('YouTube returned no audio data')

  return new File(chunks as BlobPart[], `${title}.${ext}`, { type })
}

function friendlyYouTubeError(status: number, fallback: string): string {
  switch (status) {
    case 400: return 'That does not look like a YouTube video URL.'
    case 404: return 'Video unavailable, private, or live.'
    case 413: return 'Videos longer than 15 minutes are not supported.'
    case 429: return 'Server is busy. Try again in a moment.'
    case 503: return 'YouTube blocked the request (bot check). Try again later, or download the audio and drop the file here.'
    case 504: return 'Timed out talking to YouTube.'
    default: return fallback
  }
}

function safeDecode(v: string | null): string {
  if (!v) return ''
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}
