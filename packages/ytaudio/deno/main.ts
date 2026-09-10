/**
 * Deno Deploy entrypoint for the YouTube audio fetcher.
 *
 * Same idea as the bocodds upstream relay: run the YouTube-facing traffic on
 * an egress pool that YouTube does not treat as a datacenter bot. Unlike the
 * relay this is the whole fetcher, because YouTube binds stream URLs to the
 * IP that requested them, so download and player lookups must share an IP.
 *
 * Routes:
 *   GET /api/youtube?url=...&prefer=m4a[&client=][&debug=1]  streamed audio (shared handler)
 *   GET /                                                      health
 *
 * Diagnostics: add debug=1 to a failing request to get the verbose yt-dlp
 * log, which shows each client's player playability status.
 *
 * The yt-dlp binary is downloaded on first use into the temp dir (pinned
 * version, SHA-256 verified) because Deno Deploy deployments are built from
 * source. Deno itself is the JavaScript runtime yt-dlp uses for YouTube's
 * challenges.
 *
 * Deploy: console.deno.com -> New App -> this GitHub repo, entrypoint
 * packages/ytaudio/deno/main.ts. For a playground, replace the relative
 * import below with the raw.githubusercontent.com URL of src/index.ts.
 */
import { handleYouTubeRequest } from '../src/index.ts'

const ALLOWED_ORIGINS = (Deno.env.get('CORS_ORIGINS') ?? '*').split(',').map((s) => s.trim()).filter(Boolean)
const EXPOSED = 'Content-Type, X-Video-Id, X-Title, X-Duration, X-Filesize-Approx, X-Yt-Client, X-Yt-Attempt'

function cors(req: Request, res: Response): Response {
  const origin = req.headers.get('origin') ?? ''
  const allow = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : ''
  if (!allow) return res
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', allow)
  headers.set('Access-Control-Expose-Headers', EXPOSED)
  headers.set('Vary', 'Origin')
  return new Response(res.body, { status: res.status, headers })
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  if (req.method === 'OPTIONS') return cors(req, new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' } }))
  if (req.method !== 'GET') return new Response('method not allowed', { status: 405 })
  if (url.pathname === '/api/youtube') return cors(req, await handleYouTubeRequest(req))
  if (url.pathname === '/') return Response.json({ service: 'aidios-ytaudio', runtime: `deno ${Deno.version.deno}`, region: Deno.env.get('DENO_REGION') ?? null })
  return new Response('not found', { status: 404 })
})
