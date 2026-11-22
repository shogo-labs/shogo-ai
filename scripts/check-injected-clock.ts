// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ratchet: a function that is handed a clock must not read the wall clock.
 *
 * Background (SHO-505). `reconcile()` in `compute-usage.ts` took `{ now }` from
 * its caller and then read `Date.now()` for one branch (`runningSinceMs`). The
 * acceptance suite seeded rows dated 2026-11-18 and passed; a few days later the
 * same test failed on `main` for every commit, because the code was reading a
 * clock the test could not pin. The caller had already done the right thing —
 * one live read inside the callee was enough to make the test a time bomb.
 *
 * The shape is mechanical and catches it without a type checker: a function
 * whose parameters include `now` (a `now` parameter, `{ now }` destructured from
 * a params object, or a `{ now: … }` type literal) must not call `Date.now()` or
 * argument-less `new Date()` anywhere in its body, nested arrows included.
 *
 *   bun scripts/check-injected-clock.ts                  # check (CI)
 *   bun scripts/check-injected-clock.ts --write-baseline  # re-baseline
 *
 * A deliberate live read — a duration measured from process start, a default
 * that the caller may override — is marked on the line above:
 *
 *   // injected-clock: live running-since falls back to process start
 *   const runningSinceMs = Date.now()
 *
 * The `??` fallback onto the injected value is *not* a finding and needs no
 * comment: `now = params.now ?? new Date()` is where the live clock enters the
 * privileged path on purpose, and flagging it would put an escape comment on
 * correct code.
 *
 * No ESLint runs over `apps/api` (the root `lint` script is a no-op), which is
 * why this is a compiler-API script like the other `check-*.ts` gates rather
 * than a rule.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import ts from 'typescript'
import { walkSourceFiles } from './lib/walk-source-files'

const REPO_ROOT = resolve(import.meta.dir, '..')
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'injected-clock-baseline.json')

/** Where production code lives. Tests are excluded: they are the callers. */
const SCOPE_ROOTS = ['apps/api/src', 'apps/mobile', 'packages'] as const

const ESCAPE_RE = /\/\/\s*injected-clock:\s*live\s+\S/

export type ClockReadKind = 'Date.now()' | 'new Date()'

export interface InjectedClockFinding {
  /** 1-based line number. */
  line: number
  kind: ClockReadKind
  /** The clock-injected function the read sits in. */
  owner: string
}

/** `file kind` -> count, e.g. `"apps/api/src/services/x.ts Date.now()": 2`. */
export type InjectedClockBaseline = Record<string, number>

export interface SourceInput {
  file: string
  source: string
}

export interface InjectedClockReport {
  regressions: string[]
  stale: string[]
}

function isNowParam(param: ts.ParameterDeclaration): boolean {
  if (ts.isIdentifier(param.name) && param.name.text === 'now') return true
  if (ts.isObjectBindingPattern(param.name)) {
    return param.name.elements.some((element) => ts.isIdentifier(element.name) && element.name.text === 'now')
  }
  const type = param.type
  if (type && ts.isTypeLiteralNode(type)) {
    return type.members.some(
      (member) => ts.isPropertySignature(member) && !!member.name && ts.isIdentifier(member.name) && member.name.text === 'now',
    )
  }
  return false
}

function takesNow(node: ts.SignatureDeclaration): boolean {
  return node.parameters.some(isNowParam)
}

function readKind(node: ts.Node): ClockReadKind | null {
  if (ts.isCallExpression(node)) {
    const callee = node.expression
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'now' &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Date'
    ) {
      return 'Date.now()'
    }
  }
  if (ts.isNewExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === 'Date' && (node.arguments?.length ?? 0) === 0) {
      return 'new Date()'
    }
  }
  return null
}

function ownerName(node: ts.SignatureDeclaration, source: ts.SourceFile): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.getText(source)
  }
  return '<anonymous>'
}

function isFunctionWithBody(node: ts.Node): node is ts.SignatureDeclaration & { body: ts.ConciseBody } {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)) &&
    !!node.body
  )
}

/** `const reconcile = async () => …` is called `reconcile` just like a declaration. */
function callableName(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.getText()
  }
  const parent = node.parent
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  return null
}

/**
 * `now = params.now ?? new Date()` — the fallback is the injection seam itself,
 * not a leak past the caller's clock.
 */
function isNowFallback(node: ts.Node): boolean {
  const parent = node.parent
  if (!parent || !ts.isBinaryExpression(parent)) return false
  const op = parent.operatorToken.kind
  if (op !== ts.SyntaxKind.QuestionQuestionToken && op !== ts.SyntaxKind.BarBarToken) return false
  const sibling = parent.left === node ? parent.right : parent.left
  return /\bnow\b/.test(sibling.getText())
}

/** Names of the file's own functions called anywhere inside `body`. */
function calledNames(body: ts.Node): Set<string> {
  const names = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee)) names.add(callee.text)
      else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text)
    }
    ts.forEachChild(node, walk)
  }
  walk(body)
  return names
}

/**
 * Every live-clock read that a clock-injected caller can reach: reads in the
 * injected function itself, and reads one call away in a helper it delegates to.
 *
 * The second half is the SHO-505 shape exactly: `adminComputeSummary({ now })`
 * awaited `reconcile()`, which took no argument and read `Date.now()` for its
 * 72h window. Nothing in `reconcile` looked wrong; the fault was a helper that
 * ignored the caller's injected clock. One hop covers that; a deeper chain still
 * surfaces at the helper that does the read, so it is reported once as its own
 * finding when that helper is itself reached from an injected caller.
 */
export function findInjectedClockReads(source: string, fileName = 'source.ts'): InjectedClockFinding[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = source.split('\n')

  const isEscaped = (position: number): boolean => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(position)
    const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0)
    if (ESCAPE_RE.test(lines[line].slice(0, position - lineStart))) return true
    return line > 0 && ESCAPE_RE.test(lines[line - 1])
  }

  const findings: InjectedClockFinding[] = []
  const seen = new Set<string>()
  const anchors: (ts.SignatureDeclaration & { body: ts.ConciseBody })[] = []
  const byName = new Map<string, ts.Node>()

  const visit = (node: ts.Node): void => {
    if (isFunctionWithBody(node)) {
      if (takesNow(node)) anchors.push(node)
      const name = callableName(node)
      if (name && !byName.has(name)) byName.set(name, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const scanBody = (fn: ts.SignatureDeclaration & { body: ts.ConciseBody }, owner: string): void => {
    const walk = (node: ts.Node): void => {
      const kind = readKind(node)
      if (kind) {
        const start = node.getStart(sourceFile)
        if (!isNowFallback(node) && !isEscaped(start)) {
          const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1
          const key = `${line} ${kind}`
          if (!seen.has(key)) {
            seen.add(key)
            findings.push({ line, kind, owner })
          }
        }
      }
      ts.forEachChild(node, walk)
    }
    walk(fn.body)
  }

  for (const anchor of anchors) {
    const anchorLabel = ownerName(anchor, sourceFile)
    scanBody(anchor, anchorLabel)
    for (const name of calledNames(anchor.body)) {
      const callee = byName.get(name)
      if (!callee || callee === anchor || !isFunctionWithBody(callee)) continue
      // A callee that takes `now` is checked as its own anchor, not as a leak.
      if (takesNow(callee)) continue
      scanBody(callee, `${name}() called from ${anchorLabel}`)
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind))
}

/** Functions handed `now` that still read the wall clock, as baseline keys. */
export function collectInjectedClockReads(files: readonly SourceInput[]): InjectedClockBaseline {
  const counts: InjectedClockBaseline = {}
  for (const { file, source } of files) {
    for (const finding of findInjectedClockReads(source, file)) {
      const key = `${file} ${finding.kind}`
      counts[key] = (counts[key] ?? 0) + 1
    }
  }
  return counts
}

export function evaluateInjectedClock(
  current: InjectedClockBaseline,
  baseline: InjectedClockBaseline,
): InjectedClockReport {
  const regressions = Object.entries(current)
    .filter(([key, count]) => count > (baseline[key] ?? 0))
    .map(([key, count]) => `+${count - (baseline[key] ?? 0)}  ${key}`)
    .sort()
  const stale = Object.keys(baseline)
    .filter((key) => (current[key] ?? 0) === 0)
    .sort()
  return { regressions, stale }
}

/** Production source in the rule's scope (no tests, mocks, generated or dist). */
export function collectSourceFiles(root: string): string[] {
  const files = new Set<string>()
  for (const scope of SCOPE_ROOTS) {
    const dir = join(root, scope)
    if (!existsSync(dir)) continue
    for (const file of walkSourceFiles(dir, { extensions: ['.ts', '.tsx'], skipDirs: ['__tests__', '__mocks__'] })) {
      const repoRelative = join(scope, file).split('\\').join('/')
      if (repoRelative.endsWith('.test.ts') || repoRelative.endsWith('.test.tsx')) continue
      if (repoRelative.endsWith('.spec.ts') || repoRelative.endsWith('.spec.tsx')) continue
      if (repoRelative.endsWith('.d.ts')) continue
      // packages/* only; a nested apps/ or node_modules under packages is not our code.
      if (scope === 'packages' && !repoRelative.startsWith('packages/')) continue
      if (scope === 'packages' && !repoRelative.split('/').includes('src')) continue
      files.add(repoRelative)
    }
  }
  return [...files].sort()
}

function sortKeys(baseline: InjectedClockBaseline): InjectedClockBaseline {
  return Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)))
}

function main(): void {
  const writeBaseline = process.argv.includes('--write-baseline')
  const files: SourceInput[] = collectSourceFiles(REPO_ROOT).map((file) => ({
    file,
    source: readFileSync(join(REPO_ROOT, file), 'utf-8'),
  }))
  const current = collectInjectedClockReads(files)
  const total = Object.values(current).reduce((sum, n) => sum + n, 0)

  if (writeBaseline) {
    writeFileSync(BASELINE_PATH, JSON.stringify(sortKeys(current), null, 2) + '\n')
    console.log(
      `[injected-clock] baseline written: ${total} live read(s) inside clock-injected functions across ${Object.keys(current).length} key(s)`,
    )
    return
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error('[injected-clock] scripts/injected-clock-baseline.json is missing. Run `bun scripts/check-injected-clock.ts --write-baseline`.')
    process.exit(1)
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as InjectedClockBaseline
  const report = evaluateInjectedClock(current, baseline)

  if (report.regressions.length > 0) {
    console.error(`[injected-clock] ${report.regressions.length} new live-clock read(s) inside a function that is handed \`now\`:`)
    for (const line of report.regressions) console.error('  ' + line)
    console.error(
      '\nUse the injected value (`now.getTime()`, `now`), not `Date.now()` / `new Date()`. A caller that pins the clock cannot pin a read you made behind its back — that is how SHO-505 turned a passing test into a main-red time bomb.\n' +
        'A deliberate live read is marked on the line above: `// injected-clock: live <reason>`.',
    )
  }

  if (report.stale.length > 0) {
    console.error(`[injected-clock] ${report.stale.length} baseline entr(ies) are stale — the read is gone:`)
    for (const key of report.stale) console.error('  ' + key)
    console.error('Remove them with `bun scripts/check-injected-clock.ts --write-baseline` so the ratchet keeps shrinking.')
  }

  if (report.regressions.length > 0 || report.stale.length > 0) process.exit(1)

  const known = Object.values(baseline).reduce((sum, n) => sum + n, 0)
  console.log(`[injected-clock] ok: no new live-clock read (baselined: ${known} known read(s) in ${Object.keys(baseline).length} key(s))`)
}

if (import.meta.main) main()
