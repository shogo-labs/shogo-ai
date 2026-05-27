import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
const args = process.argv.slice(2)
const lcovPath = resolve(args[0])
const lcovDir = dirname(lcovPath)
const includes: string[] = []
const excludes: string[] = []
let verbose = false
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--include') includes.push(args[++i])
  else if (args[i] === '--exclude') excludes.push(args[++i])
  else if (args[i] === '--verbose') verbose = true
}
const incAbs = includes.map(i => resolve(i))
const excAbs = excludes.map(i => resolve(i))
const text = readFileSync(lcovPath, 'utf8')
let curFile: string | null = null
let keep = false
let LH = 0, LF = 0, FH = 0, FN = 0
let fileCount = 0
const perFile: Array<{f:string,lh:number,lf:number,fh:number,fn:number}> = []
let cur = {lh:0,lf:0,fh:0,fn:0}
for (const line of text.split('\n')) {
  if (line.startsWith('SF:')) {
    const sf = line.slice(3).trim()
    const sfRoot = resolve(lcovDir, "..", sf)
    const sfRepoRoot = resolve(process.cwd(), sf)
    const abs = sf.startsWith("apps/") || sf.startsWith("packages/") ? sfRepoRoot : sfRoot
    curFile = abs
    const inIncl = incAbs.length === 0 || incAbs.some(r => abs === r || abs.startsWith(r + '/'))
    const inExcl = excAbs.some(r => abs === r || abs.startsWith(r + '/'))
    keep = inIncl && !inExcl
    cur = {lh:0,lf:0,fh:0,fn:0}
    continue
  }
  if (!keep || !curFile) continue
  if (line.startsWith('LH:')) cur.lh = +line.slice(3)
  else if (line.startsWith('LF:')) cur.lf = +line.slice(3)
  else if (line.startsWith('FNH:')) cur.fh = +line.slice(4)
  else if (line.startsWith('FNF:')) cur.fn = +line.slice(4)
  else if (line === 'end_of_record') {
    LH += cur.lh; LF += cur.lf; FH += cur.fh; FN += cur.fn
    fileCount++
    if (verbose) perFile.push({f: curFile, ...cur})
    curFile = null; keep = false
  }
}
const out: any = {
  linesHit: LH, linesFound: LF, linePct: LF ? +(100*LH/LF).toFixed(2) : 0,
  funcsHit: FH, funcsFound: FN, funcPct: FN ? +(100*FH/FN).toFixed(2) : 0,
  fileCount,
}
if (verbose) out.files = perFile
console.log(JSON.stringify(out, null, 2))
