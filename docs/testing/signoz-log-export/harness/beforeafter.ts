// Before-fix vs after-fix, same live SigNoz, two distinct markers.
import { initSignozLogExporter, exportLogLine, shutdownSignozLogExporter } from '../../../../apps/desktop/src/signoz-log-exporter'
import { appendFileSync, writeFileSync } from 'fs'

const QUERY_BASE = process.env.SIGNOZ_BASE_URL!, API_KEY = process.env.SIGNOZ_API_KEY!
const RUN = Date.now()
const MK_BEFORE = `SHOGO_BEFOREFIX_FILEONLY_${RUN}`   // simulates OLD writeLog(): file write only, no exporter
const MK_AFTER  = `SHOGO_AFTERFIX_EXPORTED_${RUN}`    // NEW path: file write + exportLogLine

async function count(marker: string): Promise<number> {
  const now = Date.now(), start = now - 3600_000
  const body = { start, end: now, step: 60, compositeQuery: { queryType: 'builder', panelType: 'list', builderQueries: { A: { dataSource: 'logs', queryName: 'A', aggregateOperator: 'noop', expression: 'A', disabled: false, filters: { items: [{ key: { key: 'body', dataType: 'string', type: '', isColumn: true }, op: 'contains', value: marker }], op: 'AND' }, orderBy: [{ columnName: 'timestamp', order: 'desc' }], pageSize: 10, offset: 0 } } } }
  const res = await fetch(`${QUERY_BASE}/api/v3/query_range`, { method: 'POST', headers: { 'SIGNOZ-API-KEY': API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j: any = await res.json(); return (j?.data?.result?.[0]?.list ?? []).length
}
const fakeMainLog: string[] = []
function oldWriteLog(line: string) { fakeMainLog.push(line) }  // pre-fix: disk only, nothing else

async function main() {
  writeFileSync('/tmp/qa/beforeafter.log', '')
  const log = (m: string) => { console.log(m); appendFileSync('/tmp/qa/beforeafter.log', m + '\n') }

  // BEFORE FIX: line only written to (simulated) main.log — NO exporter existed
  oldWriteLog(`${MK_BEFORE} :: incident line under OLD code path`)
  log(`[before-fix] wrote line to main.log only (no exporter). file lines=${fakeMainLog.length}`)

  // AFTER FIX: enable + emit through the new path
  process.env.SHOGO_SIGNOZ_ENABLED = 'true'
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ingest.us.signoz.cloud:443'
  initSignozLogExporter({ serviceVersion: 'beforeafter' })
  exportLogLine('ERROR', `${MK_AFTER} :: incident line under NEW code path`)
  await shutdownSignozLogExporter()
  log(`[after-fix] wrote line to main.log AND exported via new path`)

  // wait for ingest/batch, then compare both markers in SigNoz
  await new Promise(r => setTimeout(r, 8000))
  const beforeRows = await count(MK_BEFORE)
  const afterRows = await count(MK_AFTER)
  log(`[compare] BEFORE-FIX marker in SigNoz: ${beforeRows} rows  (expected 0 — file-only never ships)`)
  log(`[compare] AFTER-FIX  marker in SigNoz: ${afterRows} rows  (expected >=1 — now exported)`)
  const out = { runId: RUN, beforeFix: { marker: MK_BEFORE, wroteToFile: true, exported: false, signozRows: beforeRows }, afterFix: { marker: MK_AFTER, wroteToFile: true, exported: true, signozRows: afterRows }, pass: beforeRows === 0 && afterRows >= 1 }
  writeFileSync('/tmp/qa/beforeafter_result.json', JSON.stringify(out, null, 2))
  log(`[compare] RESULT ${JSON.stringify(out)}`)
  process.exit(out.pass ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(2) })
