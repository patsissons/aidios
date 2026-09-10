// Vercel function: GET /api/youtube?url=<youtube url>&prefer=m4a
// Streams best-quality audio for a YouTube video. All logic lives in
// @aidios/ytaudio; the relative extensionless import is deliberate so that
// Vercel's bundler can trace and compile the TypeScript source.
import { handleYouTubeRequest } from '../../ytaudio/src/index'

export const config = { maxDuration: 300 }

export async function GET(req: Request): Promise<Response> {
  return handleYouTubeRequest(req)
}
