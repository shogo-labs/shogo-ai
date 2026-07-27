// Real end-to-end test: drives the ACTUAL exporter module against live SigNoz.
import { initSignozLogExporter, exportLogLine, shutdownSignozLogExporter } from '../../../../apps/desktop/src/signoz-log-exporter'
import { readFileSync } from 'fs'

const MARKER = readFileSync('/tmp/qa/marker.txt', 'utf8').trim()
const QUERY_BASE = process.env.SIGNOZ_BASE_URL!
const API_KEY = process.env.SIGNOZ_API_KEY!

async function querySigNoz(marker: string): Promise<number> {
  const now = Date.now()
  const start = now - 3600_000
  const body = {
    start, end: now, step: 60,
    compositeQuery: {
      queryType: 'builder', panelType: 'list',
      builderQueries: {
        A: {
          dataSource: 'logs', queryName: 'A', aggregateOperator: 'noop', expression: 'A', disabled: false,
          filters: { items: [{ key: { key: 'body', dataType: 'string', type: '', isColumn: true }, op: 'contains', value: marker }], op: 'AND' },
          orderBy: [{ columnName: 'timestamp', order: 'desc' }], pageSize: 10, offset: 0,
        },
      },
    },
  }
  const res = await fetch(`${QUERY_BASE}/api/v3/query_range`, {
    method: 'POST',
    headers: { 'SIGNOZ-API-KEY': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j: any = await res.json()
  const list = j?.data?.result?.[0]?.list ?? []
  if (list.length) {
    // dump the first record so we can prove the shape/attributes
    require('fs').writeFileSync('/tmp/qa/found_record.json', JSON.stringify(list[0], null, 2))
  }
  return list.length
}

async function main() {
  const log = (m: string) => { console.log(m); require('fs').appendFileSync('/tmp/qa/e2e.log', m + '\n') }
  require('fs').writeFileSync('/tmp/qa/e2e.log', '')

  log(`[e2e] marker = ${MARKER}`)

  // ---- BEFORE: marker must not exist yet ----
  const before = await querySigNoz(MARKER)
  log(`[e2e] BEFORE emit — SigNoz rows for marker: ${before}`)

  // ---- Configure + init the REAL exporter exactly as production would ----
  process.env.SHOGO_SIGNOZ_ENABLED = 'true'
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://ingest.us.signoz.cloud:443'
  process.env.SIGNOZ_INGESTION_KEY = process.env.SIGNOZ_INGESTION_KEY // already set
  const active = initSignozLogExporter({ serviceVersion: 'e2e-test' })
  log(`[e2e] initSignozLogExporter active = ${active}`)

  // ---- Emit 3 lines through the real enqueue path, then flush ----
  exportLogLine('INFO', `${MARKER} :: info line from main.log path`)
  exportLogLine('WARN', `${MARKER} :: warn line`)
  exportLogLine('ERROR', `${MARKER} :: simulated runtime SIGKILL / ECONNRESET incident`)
  log('[e2e] enqueued 3 records; flushing via shutdownSignozLogExporter()...')
  await shutdownSignozLogExporter()
  log('[e2e] flush complete')

  // ---- AFTER: poll until the record appears (batch + ingest latency) ----
  let after = 0
  for (let i = 1; i <= 12; i++) {
    await new Promise(r => setTimeout(r, 5000))
    after = await querySigNoz(MARKER)
    log(`[e2e] AFTER poll #${i} (t=${i*5}s) — SigNoz rows for marker: ${after}`)
    if (after > 0) break
  }

  const result = { marker: MARKER, before, after, active, pass: before === 0 && after > 0 }
  require('fs').writeFileSync('/tmp/qa/e2e_result.json', JSON.stringify(result, null, 2))
  log(`[e2e] RESULT: ${JSON.stringify(result)}`)
  process.exit(result.pass ? 0 : 1)
}
main().catch(e => { console.error('[e2e] ERROR', e); process.exit(2) })
