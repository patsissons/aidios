import type { AudioAnalysis } from './types'

export async function uploadAndAnalyze(
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
