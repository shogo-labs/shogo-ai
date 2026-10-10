// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 *   bun scripts/bench/memory-report-cli.ts --pid <pid> --label launch-idle [--assert]
 */
import { join } from 'node:path'
import {
  buildCheckpoint,
  descendants,
  evaluateBudgets,
  readFootprintMb,
  sampleProcessList,
  writeReport,
} from './memory-report'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (import.meta.main) {
  const root = Number(arg('--pid') ?? process.pid)
  const label = arg('--label') ?? 'sample'
  const out = arg('--out') ?? join(import.meta.dir, '..', '..', 'bench-results')
  const processes = descendants(sampleProcessList(), root)
  const checkpoint = buildCheckpoint({
    name: label,
    electron: [],
    processes,
    footprintMb: readFootprintMb(root) ?? undefined,
  })
  const written = writeReport(out, [checkpoint])
  console.log(`Wrote ${written.mdPath}`)
  const failures = evaluateBudgets([checkpoint])
  if (failures.length && process.argv.includes('--assert')) {
    console.error(failures)
    process.exit(1)
  }
}
