#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Generates the Lucide icon declarations section of canvas-globals.d.ts.
// Run: bun run packages/canvas-runtime/scripts/generate-canvas-globals.ts

import * as LucideIcons from 'lucide-react'
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DTS_PATH = resolve(__dirname, '../src/canvas-globals.d.ts')

const iconNames = Object.keys(LucideIcons)
  .filter(k => /^[A-Z]/.test(k) && k !== 'createLucideIcon' && !k.endsWith('Icon'))
  .sort()

const declarations = iconNames
  .map(name => `declare const ${name}: React.FC<{ className?: string; size?: number; color?: string; strokeWidth?: number }>`)
  .join('\n')

const dts = readFileSync(DTS_PATH, 'utf-8')
const START = '// LUCIDE_ICONS_START'
const END = '// LUCIDE_ICONS_END'

const startIdx = dts.indexOf(START)
const endIdx = dts.indexOf(END)

if (startIdx === -1 || endIdx === -1) {
  console.error('Could not find LUCIDE_ICONS_START/END markers in canvas-globals.d.ts')
  process.exit(1)
}

const updated =
  dts.slice(0, startIdx + START.length) +
  '\n' + declarations + '\n' +
  dts.slice(endIdx)

writeFileSync(DTS_PATH, updated, 'utf-8')
console.log(`Wrote ${iconNames.length} Lucide icon declarations to canvas-globals.d.ts`)
