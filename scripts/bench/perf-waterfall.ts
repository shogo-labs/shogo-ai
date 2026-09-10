/**
 * Convert SHOGO_PERF_LOG output into a compact text waterfall.
 *
 *   bun scripts/bench/perf-waterfall.ts --log main.log --open-id <id>
 */
import { readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const logPath = arg('log')
if (!logPath) throw new Error('--log is required')
const requestedOpenId = arg('open-id')
const lines = readFileSync(logPath, 'utf8').split(/\r?\n/)
const events: Array<Record<string, any>> = []

for (const line of lines) {
  const marker = line.indexOf('[shogo-perf] ')
  if (marker < 0) continue
  try {
    const event = JSON.parse(line.slice(marker + '[shogo-perf] '.length))
    if (event.perf !== 'open') continue
    if (requestedOpenId && event.openAttemptId !== requestedOpenId) continue
    events.push(event)
  } catch {
    // Ignore non-JSON application output.
  }
}

const eventTime = (event: Record<string, any>): number =>
  Number(event.wallTimeMs ?? event.atMs ?? 0)
events.sort((a, b) => eventTime(a) - eventTime(b))
if (events.length === 0) {
  console.log('No matching [shogo-perf] events found.')
  process.exit(0)
}

const first = eventTime(events[0])
const last = eventTime(events[events.length - 1])
const span = Math.max(1, last - first)
const width = 64
const rows = events.map((event) => {
  const offset = eventTime(event) - first
  const column = Math.min(width - 1, Math.max(0, Math.round((offset / span) * (width - 1))))
  const bar = `${' '.repeat(column)}|`
  const source = event.source || 'unknown'
  const phase = event.phase || event.id || 'mark'
  const elapsed = event.elapsedMs == null ? '' : ` elapsed=${event.elapsedMs}ms`
  return `${String(Math.round(offset)).padStart(6)}ms ${source.padEnd(14)} ${bar} ${phase}${elapsed}`
})

const output = [
  `# Open waterfall${requestedOpenId ? `: ${requestedOpenId}` : ''}`,
  '',
  `Events: ${events.length}; span: ${Math.round(span)}ms`,
  '',
  '```text',
  ...rows,
  '```',
  '',
].join('\n')
const outputPath = arg('output') || join(dirname(logPath), `${basename(logPath)}.waterfall.md`)
writeFileSync(outputPath, output)
console.log(output)
console.log(`Wrote ${outputPath}`)
