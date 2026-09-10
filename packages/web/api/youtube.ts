// Vercel function: GET /api/youtube?url=<youtube url>&prefer=m4a
// Streams best-quality audio for a YouTube video. All logic lives in
// @aidios/ytaudio. The web `build` script compiles it to plain ESM at
// lib/index.js (gitignored) so this function imports a real .js file with an
// explicit extension, which Node's ESM loader requires at runtime.
import { handleYouTubeRequest } from '../lib/index.js'

export const config = { maxDuration: 300 }

export async function GET(req: Request): Promise<Response> {
  return handleYouTubeRequest(req)
}
