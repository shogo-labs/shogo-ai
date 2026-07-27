import { emitLogToSink, setOtelLogSink, createLogger } from './logger'
import { writeFileSync } from 'fs'

const results: { name: string; pass: boolean; detail?: string }[] = []
const check = (name: string, pass: boolean, detail?: string) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }

// 1. no-op when no sink installed (must not throw)
setOtelLogSink(null)
let threw = false
try { emitLogToSink({ level: 'info', msg: 'no sink', service: 'x' }) } catch { threw = true }
check('emitLogToSink is a no-op (no throw) when no sink installed', !threw)

// 2. forwards to sink with defaulted timestamp + attributes
let captured: any = null
setOtelLogSink((e: any) => { captured = e })
emitLogToSink({ level: 'error', msg: 'hello', service: 'shogo-agent-runtime', 'log.source': 'build.log', 'log.stream': 'stderr', 'project.id': 'p-123' })
check('forwards entry to sink', !!captured && captured.msg === 'hello' && captured.level === 'error')
check('defaults a timestamp when omitted', typeof captured?.timestamp === 'string' && captured.timestamp.length > 0, captured?.timestamp)
check('passes through custom attributes', captured?.['log.source'] === 'build.log' && captured?.['log.stream'] === 'stderr' && captured?.['project.id'] === 'p-123')

// 3. explicit timestamp is preserved
captured = null
emitLogToSink({ level: 'info', msg: 'ts', service: 'x', timestamp: '2020-01-01T00:00:00.000Z' })
check('preserves an explicit timestamp', captured?.timestamp === '2020-01-01T00:00:00.000Z')

// 4. swallows sink errors (telemetry must never break caller)
setOtelLogSink(() => { throw new Error('sink boom') })
let threw2 = false
try { emitLogToSink({ level: 'info', msg: 'boom', service: 'x' }) } catch { threw2 = true }
check('swallows sink errors (never throws to caller)', !threw2)

// 5. contrast: emitLogToSink does NOT write to console (the reason it exists)
setOtelLogSink((e: any) => { captured = e })
const origLog = console.log; let consoleHits = 0; console.log = (...a) => { consoleHits++; origLog(...a) }
emitLogToSink({ level: 'info', msg: 'silent', service: 'x' })
console.log = origLog
check('emitLogToSink does not write to console (unlike createLogger)', consoleHits === 0, `hits=${consoleHits}`)

const passed = results.filter(r => r.pass).length
writeFileSync('/tmp/qa/logger_result.json', JSON.stringify({ total: results.length, passed, failed: results.length - passed, results }, null, 2))
console.log(`\n==== ${passed}/${results.length} emitLogToSink checks passed ====`)
process.exit(passed === results.length ? 0 : 1)
