#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cold-start probe: first paint and shell-ready at a throttled CPU.
 *
 *   node scripts/perf/cold-start-probe.mjs --web apps/mobile/dist --cpu 4 --runs 3
 *
 * Serves an exported web build, opens `${url}${--path}` in Chromium with
 * 4× CPU throttling (iPhone-15-Pro-class slowdown), and reports
 *
 *   - First Contentful Paint, from the paint timing entry
 *   - router mounted: the app's own `root:layout:mounted` mark
 *     (`lib/cold-start-timing`), i.e. the moment the router can show a screen
 *   - eager JS bytes, as fetched before FCP
 *
 * Pair it with `payload-report.mjs` for the per-module attribution.
 */
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
}

function argOf(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function serveStatic(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let file = path.join(root, decodeURIComponent(url.pathname))
    try {
      if (statSync(file).isDirectory()) file = path.join(file, 'index.html')
    } catch {
      res.writeHead(404).end('not found')
      return
    }
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function loadChromium() {
  for (const specifier of ['@playwright/test', 'playwright']) {
    try {
      const module = await import(specifier)
      return module.chromium
    } catch {
      // try the next one
    }
  }
  throw new Error('cold-start-probe: playwright is not installed')
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function main() {
  const webDir = path.resolve(argOf('--web', path.join(REPO_ROOT, 'apps', 'mobile', 'dist')))
  const cpu = Number(argOf('--cpu', '4'))
  const runs = Number(argOf('--runs', '3'))
  const route = argOf('--path', '/')
  const html = readFileSync(path.join(webDir, 'index.html'), 'utf8')
  const eagerFiles = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((match) =>
    path.basename(match[1]),
  )
  const chromium = await loadChromium()
  const { server, port } = await serveStatic(webDir)
  const browser = await chromium.launch()
  const results = []
  try {
    for (let run = 0; run < runs; run += 1) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      })
      const page = await context.newPage()
      const client = await context.newCDPSession(page)
      await client.send('Emulation.setCPUThrottlingRate', { rate: cpu })
      const jsFiles = new Set(eagerFiles)
      let eagerBytes = 0
      page.on('response', async (response) => {
        if (!response.url().endsWith('.js')) return
        const endsBeforePaint = await page
          .evaluate(() => performance.getEntriesByName('first-contentful-paint').length === 0)
          .catch(() => false)
        if (!endsBeforePaint) return
        jsFiles.add(path.basename(new URL(response.url()).pathname))
        try {
          eagerBytes += (await response.body()).length
        } catch {
          // body already evicted
        }
      })
      await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'commit' })
      const firstPaint = await page
        .waitForFunction(
          () => {
            const entry = performance.getEntriesByName('first-contentful-paint')[0]
            return entry ? entry.startTime : undefined
          },
          null,
          { timeout: 30000, polling: 50 },
        )
        .then((handle) => handle.jsonValue())
        .catch(() => null)
      const marks = await page
        .waitForFunction(
          () => {
            const api = globalThis.__shogoColdStart__
            if (!api) return undefined
            const found = api.getMarks().find((m) => m.id === 'root:layout:mounted')
            return found ? found.at : undefined
          },
          null,
          { timeout: 30000, polling: 100 },
        )
        .then((handle) => handle.jsonValue())
        .catch(() => null)
      const timeline = process.argv.includes('--timeline')
        ? await page
            .evaluate(() => globalThis.__shogoColdStart__?.getMarks().map((m) => `${m.id}@${Math.round(m.at)}`) ?? [])
            .catch(() => [])
        : []
      results.push({ firstPaint, shellReady: marks, eagerBytes, files: jsFiles.size, timeline })
      await context.close()
    }
  } finally {
    await browser.close()
    server.close()
  }

  const paints = results.map((r) => r.firstPaint).filter((v) => typeof v === 'number')
  const shells = results.map((r) => r.shellReady).filter((v) => typeof v === 'number')
  const bytes = results.map((r) => r.eagerBytes)
  console.log(`cold start · ${route} · ${cpu}× CPU · ${runs} runs`)
  console.log(`first paint   ${Math.round(median(paints))} ms (runs: ${paints.map(Math.round).join(', ')})`)
  console.log(
    shells.length
      ? `router mounted ${Math.round(median(shells))} ms (runs: ${shells.map(Math.round).join(', ')})`
      : 'router mounted (never reached)',
  )
  console.log(
    `eager JS      ${(Math.max(...bytes) / 1024 / 1024).toFixed(2)} MB in ${results[0].files} files`,
  )
  if (results[0].timeline?.length) console.log(`marks         ${results[0].timeline.join(' · ')}`)
}

await main()
