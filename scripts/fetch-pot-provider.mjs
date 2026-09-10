#!/usr/bin/env node
/**
 * Fetch and build the bgutil proof-of-origin (PO) token provider for yt-dlp:
 *   packages/web/plugins/bgutil-ytdlp-pot-provider.zip   yt-dlp plugin (loaded via --plugin-dirs)
 *   packages/web/potserver/                               token generation script (node build/generate_once.js)
 *
 * YouTube refuses most requests from datacenter IPs with "Sign in to confirm
 * you're not a bot"; a PO token attests the request came from a real client
 * and is the documented mitigation. Idempotent: skips work already done for
 * the pinned version. Bump POT_VERSION together with the zip checksum.
 */
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const POT_VERSION = '2.0.0'
const PLUGIN_ZIP_SHA256 = process.env.POT_PLUGIN_SHA256 ?? 'bce874dfa25896c2798e0f4f8147b7b22e785479eb1e459ab232bf2506c95016'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const web = join(root, 'packages', 'web')
const pluginDir = join(web, 'plugins')
const pluginZip = join(pluginDir, 'bgutil-ytdlp-pot-provider.zip')
const serverDir = join(web, 'potserver')
const stamp = join(serverDir, '.version')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
async function fetchOk(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return res
}

// 1. Plugin zip
let havePlugin = false
try {
  havePlugin = sha256(await readFile(pluginZip)) === PLUGIN_ZIP_SHA256
} catch {}
if (havePlugin) {
  console.log(`fetch-pot-provider: plugin ${POT_VERSION} already present`)
} else {
  console.log(`fetch-pot-provider: downloading plugin ${POT_VERSION}...`)
  const buf = Buffer.from(await (await fetchOk(`https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${POT_VERSION}/bgutil-ytdlp-pot-provider.zip`)).arrayBuffer())
  const actual = sha256(buf)
  if (actual !== PLUGIN_ZIP_SHA256) {
    console.error(`fetch-pot-provider: plugin zip SHA-256 mismatch\n  expected ${PLUGIN_ZIP_SHA256}\n  actual   ${actual}`)
    process.exit(1)
  }
  await mkdir(pluginDir, { recursive: true })
  await writeFile(pluginZip, buf)
}

// 2. Token generation script (server/ from the release tarball, prod deps only, compiled with tsc)
let haveServer = false
try {
  haveServer = (await readFile(stamp, 'utf8')).trim() === POT_VERSION && existsSync(join(serverDir, 'build', 'generate_once.js'))
} catch {}
if (haveServer) {
  console.log(`fetch-pot-provider: token script ${POT_VERSION} already built`)
} else {
  console.log(`fetch-pot-provider: fetching token script ${POT_VERSION}...`)
  await rm(serverDir, { recursive: true, force: true })
  await mkdir(serverDir, { recursive: true })
  const tgz = join(serverDir, 'src.tgz')
  await writeFile(tgz, Buffer.from(await (await fetchOk(`https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${POT_VERSION}.tar.gz`)).arrayBuffer()))
  execSync(`tar -xzf src.tgz --strip-components=2 bgutil-ytdlp-pot-provider-${POT_VERSION}/server`, { cwd: serverDir, stdio: 'inherit' })
  await rm(tgz)
  // Full install (typescript + @types/node are devDependencies) to compile, then
  // prune to production deps (~69MB). --ignore-scripts skips the optional native
  // canvas binary; the script warns but works without it.
  execSync('npm ci --ignore-scripts --no-audit --no-fund', { cwd: serverDir, stdio: 'inherit' })
  execSync('npx tsc -p tsconfig.json', { cwd: serverDir, stdio: 'inherit' })
  execSync('npm prune --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: serverDir, stdio: 'inherit' })
  await writeFile(stamp, POT_VERSION + '\n')
  console.log(`fetch-pot-provider: built ${join(serverDir, 'build', 'generate_once.js')}`)
}
