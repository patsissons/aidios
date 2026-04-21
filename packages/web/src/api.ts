import type { AudioAnalysis } from './types'

const FORCE_BROWSER = import.meta.env.VITE_BROWSER_ANALYSIS === 'true'

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
