/**
 * YouTube audio fetcher.
 *
 * Runs a standalone yt-dlp binary and streams the best-quality audio track to
 * the caller. Framework-agnostic: `handleYouTubeRequest` is a web-standard
 * (Request → Response) handler used both by the Vercel function
 * (`packages/web/api/youtube.ts`) and the Hono dev server.
 *
 * Deliberately a single file with no internal imports and no `import.meta`, so
 * it works under both `node --experimental-strip-types` and Vercel's bundler.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { constants as FS } from 'node:fs'
import { access, chmod, copyFile, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Readable } from 'node:stream'

// ─── Errors ─────────────────────────────────────────────────────────────────

export type YtErrorKind = 'bad_url' | 'bot' | 'unavailable' | 'too_long' | 'busy' | 'timeout' | 'unknown'

export class YtError extends Error {
  readonly kind: YtErrorKind
  readonly detail: string | undefined

  constructor(kind: YtErrorKind, message: string, detail?: string) {
    super(message)
    this.name = 'YtError'
    this.kind = kind
    this.detail = detail
  }
}

export const STATUS: Record<YtErrorKind, number> = {
  bad_url: 400,
  unavailable: 404,
  too_long: 413,
  busy: 429,
  unknown: 500,
  bot: 503,
  timeout: 504,
}

// ─── Config ─────────────────────────────────────────────────────────────────

/** Longest video we will fetch, in seconds. */
export const MAX_DURATION_S = 900
const MAX_CONCURRENT = Number(process.env['YTDLP_MAX_CONCURRENT'] ?? 2)
/** Hard kill deadline; must stay under the Vercel 300s maxDuration. */
const TOTAL_TIMEOUT_MS = Number(process.env['YTDLP_TIMEOUT_MS'] ?? 280_000)
/** How long we wait for yt-dlp to resolve metadata before giving up. */
const META_TIMEOUT_MS = 60_000

let active = 0

// ─── URL → video id ─────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{11}$/

export function parseVideoId(input: string): string {
  const s = input.trim()
  if (ID_RE.test(s)) return s

  let u: URL
  try {
    u = new URL(s.includes('://') ? s : `https://${s}`)
  } catch {
    throw new YtError('bad_url', 'Not a valid URL')
  }

  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
  let id: string | null = null
  if (host === 'youtu.be') {
    id = u.pathname.slice(1).split('/')[0] ?? null
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?]+)/)?.[1] ?? null
  }

  if (!id || !ID_RE.test(id)) {
    throw new YtError('bad_url', 'Not a YouTube video URL (playlists are not supported)')
  }
  return id
}

// ─── Binary resolution ──────────────────────────────────────────────────────

let resolved: string | null = null

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * Find the yt-dlp binary. Order: YTDLP_PATH env, bundled `bin/yt-dlp` relative
 * to cwd (Vercel's /var/task or packages/web), the same path from the repo
 * root (running `npm run server`), then PATH. If the file exists but lost its
 * exec bit (a known Vercel bundling quirk) copy it to /tmp and chmod it.
 */
export async function resolveYtDlp(): Promise<string> {
  if (resolved) return resolved

  const fromEnv = process.env['YTDLP_PATH']
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    join(process.cwd(), 'bin', 'yt-dlp'),
    join(process.cwd(), 'packages', 'web', 'bin', 'yt-dlp'),
    ...(process.env['PATH'] ?? '').split(delimiter).filter(Boolean).map((d) => join(d, 'yt-dlp')),
  ]

  for (const p of candidates) {
    if (!(await exists(p))) continue
    try {
      await access(p, FS.X_OK)
      console.log(`[ytaudio] using ${p}`)
      return (resolved = p)
    } catch {
      const tmp = join(tmpdir(), 'yt-dlp')
      await copyFile(p, tmp)
      await chmod(tmp, 0o755)
      console.log(`[ytaudio] copied ${p} -> ${tmp} (exec bit fallback)`)
      return (resolved = tmp)
    }
  }

  throw new YtError('unknown', 'yt-dlp binary not found (run scripts/fetch-yt-dlp.mjs)')
}

// ─── Arguments ──────────────────────────────────────────────────────────────

export interface BuildArgsOpts {
  videoId: string
  preferM4a: boolean
  metaFile: string
  /** yt-dlp player clients for this attempt; empty = yt-dlp default. */
  clients?: string[]
  cookiesFile?: string
  proxy?: string
  extraArgs?: string[]
}

export function buildArgs(o: BuildArgsOpts): string[] {
  return [
    `https://www.youtube.com/watch?v=${o.videoId}`,
    '-f', o.preferM4a ? 'ba[ext=m4a]/ba' : 'ba',
    '-o', '-',
    '--no-progress',
    '--no-playlist',
    '--break-match-filters', `duration<=${MAX_DURATION_S}`,
    // Written before the download starts, so metadata is available before the
    // first media byte without polluting stdout.
    '--print-to-file', 'before_dl:%(.{id,title,duration,ext,acodec,abr,filesize_approx})j', o.metaFile,
    // YouTube requires a JS runtime for challenge solving; reuse our own node.
    '--js-runtimes', `node:${process.execPath}`,
    // $HOME is read-only on Vercel.
    '--cache-dir', join(tmpdir(), 'yt-dlp-cache'),
    ...(o.clients && o.clients.length ? ['--extractor-args', `youtube:player_client=${o.clients.join(',')}`] : []),
    ...(o.cookiesFile ? ['--cookies', o.cookiesFile] : []),
    ...(o.proxy ? ['--proxy', o.proxy] : []),
    ...(o.extraArgs ?? []),
  ]
}

// ─── Env hooks ──────────────────────────────────────────────────────────────

let cookiesPath: string | undefined

async function cookiesFromEnv(): Promise<string | undefined> {
  const b64 = process.env['YTDLP_COOKIES_B64']
  if (!b64) return undefined
  if (!cookiesPath) {
    const p = join(tmpdir(), 'yt-dlp-cookies.txt')
    await writeFile(p, Buffer.from(b64, 'base64'))
    cookiesPath = p
  }
  return cookiesPath
}

function extraArgsFromEnv(): string[] {
  return (process.env['YTDLP_EXTRA_ARGS'] ?? '').split(/\s+/).filter(Boolean)
}

/**
 * Player-client fallback chain. Each entry is one yt-dlp attempt; 'default'
 * means yt-dlp's own client selection. YouTube's "Sign in to confirm you're
 * not a bot" wall is enforced per client, and from datacenter IPs the default
 * clients are often refused while web_embedded / android_vr / tv (which need
 * no proof-of-origin token) still work. Override with
 * YTDLP_CLIENTS="default;web_embedded,android_vr;tv".
 */
const DEFAULT_CLIENT_CHAIN: string[][] = [[], ['web_embedded', 'android_vr']]
const CLIENT_RE = /^[a-z_]+(,[a-z_]+)*$/

export function clientChain(override?: string | null): string[][] {
  const spec = override ?? process.env['YTDLP_CLIENTS']
  if (!spec) return DEFAULT_CLIENT_CHAIN
  const chain = spec
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === 'default' ? [] : s.split(',').map((c) => c.trim()).filter(Boolean)))
  for (const set of chain) {
    if (set.length && !CLIENT_RE.test(set.join(','))) throw new YtError('bad_url', 'Invalid client list')
  }
  return chain.length ? chain : DEFAULT_CLIENT_CHAIN
}

export function describeClients(set: string[]): string {
  return set.length ? set.join(',') : 'default'
}

/** Errors worth retrying with a different player client. */
function retryable(err: YtError): boolean {
  return err.kind === 'bot' || err.kind === 'unknown'
}

// ─── stderr classification ──────────────────────────────────────────────────

export function classify(stderr: string, code: number | null): YtError {
  const s = stderr
  if (/Sign in to confirm|not a bot|LOGIN_REQUIRED|login_required|confirm your age|use --cookies/i.test(s)) {
    return new YtError('bot', 'YouTube blocked the request (bot check)', s)
  }
  if (code === 101 || /does not pass filter|break-match-filters/i.test(s)) {
    return new YtError('too_long', `Video is longer than ${MAX_DURATION_S / 60} minutes`, s)
  }
  if (/video unavailable|video is unavailable|Private video|is private|has been removed|not available|does not exist|Incomplete YouTube ID|Unsupported URL|is a live event|live stream/i.test(s)) {
    return new YtError('unavailable', 'Video unavailable, private, or live', s)
  }
  return new YtError('unknown', 'yt-dlp failed', s)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Poll until `file` exists and parses as JSON, or `stop()` becomes true.
 * Never rejects; the caller races it against process exit and must flip
 * `stop` once the race settles so the loop doesn't run forever.
 */
async function pollJson<T>(file: string, intervalMs: number, stop: () => boolean): Promise<T> {
  for (;;) {
    if (stop()) return new Promise<T>(() => {}) // never settles; race already decided
    try {
      const text = await readFile(file, 'utf8')
      if (text.trim()) return JSON.parse(text) as T
    } catch {
      // not there yet
    }
    await sleep(intervalMs)
  }
}

/** A sleep that never keeps the process alive and can be cancelled. */
function timeoutRejection(ms: number, err: () => YtError, stop: () => boolean): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => { if (!stop()) reject(err()) }, ms)
    t.unref()
  })
}

/**
 * Kill the yt-dlp process group. The PyInstaller one-file binary is a
 * bootloader that spawns the real Python process, so a plain child.kill()
 * would leave the worker running.
 */
function killTree(child: ChildProcess): () => void {
  let done = false
  return () => {
    if (done || child.exitCode !== null || child.pid === undefined) return
    done = true
    const pid = child.pid
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }
    setTimeout(() => {
      if (child.exitCode !== null) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }, 3000).unref()
  }
}

export function contentTypeFor(ext: string): string {
  const map: Record<string, string> = {
    webm: 'audio/webm',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    opus: 'audio/ogg',
    ogg: 'audio/ogg',
    mp3: 'audio/mpeg',
  }
  return map[ext] ?? 'application/octet-stream'
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export interface YtMeta {
  id: string
  title: string
  duration: number
  ext: string
  acodec?: string
  abr?: number
  filesize_approx?: number
}

export interface StreamResult {
  stream: ReadableStream<Uint8Array>
  meta: YtMeta
  contentType: string
}

export interface StreamOpts {
  preferM4a?: boolean
  signal?: AbortSignal
  /** Diagnostic override of the client chain, same syntax as YTDLP_CLIENTS. */
  clients?: string | null
}

export interface StreamResult {
  stream: ReadableStream<Uint8Array>
  meta: YtMeta
  contentType: string
  /** Which client set produced the stream and how many attempts it took. */
  client: string
  attempt: number
}

interface Attempt {
  child: ChildProcess
  stdout: Readable
  exited: Promise<number | null>
  stderr: () => string
  kill: () => void
  metaFile: string
}

function startAttempt(bin: string, args: string[], metaFile: string, signal?: AbortSignal): Attempt {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let stderr = ''
  child.stderr!.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-64_000)
  })
  const exited = new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(child.exitCode ?? -1))
    child.on('close', (code) => resolve(code))
  })
  const kill = killTree(child)
  const hardTimer = setTimeout(kill, TOTAL_TIMEOUT_MS)
  hardTimer.unref()
  signal?.addEventListener('abort', kill, { once: true })
  void exited.then(() => {
    clearTimeout(hardTimer)
    unlink(metaFile).catch(() => {})
  })
  return { child, stdout: child.stdout!, exited, stderr: () => stderr, kill, metaFile }
}

export async function streamYouTubeAudio(videoId: string, opts: StreamOpts = {}): Promise<StreamResult> {
  if (active >= MAX_CONCURRENT) throw new YtError('busy', 'Server busy, try again shortly')
  active++
  let released = false
  const release = () => {
    if (released) return
    released = true
    active--
  }

  try {
    const bin = await resolveYtDlp()
    const chain = clientChain(opts.clients)
    const cookiesFile = await cookiesFromEnv()
    const proxy = process.env['YTDLP_PROXY']
    const extraArgs = extraArgsFromEnv()

    for (let i = 0; i < chain.length; i++) {
      const clients = chain[i]!
      const metaFile = join(tmpdir(), `ytaudio-${videoId}-${Math.random().toString(36).slice(2)}.json`)
      const args = buildArgs({ videoId, preferM4a: !!opts.preferM4a, metaFile, clients, cookiesFile, proxy, extraArgs })
      const attempt = startAttempt(bin, args, metaFile, opts.signal)

      let meta: YtMeta
      let settled = false
      const stop = () => settled
      try {
        meta = await Promise.race([
          pollJson<YtMeta>(metaFile, 50, stop),
          attempt.exited.then((code) => {
            throw classify(attempt.stderr(), code)
          }),
          timeoutRejection(META_TIMEOUT_MS, () => new YtError('timeout', 'Timed out waiting for YouTube'), stop),
        ]).finally(() => {
          settled = true
        })
      } catch (e) {
        attempt.kill()
        const err = e instanceof YtError ? e : new YtError('unknown', String(e))
        const last = i === chain.length - 1
        if (!last && retryable(err) && !opts.signal?.aborted) {
          console.warn(`[ytaudio] ${videoId}: ${err.kind} with client=${describeClients(clients)}, retrying with ${describeClients(chain[i + 1]!)}`)
          continue
        }
        throw err
      }

      if (meta.duration > MAX_DURATION_S) {
        attempt.kill()
        throw new YtError('too_long', `Video is longer than ${MAX_DURATION_S / 60} minutes`)
      }

      const { stdout, exited, stderr, kill, child } = attempt
      void exited.then((code) => {
        release()
        // A failure after bytes have flowed must error the stream rather than
        // end it cleanly, otherwise the client would decode a truncated file.
        if (code !== 0 && !stdout.destroyed) stdout.destroy(classify(stderr(), code))
      })
      // Client went away (web stream cancelled → node readable closed).
      stdout.on('close', () => {
        if (child.exitCode === null) kill()
      })

      if (i > 0) console.log(`[ytaudio] ${videoId}: succeeded with client=${describeClients(clients)} on attempt ${i + 1}`)
      return {
        stream: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
        meta,
        contentType: contentTypeFor(meta.ext),
        client: describeClients(clients),
        attempt: i + 1,
      }
    }
    throw new YtError('unknown', 'No client attempts configured')
  } catch (e) {
    release()
    throw e
  }
}

// ─── Web-standard handler (shared by Vercel + Hono) ─────────────────────────

export async function handleYouTubeRequest(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams
  try {
    const videoId = parseVideoId(q.get('url') ?? '')
    const { stream, meta, contentType, client, attempt } = await streamYouTubeAudio(videoId, {
      preferM4a: q.get('prefer') === 'm4a',
      signal: req.signal,
      clients: q.get('client'),
    })

    const ext = meta.ext || 'bin'
    const title = meta.title || meta.id
    const asciiName = title.replace(/[^\w .-]+/g, '_').slice(0, 80) || meta.id
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'X-Video-Id': meta.id,
      'X-Title': encodeURIComponent(title),
      'X-Duration': String(meta.duration ?? ''),
      'X-Yt-Client': client,
      'X-Yt-Attempt': String(attempt),
      'Content-Disposition': `inline; filename="${asciiName}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${title}.${ext}`)}`,
      'Cache-Control': 'private, no-store',
    }
    if (meta.filesize_approx) headers['X-Filesize-Approx'] = String(meta.filesize_approx)

    return new Response(stream, { status: 200, headers })
  } catch (e) {
    const err = e instanceof YtError ? e : new YtError('unknown', e instanceof Error ? e.message : String(e))
    if (err.detail) console.error(`[ytaudio] ${err.kind}: ${err.detail.slice(-2000)}`)
    else console.error(`[ytaudio] ${err.kind}: ${err.message}`)
    return Response.json({ error: err.message, kind: err.kind }, { status: STATUS[err.kind] })
  }
}
