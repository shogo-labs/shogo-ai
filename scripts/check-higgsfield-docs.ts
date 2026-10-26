// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Fail CI when our Higgsfield wiring drifts from the vendor's docs.
 *
 * The committed snapshot in `docs/vendors/higgsfield/` is the contract: the
 * docs prose (`llms-full.txt`) plus the derived `catalog.json`. This checks
 * four things:
 *
 *   1. `catalog.json` still matches what `llms-full.txt` derives (so the
 *      derived file is never hand-edited out of sync).
 *   2. The snapshot's hashes still match `MANIFEST.md` (so nobody quietly
 *      rewrites the snapshot without recording where it came from).
 *   3. Every Higgsfield model in `model-catalog/models.ts` points at an
 *      endpoint the docs document, of the right kind (image / video / edit),
 *      and its declared durations, resolutions and aspect ratios are all
 *      values the vendor accepts.
 *   4. The image request shapes and the presets path in
 *      `apps/api/src/lib/higgsfield-media.ts` are documented too.
 *
 * Each failure names the model and the two sides, so the fix is "refresh the
 * snapshot" (re-run the extractor + `bun run scripts/derive-higgsfield-catalog.ts
 * --write` and update MANIFEST) or "stop sending that parameter".
 *
 * Usage: bun run check:higgsfield-docs
 */

import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'
import { IMAGE_MODEL_CATALOG, VIDEO_MODEL_CATALOG, type ImageModelEntry, type VideoModelEntry } from '../packages/agent/src/model-catalog/models'
import { HIGGSFIELD_RESTYLE_PRESETS_PATH } from '../apps/api/src/lib/higgsfield-media'
import { deriveCatalog, renderCatalog, type HiggsfieldCatalog } from './derive-higgsfield-catalog'
import { GENERATED_PATH as GENERATED_MEDIA_CATALOG, renderMediaCatalog } from './generate-media-catalog'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DOCS_DIR = join(REPO_ROOT, 'docs/vendors/higgsfield')

const problems: string[] = []
const fail = (message: string) => problems.push(message)

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// ---------------------------------------------------------------------------
// 1 + 2. Snapshot integrity
// ---------------------------------------------------------------------------

const llmsFull = readFileSync(join(DOCS_DIR, 'llms-full.txt'), 'utf8')
const committed = readFileSync(join(DOCS_DIR, 'catalog.json'), 'utf8')
const derived = renderCatalog(deriveCatalog(llmsFull))
if (committed !== derived) {
  fail('docs/vendors/higgsfield/catalog.json is stale — run `bun run scripts/derive-higgsfield-catalog.ts --write` and commit the result.')
}

const manifest = readFileSync(join(DOCS_DIR, 'MANIFEST.md'), 'utf8')
for (const file of ['llms-full.txt', 'catalog.json']) {
  const actual = sha256(join(DOCS_DIR, file))
  // MANIFEST lists each file in a table row: `| `<file>` | … | sha256 `<hash>` |`
  const row = manifest
    .split('\n')
    .find((line) => line.trimStart().startsWith(`| \`${file}\``))
  const recorded = row ? /sha256\s+`?([0-9a-f]{64})/.exec(row)?.[1] : undefined
  if (!recorded) fail(`MANIFEST.md does not record a sha256 for ${file}.`)
  else if (recorded !== actual) fail(`MANIFEST.md sha256 for ${file} does not match the file (recorded ${recorded.slice(0, 12)}…, actual ${actual.slice(0, 12)}…).`)
}

const catalog = JSON.parse(committed) as HiggsfieldCatalog
const known = catalog.endpoints

function checkParams(
  label: string,
  endpoint: string,
  field: string,
  values: readonly (string | number)[] | undefined,
) {
  if (!values || values.length === 0) return
  const spec = known[endpoint]?.fields[field]
  if (!spec) {
    fail(`${label}: the docs' schema for ${endpoint} has no '${field}' field, but we declare ${JSON.stringify(values)}.`)
    return
  }
  if (!spec.enum || spec.enum.length === 0) return
  const rejected = values.map(String).filter((value) => !spec.enum!.includes(value))
  if (rejected.length > 0) {
    fail(`${label}: ${endpoint} does not accept ${field} ${rejected.join(', ')} — documented values are ${spec.enum.join(', ')}.`)
  }
}

function checkEndpoint(label: string, endpoint: string | undefined, kind: string) {
  if (!endpoint) return
  const documented = known[endpoint]
  if (!documented) {
    fail(`${label}: endpoint '${endpoint}' is not in the docs snapshot (docs/vendors/higgsfield/catalog.json).`)
    return
  }
  if (documented.kind !== kind) {
    fail(`${label}: '${endpoint}' is wired as a ${kind} endpoint but the docs describe it as '${documented.kind}'.`)
  }
}

// ---------------------------------------------------------------------------
// 3. Model catalog ↔ vendor schemas
// ---------------------------------------------------------------------------

for (const entry of Object.values(IMAGE_MODEL_CATALOG) as ImageModelEntry[]) {
  if (entry.provider !== 'higgsfield') continue
  checkEndpoint(entry.id, entry.apiModel, 'image')
  // The reference/edit endpoint is an image endpoint too.
  checkEndpoint(`${entry.id} edit`, entry.editApiModel, 'image')
}

for (const entry of Object.values(VIDEO_MODEL_CATALOG) as VideoModelEntry[]) {
  if (entry.provider !== 'higgsfield') continue
  const kind = entry.genjutsu ? 'edit' : 'video'
  checkEndpoint(entry.id, entry.textToVideoApiModel, kind)
  checkEndpoint(entry.id, entry.imageToVideoApiModel, kind)
  // The advertised menu has to be valid on *every* generation endpoint: the
  // agent picks the endpoint by whether it passes a start image, not the other
  // way round.
  for (const endpoint of entry.endpoints ?? []) {
    checkParams(entry.id, endpoint, 'duration', entry.durations)
  }
  const primary = entry.textToVideoApiModel ?? entry.imageToVideoApiModel
  checkParams(entry.id, primary, 'aspect_ratio', entry.aspectRatios)
  if (entry.defaultResolution) checkParams(entry.id, primary, 'resolution', [entry.defaultResolution])
  if (entry.durations.length > 0 && !entry.durations.includes(entry.defaultDuration)) {
    fail(`${entry.id}: defaultDuration ${entry.defaultDuration} is not one of its durations (${entry.durations.join(', ')}).`)
  }
  // A Genjutsu workflow needs the source-clip field the docs document.
  if (entry.genjutsu && !known[entry.textToVideoApiModel ?? '']?.fields.video_url) {
    fail(`${entry.id}: the docs' schema for ${entry.textToVideoApiModel} has no 'video_url' — Genjutsu edits need one.`)
  }
  if (entry.genjutsu === 'restyle' && !known[entry.textToVideoApiModel ?? '']?.fields.preset_id) {
    fail(`${entry.id}: the docs' schema for ${entry.textToVideoApiModel} has no 'preset_id', but restyle requires one.`)
  }
  // An advertised option has to be documented on the endpoint it is advertised for.
  for (const [endpoint, options] of Object.entries(entry.optionsByEndpoint ?? {})) {
    const documented = known[endpoint]
    if (!documented) continue
    for (const option of options) {
      const spec = documented.fields[option.name]
      if (!spec) {
        fail(`${entry.id}: advertises option '${option.name}', which ${endpoint} does not document.`)
        continue
      }
      if (option.enum && spec.enum && option.enum.join(',') !== spec.enum.join(',')) {
        fail(`${entry.id}: '${option.name}' values on ${endpoint} are ${option.enum.join(', ')} but the docs say ${spec.enum.join(', ')}.`)
      }
      if (option.minimum !== undefined && option.minimum !== spec.minimum) {
        fail(`${entry.id}: '${option.name}' minimum on ${endpoint} is ${option.minimum} but the docs say ${spec.minimum}.`)
      }
      if (option.maximum !== undefined && option.maximum !== spec.maximum) {
        fail(`${entry.id}: '${option.name}' maximum on ${endpoint} is ${option.maximum} but the docs say ${spec.maximum}.`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. The generated media catalog is current
// ---------------------------------------------------------------------------

// `media-catalog.generated.ts` is rendered from this snapshot plus the overlay.
// Re-render and diff: a vendor endpoint added or renamed, an option whose bounds
// changed, or an overlay entry that no longer matches all surface here instead of
// in a request the vendor rejects.
try {
  const rendered = renderMediaCatalog()
  const onDisk = readFileSync(GENERATED_MEDIA_CATALOG, 'utf8')
  if (rendered !== onDisk) {
    fail('packages/agent/src/model-catalog/media-catalog.generated.ts is stale — run `bun run scripts/generate-media-catalog.ts --write` and commit the result.')
  }
} catch (error: any) {
  fail(`media-catalog.generated.ts cannot be rendered from the snapshot: ${error?.message ?? error}`)
}

const presetsDocumented = llmsFull.includes(HIGGSFIELD_RESTYLE_PRESETS_PATH)
if (!presetsDocumented) {
  fail(`${HIGGSFIELD_RESTYLE_PRESETS_PATH} is used for restyle presets but is not mentioned in the docs snapshot.`)
}

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`❌ Higgsfield docs drift (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nRefresh the snapshot with the extractor in docs/vendors/higgsfield/MANIFEST.md, or stop sending the parameter listed above.')
  process.exit(1)
}

console.log(
  `✅ Higgsfield docs in sync — ${Object.keys(known).length} documented endpoints; ` +
    `${Object.values(VIDEO_MODEL_CATALOG).filter((e) => (e as VideoModelEntry).provider === 'higgsfield').length} video, ` +
    `${Object.values(IMAGE_MODEL_CATALOG).filter((e) => (e as ImageModelEntry).provider === 'higgsfield').length} image models wired.`,
)
