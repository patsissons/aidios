#!/usr/bin/env node
/**
 * Download a pinned, checksum-verified yt-dlp standalone binary into
 * packages/web/bin/yt-dlp. Idempotent: skips the download when the existing
 * file already matches the pinned checksum.
 *
 * Bump YTDLP_VERSION when YouTube breaks the current release.
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const YTDLP_VERSION = '2026.08.19'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dest = process.argv[2] ?? join(root, 'packages', 'web', 'bin', 'yt-dlp')

// Vercel builds on x86_64 Linux and functions run there too.
const target = process.env.VERCEL ? 'linux-x64' : `${process.platform}-${process.arch}`
const ASSETS = {
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
}
const asset = ASSETS[target]
if (!asset) {
  console.error(`fetch-yt-dlp: unsupported platform ${target}`)
  process.exit(1)
}

const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}`
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function fetchOk(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res
}

const sums = await (await fetchOk(`${base}/SHA2-256SUMS`)).text()
const expected = sums
  .split('\n')
  .map((l) => l.trim().split(/\s+\*?/))
  .find(([, name]) => name === asset)?.[0]
if (!expected) {
  console.error(`fetch-yt-dlp: no checksum for ${asset} in ${YTDLP_VERSION}`)
  process.exit(1)
}

try {
  if (sha256(await readFile(dest)) === expected) {
    console.log(`fetch-yt-dlp: ${asset} ${YTDLP_VERSION} already present at ${dest}`)
    process.exit(0)
  }
} catch {
  // missing or unreadable; download below
}

console.log(`fetch-yt-dlp: downloading ${asset} ${YTDLP_VERSION}...`)
const buf = Buffer.from(await (await fetchOk(`${base}/${asset}`)).arrayBuffer())
const actual = sha256(buf)
if (actual !== expected) {
  console.error(`fetch-yt-dlp: SHA-256 mismatch\n  expected ${expected}\n  actual   ${actual}`)
  process.exit(1)
}

await mkdir(dirname(dest), { recursive: true })
await writeFile(dest, buf)
await chmod(dest, 0o755)
console.log(`fetch-yt-dlp: wrote ${dest} (${(buf.length / 1e6).toFixed(1)} MB)`)
