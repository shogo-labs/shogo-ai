// Unit tests for the safety properties of the REAL exporter module.
import { initSignozLogExporter, exportLogLine, flush, shutdownSignozLogExporter } from '../../../../apps/desktop/src/signoz-log-exporter'
import { appendFileSync, writeFileSync } from 'fs'

const results: { name: string; pass: boolean; detail: string }[] = []
function check(name: string, pass: boolean, detail = '') { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }

// ---- controllable fetch mock ----
let sentBodies: string[] = []
let fetchMode: 'ok' | 'reject' | 'throw' = 'ok'
let fetchCalls = 0
;(globalThis as any).fetch = async (_url: string, init: any) => {
  fetchCalls++
  const payload = JSON.parse(init.body)
  for (const rl of payload.resourceLogs) for (const sl of rl.scopeLogs) for (const lr of sl.logRecords) sentBodies.push(lr.body.stringValue)
  if (fetchMode === 'reject') return Promise.reject(new Error('simulated network failure'))
  if (fetchMode === 'throw') throw new Error('simulated sync throw')
  return { ok: true, status: 200 } as any
}

// ---- console spy (recursion guard) ----
const origLog = console.log, origErr = console.error, origWarn = console.warn
let consoleHits = 0
function spyOn() { consoleHits = 0; console.log = (...a) => { consoleHits++; origLog(...a) }; console.error = (...a) => { consoleHits++; origErr(...a) }; console.warn = (...a) => { consoleHits++; origWarn(...a) } }
function spyOff() { console.log = origLog; console.error = origErr; console.warn = origWarn }

async function main() {
  writeFileSync('/tmp/qa/unit.log', '')

  // TEST 1: disabled (flag off) => exportLogLine is a no-op (dropped before init)
  delete process.env.SHOGO_SIGNOZ_ENABLED
  exportLogLine('INFO', 'PRE_INIT_SHOULD_BE_DROPPED')

  // TEST 2: init only when enabled
  process.env.SHOGO_SIGNOZ_ENABLED = 'true'
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ingest.example.invalid:443'
  const active = initSignozLogExporter({ serviceVersion: 'unit' })
  check('init returns true when SHOGO_SIGNOZ_ENABLED=true', active === true)

  // enqueue a post-init line, flush, inspect payload
  sentBodies = []; fetchMode = 'ok'
  exportLogLine('INFO', 'POST_INIT_KEEP')
  await flush()
  check('disabled-before-init line is dropped', !sentBodies.includes('PRE_INIT_SHOULD_BE_DROPPED'), `sent=${sentBodies.length}`)
  check('post-init line is exported', sentBodies.includes('POST_INIT_KEEP'))

  // TEST 3: OTLP payload shape (capture a real payload)
  sentBodies = []
  ;(globalThis as any).__lastPayload = null
  const realFetch = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (u: string, init: any) => { (globalThis as any).__lastPayload = JSON.parse(init.body); return realFetch(u, init) }
  exportLogLine('ERROR', 'SHAPE_CHECK')
  await flush()
  const p = (globalThis as any).__lastPayload
  const lr = p?.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0]
  const resAttrKeys = (p?.resourceLogs?.[0]?.resource?.attributes ?? []).map((a: any) => a.key)
  check('payload has resource service.name', resAttrKeys.includes('service.name'), resAttrKeys.join(','))
  check('logRecord has severityNumber+Text+body+timeUnixNano', !!lr && lr.severityNumber === 17 && lr.severityText === 'ERROR' && !!lr.body?.stringValue && !!lr.timeUnixNano)
  check('logRecord has log.source attribute', (lr?.attributes ?? []).some((a: any) => a.key === 'log.source'))
  ;(globalThis as any).fetch = realFetch

  // TEST 4: batching — >MAX_BATCH(512) enqueued, one flush sends at most 512
  sentBodies = []
  for (let i = 0; i < 600; i++) exportLogLine('INFO', `BATCH_${i}`)
  await flush()
  const firstBatch = sentBodies.length
  check('single flush sends <= MAX_BATCH (512)', firstBatch === 512, `sent=${firstBatch}`)
  await flush()
  check('remaining flushed on next call', sentBodies.length === 600, `total=${sentBodies.length}`)

  // TEST 5: bounded queue — enqueue MAX_QUEUE+extra, oldest dropped, cap respected
  sentBodies = []
  const N = 2048 + 100
  for (let i = 0; i < N; i++) exportLogLine('INFO', `Q_${i}`)
  for (let k = 0; k < 6; k++) await flush()  // drain (2048 / 512 = 4 flushes)
  check('queue capped at MAX_QUEUE (2048) — oldest 100 dropped', sentBodies.length === 2048, `sent=${sentBodies.length}`)
  check('oldest record (Q_0) was dropped', !sentBodies.includes('Q_0') && sentBodies.includes('Q_2147'))

  // TEST 6: never throws + never uses console on network REJECT
  fetchMode = 'reject'; spyOn()
  let threw = false
  try { exportLogLine('ERROR', 'REJECT_CASE'); await flush() } catch { threw = true }
  spyOff()
  check('flush does not throw on network failure', !threw)
  check('exporter never calls console.* (recursion guard) on failure', consoleHits === 0, `hits=${consoleHits}`)

  // TEST 7: never throws on synchronous fetch throw
  fetchMode = 'throw'
  let threw2 = false
  try { exportLogLine('ERROR', 'THROW_CASE'); await flush() } catch { threw2 = true }
  check('flush does not throw on synchronous fetch throw', !threw2)

  await shutdownSignozLogExporter()
  const passed = results.filter(r => r.pass).length
  writeFileSync('/tmp/qa/unit_result.json', JSON.stringify({ total: results.length, passed, failed: results.length - passed, results }, null, 2))
  console.log(`\n==== ${passed}/${results.length} unit checks passed ====`)
  process.exit(passed === results.length ? 0 : 1)
}
main().catch(e => { console.error('unit ERROR', e); process.exit(2) })
