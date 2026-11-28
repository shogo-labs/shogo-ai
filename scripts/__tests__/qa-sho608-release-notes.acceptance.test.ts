// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * SHO-608 acceptance (QA).
 *
 * The customer-visible promise is about the FINAL body of a stable tag, and it
 * is made by four workflows that all publish to the same `v*` release. These
 * tests drive the real `.github/scripts/release-notes-section.sh` over the body
 * GitHub actually had on v2.6.8, in both finish orders and twice each, and then
 * check the class property the scripts' own header claims: every publisher of a
 * `v*` body goes through the helper.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const REPO = resolve(import.meta.dir, '../..')
const SCRIPT = join(REPO, '.github/scripts/release-notes-section.sh')
const WORKFLOWS = join(REPO, '.github/workflows')

const TAG = 'v2.7.0'
const AMD64 = 'sha256:13445dc2c254615ab9f467552dab80fef409f45cb3a2f6ff97b7080c183fdfb5'
const ARM64 = 'sha256:0dfa8200f0268a1298b10d6103f9c0f2f0320bcfb6ee78441c9dadf07139a7f9'

/** The desktop headline the release job writes. */
const HEAD = `## Download Shogo Desktop

### macOS
- **Apple Silicon (M1–M4):** [Shogo-arm64.dmg](https://example.test/Shogo-arm64.dmg)
- **Intel:** [Shogo-x64.dmg](https://example.test/Shogo-x64.dmg)

### Windows
- **Installer:** [Shogo-Setup.exe](https://example.test/Shogo-Setup.exe)

<details>
<summary>Other files in this release</summary>

- shogo-agent-runtime-*.tar.gz
</details>
`

/** What runtime-multiarch's publish job renders for a tag. */
const RUNTIME_SECTION = `### Standalone agent runtime image

Public multi-arch image (linux/amd64 + linux/arm64), AGPL-3.0-or-later:

\`\`\`
docker pull ghcr.io/shogo-labs/shogo-runtime:${TAG}
\`\`\`

Pin by digest for a reproducible deploy:

| Platform | Digest |
| --- | --- |
| linux/amd64 | \`${AMD64}\` |
| linux/arm64 | \`${ARM64}\` |

Contract: [docs/STANDALONE_RUNTIME.md](https://github.com/shogo-labs/shogo-ai/blob/${TAG}/docs/STANDALONE_RUNTIME.md)
`

/**
 * The v2.6.8 body as it shipped before this fix: the desktop headline followed
 * by a bare, unmarked runtime block. This exact shape is what the first real
 * tag after merge will start from.
 */
const SHIPPED_V268 = `## Download Shogo Desktop

### macOS
- **Apple Silicon (M1–M4):** [Shogo-arm64.dmg](https://github.com/shogo-labs/shogo-ai/releases/download/v2.6.8/Shogo-arm64.dmg)
- **Intel:** [Shogo-x64.dmg](https://github.com/shogo-labs/shogo-ai/releases/download/v2.6.8/Shogo-x64.dmg)

### Windows
- **Installer:** [Shogo-Setup.exe](https://github.com/shogo-labs/shogo-ai/releases/download/v2.6.8/Shogo-Setup.exe)

<details>
<summary>Other files in this release — you don't need these to install the desktop app</summary>

These ride the same tag for the CLI, self-hosted workers, and the in-app auto-updater:

- \`shogo-agent-runtime-*.tar.gz\` — fetched by \`shogo runtime install\`
- \`shogo-*.tar.gz\` — Shogo CLI / worker binaries
</details>


### Standalone agent runtime image

Public multi-arch image (linux/amd64 + linux/arm64), AGPL-3.0-or-later:

\`\`\`
docker pull ghcr.io/shogo-labs/shogo-runtime:v2.6.8
\`\`\`

Pin by digest for a reproducible deploy:

| Platform | Digest |
| --- | --- |
| linux/amd64 | \`sha256:oldamd64digest\` |
| linux/arm64 | \`sha256:oldarm64digest\` |

Contract: [docs/STANDALONE_RUNTIME.md](https://github.com/shogo-labs/shogo-ai/blob/v2.6.8/docs/STANDALONE_RUNTIME.md)`

let root: string
let bin: string
let stub: string

function bodyFile(): string {
  return join(stub, 'body.md')
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

function upsert() {
  writeFileSync(join(stub, 'in.md'), RUNTIME_SECTION)
  return run(['upsert', TAG, 'runtime-image', join(stub, 'in.md')])
}

function rewrite() {
  writeFileSync(join(stub, 'in.md'), HEAD)
  return run(['rewrite', TAG, join(stub, 'in.md'), '--title', `Shogo Desktop ${TAG}`])
}

function body(): string {
  return readFileSync(bodyFile(), 'utf8')
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function expectFinalBody(final: string) {
  expect(final.trimStart().startsWith('## Download Shogo Desktop')).toBe(true)
  expect(occurrences(final, '### Standalone agent runtime image')).toBe(1)
  expect(occurrences(final, '<!-- shogo:section runtime-image -->')).toBe(1)
  expect(occurrences(final, '<!-- /shogo:section runtime-image -->')).toBe(1)
  expect(final).toContain(AMD64)
  expect(final).toContain(ARM64)
  expect(final).not.toContain('sha256:oldamd64digest')
  expect(final.indexOf('## Download Shogo Desktop')).toBeLessThan(
    final.indexOf('### Standalone agent runtime image'),
  )
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'qa-sho608-'))
  bin = join(root, 'bin')
  stub = join(root, 'stub')
  mkdirSync(bin)
  mkdirSync(stub)
  // `gh` with one release body on disk. `$STUB_DIR/clobber` is another
  // publisher's write landing between our read and our verify.
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
set -euo pipefail
state="$STUB_DIR/body.md"
[ -f "$state" ] || : > "$state"
[ "$1" = "release" ] || { echo "stub gh: unsupported: $1" >&2; exit 1; }
sub="$2"; shift 2
case "$sub" in
  view) cat "$state" ;;
  edit|create)
    notes=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --notes-file) notes="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [ -f "$STUB_DIR/clobber" ]; then
      cp "$STUB_DIR/clobber" "$state"
      rm -f "$STUB_DIR/clobber"
    elif [ -n "$notes" ]; then
      cp "$notes" "$state"
    fi
    ;;
  *) echo "stub gh: unsupported release: $sub" >&2; exit 1 ;;
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
})

describe('the final body of a stable tag, starting from what v2.6.8 shipped', () => {
  test('runtime publishes first, then the desktop headline', () => {
    writeFileSync(bodyFile(), SHIPPED_V268)

    expect(upsert().status).toBe(0)
    // The pre-marker block is understood, wrapped, and replaced in place.
    expect(occurrences(body(), '<!-- shogo:section runtime-image -->')).toBe(1)
    expect(occurrences(body(), '### Standalone agent runtime image')).toBe(1)

    expect(rewrite().status).toBe(0)
    expectFinalBody(body())
  })

  test('the desktop headline publishes first, then runtime', () => {
    writeFileSync(bodyFile(), SHIPPED_V268)

    expect(rewrite().status).toBe(0)
    expect(rewrite().status).toBe(0)
    expect(body()).toContain('### Standalone agent runtime image')

    expect(upsert().status).toBe(0)
    expectFinalBody(body())
  })

  test('re-running both jobs changes nothing and duplicates nothing', () => {
    writeFileSync(bodyFile(), SHIPPED_V268)
    expect(upsert().status).toBe(0)
    expect(rewrite().status).toBe(0)
    const once = body()

    expect(upsert().status).toBe(0)
    expect(rewrite().status).toBe(0)
    expect(body()).toBe(once)
    expectFinalBody(body())
  })

  test('a clobbering write mid-flight is repaired, not trusted', () => {
    writeFileSync(bodyFile(), SHIPPED_V268)
    // Another publisher replaces the whole body right after our write.
    writeFileSync(join(stub, 'clobber'), SHIPPED_V268)

    const result = upsert()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('retrying')
    expectFinalBody(body())
  })
})

/**
 * The helper's own header says "Four workflows write to a `v*` release on the
 * same tag … Every block now lives between markers, and every writer goes
 * through this script". This is that claim as a test: a publisher of a `v*`
 * body that does not use the helper drops whichever block it did not write.
 */
describe('every workflow that writes a v* release body goes through the helper', () => {
  test('no softprops body:/body_path: on a v* tag', () => {
    const offenders: string[] = []
    for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
      const text = readFileSync(join(WORKFLOWS, file), 'utf8')
      if (!/^\s+- 'v\[0-9\]\*'$/m.test(text)) continue
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (!/uses:\s*softprops\/action-gh-release/.test(line)) continue
        const indent = line.length - line.trimStart().length
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j]!
          const nextIndent = next.length - next.trimStart().length
          if (next.trim() !== '' && nextIndent <= indent && next.trimStart().startsWith('- ')) break
          const code = next.replace(/\s+#.*$/, '')
          if (/^\s*(body|body_path):/.test(code) && !code.trimStart().startsWith('#')) {
            offenders.push(`${file}:${j + 1}: ${code.trim()}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('no bare gh release edit --notes-file on a stable tag', () => {
    const offenders: string[] = []
    for (const file of readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
      const text = readFileSync(join(WORKFLOWS, file), 'utf8')
      if (!/^\s+- 'v\[0-9\]\*'$/m.test(text)) continue
      const steps = text.split(/\n(?=\s{6}- )/)
      for (const step of steps) {
        if (!/--notes-file/.test(step)) continue
        if (/release-notes-section\.sh/.test(step)) continue
        if (/channel =+ 'beta'/.test(step) || /channel == 'beta'/.test(step)) continue
        const name = /- name:\s*(.+)/.exec(step)?.[1] ?? step.slice(0, 60)
        offenders.push(`${file}: ${name.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('the docs promise what the release now does', () => {
  test('STANDALONE_RUNTIME.md is conditional and says who to tell', () => {
    const doc = readFileSync(join(REPO, 'docs/STANDALONE_RUNTIME.md'), 'utf8')
    expect(doc).not.toContain('The package is public: no\ncredentials are needed to pull it')
    expect(doc).not.toMatch(/The package is public[^\n]*no\s+credentials/)
    expect(doc).toMatch(/every\s+release tag \*\*checks\*\* that it pulls anonymously/i)
    expect(doc).toContain('security@shogo.ai')
    expect(doc).toContain('docker logout ghcr.io && docker pull ghcr.io/shogo-labs/shogo-runtime')
  })

  test('the runbook has the visibility step and both checks', () => {
    const doc = readFileSync(join(REPO, 'docs/runbooks/deploy-prod.md'), 'utf8')
    const start = doc.indexOf('## Standalone runtime image (GHCR)')
    expect(start).toBeGreaterThan(-1)
    const section = doc.slice(start, doc.indexOf('\n## ', start + 5))
    expect(section).toContain('Change visibility')
    expect(section).toContain('Verify anonymous pull')
    expect(section).toContain('.github/scripts/check-ghcr-anonymous-pull.sh')
    expect(section).toContain("gh release view <tag> --json body -q .body | grep -A6 'Standalone agent runtime image'")
    expect(section).toMatch(/re-run the tag's `publish` job/i)
  })
})

/**
 * The end-to-end shape of a real tag: the four `run:` blocks copied out of the
 * workflows and executed as written (only the `${{ }}` expressions substituted,
 * exactly as Actions would), against one stubbed release body. Whatever order
 * the jobs happen to finish in, every block must still be in the final body.
 */
const PUBLISHERS = [
  {
    file: 'runtime-multiarch.yml',
    name: 'Write the runtime image section of the release notes',
    env: { TAG, AMD64, ARM64, GH_REPO: 'shogo-labs/shogo-ai' },
    section: 'runtime-image',
    marker: '### Standalone agent runtime image',
    needle: AMD64,
  },
  {
    file: 'publish-agent-runtime.yml',
    name: 'Write the agent-runtime section of the release notes',
    env: { TAG, CHANNEL: 'stable', GH_REPO: 'shogo-labs/shogo-ai' },
    section: 'agent-runtime',
    marker: '### Prebuilt agent-runtime binaries',
    needle: 'shogo runtime install --channel stable',
  },
  {
    file: 'publish-shogo-worker.yml',
    name: 'Write the worker-binaries section of the release notes',
    env: { TAG, CHANNEL: 'latest', GH_REPO: 'shogo-labs/shogo-ai' },
    section: 'worker-binaries',
    marker: '### Prebuilt `shogo` worker binaries',
    needle: 'npm i -g @shogo-ai/worker',
  },
  {
    file: 'desktop-release-macos.yml',
    name: 'Make desktop downloads the headline of the release notes',
    env: { GH_REPO: 'shogo-labs/shogo-ai' },
    section: null,
    marker: '## Download Shogo Desktop',
    needle: 'Shogo-Setup.exe',
  },
] as const

function stepScript(file: string, name: string): string {
  const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split('\n')
  const start = lines.findIndex((l) => new RegExp(`^\\s+- name: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l))
  if (start < 0) throw new Error(`no step "${name}" in ${file}`)
  let i = start + 1
  while (i < lines.length && lines[i]!.trim() !== 'run: |') {
    if (/^\s+- name:/.test(lines[i]!)) throw new Error(`step "${name}" has no run block`)
    i++
  }
  if (i >= lines.length) throw new Error(`step "${name}" has no run block`)
  const indent = lines[i]!.length - lines[i]!.trimStart().length
  const body: string[] = []
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break
    body.push(line.slice(indent + 2))
  }
  return body
    .join('\n')
    .replace(/\$\{\{\s*github\.ref_name\s*\}\}/g, TAG)
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, 'shogo-labs/shogo-ai')
    .replace(/\$\{\{\s*needs\.resolve-version\.outputs\.version\s*\}\}/g, TAG.replace(/^v/, ''))
}

function runPublisher(publisher: (typeof PUBLISHERS)[number], cwd: string) {
  const result = spawnSync('bash', ['-eo', 'pipefail', '-c', stepScript(publisher.file, publisher.name)], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...publisher.env,
      PATH: `${bin}:${process.env.PATH}`,
      GH_TOKEN: 'stub',
      STUB_DIR: join(cwd, 'stub'),
      RELEASE_NOTES_RETRY_DELAY: '0',
    },
  })
  return result
}

function expectEverythingLanded(final: string, order: string) {
  for (const publisher of PUBLISHERS) {
    expect({ order, marker: publisher.marker, count: occurrences(final, publisher.marker) }).toEqual({
      order,
      marker: publisher.marker,
      count: 1,
    })
    expect({ order, needle: publisher.needle, present: final.includes(publisher.needle) }).toEqual({
      order,
      needle: publisher.needle,
      present: true,
    })
    if (publisher.section) {
      expect(occurrences(final, `<!-- shogo:section ${publisher.section} -->`)).toBe(1)
    }
  }
  expect(final.trimStart().startsWith('## Download Shogo Desktop')).toBe(true)
  expect(final.indexOf('### Prebuilt agent-runtime binaries')).toBeGreaterThan(
    final.indexOf('## Download Shogo Desktop'),
  )
}

describe('a real tag: the four workflow blocks, executed as written', () => {
  const orders: string[][] = [
    ['publish-agent-runtime.yml', 'publish-shogo-worker.yml', 'runtime-multiarch.yml', 'desktop-release-macos.yml'],
    ['desktop-release-macos.yml', 'runtime-multiarch.yml', 'publish-agent-runtime.yml', 'publish-shogo-worker.yml'],
    ['publish-shogo-worker.yml', 'desktop-release-macos.yml', 'runtime-multiarch.yml', 'publish-agent-runtime.yml'],
    ['runtime-multiarch.yml', 'desktop-release-macos.yml', 'publish-shogo-worker.yml', 'publish-agent-runtime.yml'],
  ]

  for (const order of orders) {
    test(`order ${order.map((f) => f.replace(/\.yml$/, '')).join(' → ')}`, () => {
      const cwd = mkdtempSync(join(root, 'tag-'))
      mkdirSync(join(cwd, '.github/scripts'), { recursive: true })
      mkdirSync(join(cwd, 'stub'))
      writeFileSync(join(cwd, 'stub/body.md'), SHIPPED_V268)
      // The blocks are run from a copy of the repo root, so the relative
      // `.github/scripts/release-notes-section.sh` path they use still works
      // and the notes files they write do not touch the checkout.
      for (const f of readdirSync(join(REPO, '.github/scripts'))) {
        const src = join(REPO, '.github/scripts', f)
        try {
          writeFileSync(join(cwd, '.github/scripts', f), readFileSync(src))
          chmodSync(join(cwd, '.github/scripts', f), 0o755)
        } catch {}
      }

      for (const file of order) {
        const publisher = PUBLISHERS.find((p) => p.file === file)!
        const result = runPublisher(publisher, cwd)
        expect({ file, status: result.status, stderr: result.stderr }).toEqual({
          file,
          status: 0,
          stderr: result.stderr,
        })
      }

      expectEverythingLanded(readFileSync(join(cwd, 'stub/body.md'), 'utf8'), order.join(' → '))
    })
  }

  test('re-running every block on a finished tag changes nothing', () => {
    const cwd = mkdtempSync(join(root, 'rerun-'))
    mkdirSync(join(cwd, '.github/scripts'), { recursive: true })
    mkdirSync(join(cwd, 'stub'))
    writeFileSync(join(cwd, 'stub/body.md'), SHIPPED_V268)
    for (const f of readdirSync(join(REPO, '.github/scripts'))) {
      const src = join(REPO, '.github/scripts', f)
      try {
        writeFileSync(join(cwd, '.github/scripts', f), readFileSync(src))
        chmodSync(join(cwd, '.github/scripts', f), 0o755)
      } catch {}
    }
    for (const publisher of PUBLISHERS) {
      expect(runPublisher(publisher, cwd).status).toBe(0)
    }
    const once = readFileSync(join(cwd, 'stub/body.md'), 'utf8')
    for (const publisher of PUBLISHERS) {
      expect(runPublisher(publisher, cwd).status).toBe(0)
    }
    expect(readFileSync(join(cwd, 'stub/body.md'), 'utf8')).toBe(once)
    expectEverythingLanded(once, 'rerun')
  })
})
