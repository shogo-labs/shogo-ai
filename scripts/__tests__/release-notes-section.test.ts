// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Several workflows write to the same GitHub Release body on a `v*` tag, and
 * the last writer used to wipe the others' blocks: v2.6.7 and v2.6.8 shipped
 * without the runtime digest table (SHO-608). These run the real
 * `.github/scripts/release-notes-section.sh` against a `gh` stub that keeps one
 * body, so the block handling is proven in the order either job can finish —
 * and against the pre-marker body v2.6.5–v2.6.8 actually had.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const SCRIPT = resolve(import.meta.dir, '../../.github/scripts/release-notes-section.sh')
const RUNTIME_WORKFLOW = resolve(import.meta.dir, '../../.github/workflows/runtime-multiarch.yml')
const DESKTOP_WORKFLOW = resolve(import.meta.dir, '../../.github/workflows/desktop-release-macos.yml')

const TAG = 'v9.9.9'

let root: string
let bin: string
let stub: string

const HEAD = `## Download Shogo Desktop

### macOS
- **Apple Silicon (M1–M4):** [Shogo-arm64.dmg](https://example.test/Shogo-arm64.dmg)
- **Intel:** [Shogo-x64.dmg](https://example.test/Shogo-x64.dmg)

### Windows
- **Installer:** [Shogo-Setup.exe](https://example.test/Shogo-Setup.exe)

<details>
<summary>Other files in this release</summary>

- \`shogo-*.tar.gz\` — CLI binaries
</details>
`

const SECTION = `### Standalone agent runtime image

Public multi-arch image (linux/amd64 + linux/arm64), AGPL-3.0-or-later:

\`\`\`
docker pull ghcr.io/shogo-labs/shogo-runtime:${TAG}
\`\`\`

Pin by digest for a reproducible deploy:

| Platform | Digest |
| --- | --- |
| linux/amd64 | \`sha256:amd64digest\` |
| linux/arm64 | \`sha256:arm64digest\` |

Contract: [docs/STANDALONE_RUNTIME.md](https://github.com/shogo-labs/shogo-ai/blob/${TAG}/docs/STANDALONE_RUNTIME.md)
`

/** The v2.6.8 body as GitHub had it: headline, then an unmarked runtime block. */
const LEGACY_BODY = `${HEAD}
### Standalone agent runtime image

Public multi-arch image (linux/amd64 + linux/arm64), AGPL-3.0-or-later:

\`\`\`
docker pull ghcr.io/shogo-labs/shogo-runtime:v2.6.8
\`\`\`

| Platform | Digest |
| --- | --- |
| linux/amd64 | \`sha256:oldamd64\` |
| linux/arm64 | \`sha256:oldarm64\` |
`

function state(): string {
  return join(stub, 'body.md')
}

function writeState(body: string) {
  writeFileSync(state(), body)
}

function readState(): string {
  return readFileSync(state(), 'utf8')
}

function run(args: string[]) {
  return spawnSync(SCRIPT, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STUB_DIR: stub,
      RELEASE_NOTES_RETRY_DELAY: '0',
    },
  })
}

function runUpsert() {
  return run(['upsert', TAG, 'runtime-image', join(stub, 'in.md')])
}

function runRewrite() {
  return run(['rewrite', TAG, join(stub, 'in.md'), '--title', `Shogo Desktop ${TAG}`])
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function calls(): string[] {
  try {
    return readFileSync(join(stub, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'release-notes-'))
  bin = join(root, 'bin')
  stub = join(root, 'stub')
  mkdirSync(bin)
  mkdirSync(stub)
  // `gh` reduced to the three release calls the helper makes. The body lives
  // in $STUB_DIR/body.md; `clobber` (once) and `clobber-always` simulate the
  // other release job writing between our read and our verify.
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
state="$STUB_DIR/body.md"
[ -f "$state" ] || : > "$state"
[ "$1" = "release" ] || { echo "stub gh: unsupported command: $1" >&2; exit 1; }
sub="$2"; tag="$3"; shift 3
case "$sub" in
  view)
    [ -f "$STUB_DIR/no-release" ] && { echo "release not found: $tag" >&2; exit 1; }
    cat "$state"
    ;;
  edit|create)
    notes=""; title=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --notes-file) notes="$2"; shift 2 ;;
        --title) title="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    echo "$sub" >> "$STUB_DIR/calls.log"
    [ -n "$title" ] && printf '%s' "$title" > "$STUB_DIR/title"
    rm -f "$STUB_DIR/no-release"
    if [ -f "$STUB_DIR/clobber" ]; then
      cp "$STUB_DIR/clobber" "$state"
      rm -f "$STUB_DIR/clobber"
    elif [ -f "$STUB_DIR/clobber-always" ]; then
      cp "$STUB_DIR/clobber-always" "$state"
    elif [ -n "$notes" ]; then
      cp "$notes" "$state"
    fi
    ;;
  *)
    echo "stub gh: unsupported release subcommand: $sub" >&2
    exit 1
    ;;
esac
`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(stub, { recursive: true, force: true })
  mkdirSync(stub)
  writeFileSync(join(stub, 'in.md'), SECTION)
  rmSync(join(stub, 'calls.log'), { force: true })
})

describe('upsert', () => {
  test('adds the section to an empty body', () => {
    writeState('')

    const result = runUpsert()

    expect(result.status).toBe(0)
    const body = readState()
    expect(body).toContain('<!-- shogo:section runtime-image -->')
    expect(body).toContain('<!-- /shogo:section runtime-image -->')
    expect(body).toContain('docker pull ghcr.io/shogo-labs/shogo-runtime:v9.9.9')
    expect(body).toContain('sha256:amd64digest')
  })

  test('keeps a desktop headline that is already in the body', () => {
    writeState(HEAD)

    const result = runUpsert()

    expect(result.status).toBe(0)
    const body = readState()
    expect(body.startsWith('## Download Shogo Desktop')).toBe(true)
    expect(body).toContain('Shogo-arm64.dmg')
    expect(body).toContain('### Standalone agent runtime image')
  })

  test('twice leaves one copy, not two', () => {
    writeState('')

    expect(runUpsert().status).toBe(0)
    expect(runUpsert().status).toBe(0)

    const body = readState()
    expect(count(body, '<!-- shogo:section runtime-image -->')).toBe(1)
    expect(count(body, '### Standalone agent runtime image')).toBe(1)
  })

  test('replaces a stale section instead of appending beside it', () => {
    writeState(`<!-- shogo:section runtime-image -->\n\n### Standalone agent runtime image\n\nold digests\n\n<!-- /shogo:section runtime-image -->\n`)

    expect(runUpsert().status).toBe(0)

    const body = readState()
    expect(body).not.toContain('old digests')
    expect(body).toContain('sha256:amd64digest')
    expect(count(body, '<!-- shogo:section runtime-image -->')).toBe(1)
  })

  test('creates the release as a draft when the tag has none yet', () => {
    writeState('')
    writeFileSync(join(stub, 'no-release'), '')

    const result = runUpsert()

    expect(result.status).toBe(0)
    expect(calls()[0]).toBe('create')
  })
})

describe('rewrite', () => {
  beforeEach(() => {
    writeFileSync(join(stub, 'in.md'), HEAD)
  })

  test('puts the head on top and keeps a marked section', () => {
    writeState(`<!-- shogo:section runtime-image -->\n\n${SECTION}\n<!-- /shogo:section runtime-image -->\n`)

    const result = runRewrite()

    expect(result.status).toBe(0)
    const body = readState()
    expect(body.startsWith('## Download Shogo Desktop')).toBe(true)
    expect(body).toContain('### Standalone agent runtime image')
    expect(body).toContain('sha256:arm64digest')
    expect(readFileSync(join(stub, 'title'), 'utf8')).toBe(`Shogo Desktop ${TAG}`)
  })

  test('keeps the unmarked runtime block of a v2.6.8 body and marks it', () => {
    writeState(LEGACY_BODY)

    const result = runRewrite()

    expect(result.status).toBe(0)
    const body = readState()
    expect(body.startsWith('## Download Shogo Desktop')).toBe(true)
    expect(body).toContain('docker pull ghcr.io/shogo-labs/shogo-runtime:v2.6.8')
    expect(body).toContain('sha256:oldarm64')
    expect(body).toContain('<!-- shogo:section runtime-image -->')
  })

  test('twice leaves one head and one section', () => {
    writeState(`<!-- shogo:section runtime-image -->\n\n${SECTION}\n<!-- /shogo:section runtime-image -->\n`)

    expect(runRewrite().status).toBe(0)
    expect(runRewrite().status).toBe(0)

    const body = readState()
    expect(count(body, '## Download Shogo Desktop')).toBe(1)
    expect(count(body, '<!-- shogo:section runtime-image -->')).toBe(1)
  })
})

describe('the two jobs in either order', () => {
  test('runtime then headline', () => {
    writeState('')

    expect(runUpsert().status).toBe(0)

    writeFileSync(join(stub, 'in.md'), HEAD)
    expect(runRewrite().status).toBe(0)

    const body = readState()
    expect(body.startsWith('## Download Shogo Desktop')).toBe(true)
    expect(body).toContain('### Standalone agent runtime image')
    expect(body).toContain('sha256:amd64digest')
    expect(body).toContain('sha256:arm64digest')
  })

  test('headline then runtime', () => {
    writeState('')

    writeFileSync(join(stub, 'in.md'), HEAD)
    expect(runRewrite().status).toBe(0)

    writeFileSync(join(stub, 'in.md'), SECTION)
    expect(runUpsert().status).toBe(0)

    const body = readState()
    expect(body.startsWith('## Download Shogo Desktop')).toBe(true)
    expect(body).toContain('### Standalone agent runtime image')
    expect(body).toContain('sha256:amd64digest')
    expect(body).toContain('sha256:arm64digest')
  })

  test('headline clobbers the runtime write mid-flight: upsert retries and wins', () => {
    writeState('')
    writeFileSync(join(stub, 'clobber'), HEAD)

    const result = runUpsert()

    expect(result.status).toBe(0)
    expect(calls()).toEqual(['edit', 'edit'])
    const body = readState()
    expect(body.startsWith('## Download Shogo Desktop')).toBe(true)
    expect(body).toContain('sha256:amd64digest')
    expect(count(body, '<!-- shogo:section runtime-image -->')).toBe(1)
  })

  test('runtime clobbers the headline write mid-flight: rewrite retries and keeps the section', () => {
    writeFileSync(join(stub, 'in.md'), HEAD)
    writeState('')
    writeFileSync(join(stub, 'clobber'), `<!-- shogo:section runtime-image -->\n\n${SECTION}\n<!-- /shogo:section runtime-image -->\n`)

    const result = runRewrite()

    expect(result.status).toBe(0)
    expect(calls()).toEqual(['edit', 'edit'])
    const body = readState()
    expect(body.startsWith('## Download Shogo Desktop')).toBe(true)
    expect(body).toContain('sha256:amd64digest')
  })

  test('gives up loudly instead of leaving a wrong body', () => {
    writeState('')
    writeFileSync(join(stub, 'clobber-always'), HEAD)

    const result = runUpsert()

    expect(result.status).toBe(1)
    expect(calls()).toHaveLength(3)
    expect(result.stderr).toContain('::error::')
  })
})

describe('workflow wiring', () => {
  const runtime = readFileSync(RUNTIME_WORKFLOW, 'utf8')
  const desktop = readFileSync(DESKTOP_WORKFLOW, 'utf8')

  test('runtime publish upserts its section instead of appending the whole body', () => {
    expect(runtime).toContain('release-notes-section.sh upsert "$TAG" runtime-image runtime-image.md')
    expect(runtime).not.toContain('append_body')
  })

  test('the anonymous-pull check runs after the notes write, without a login', () => {
    const notes = runtime.indexOf('name: Write the runtime image section of the release notes')
    const anonymous = runtime.indexOf('name: Verify anonymous pull')
    expect(notes).toBeGreaterThan(-1)
    expect(anonymous).toBeGreaterThan(notes)

    const step = runtime.slice(anonymous).split('\n      - name: ')[0] ?? ''
    expect(step).toContain('check-ghcr-anonymous-pull.sh ghcr.io/shogo-labs/shogo-runtime')
    expect(step).not.toContain('docker login')
  })

  test('the desktop headline step rewrites the body through the helper', () => {
    const start = desktop.indexOf('name: Make desktop downloads the headline of the release notes')
    const step = desktop.slice(start).split('\n      - name: ')[0] ?? ''
    expect(step).toContain('release-notes-section.sh rewrite "${{ github.ref_name }}" release-notes.md')
    expect(step).toContain('--title "Shogo Desktop ${{ github.ref_name }}"')
    expect(step).not.toMatch(/^ {10}gh release edit/m)
  })

  test('both jobs have the repo checked out, since the helper ships with it', () => {
    // One checkout per file is enough: the release / publish jobs are the only
    // ones that call the helper, and a job without a checkout would not find it.
    for (const workflow of [runtime, desktop]) {
      expect(workflow).toContain('actions/checkout@')
    }
    const releaseJob = desktop.slice(desktop.indexOf('    name: Create Release'))
    const releaseJobSteps = releaseJob.slice(0, releaseJob.indexOf('      - name: Download all artifacts'))
    expect(releaseJobSteps).toContain('actions/checkout@')
  })
})
