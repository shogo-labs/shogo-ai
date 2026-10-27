// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage for `scripts/node-image-gc.sh` — the DaemonSet pass that reclaims
 * superseded Shogo image digests (SHO-233).
 *
 * The bug: every deploy pins a new `shogo-runtime` / `shogo-api` digest and
 * nothing removed the old ones, so a node accumulated ~10 GB per deploy. The
 * deploy gate fails at 80% and the kubelet's own image GC only starts at 85%,
 * so a node parked between them is reclaimed by nothing — staging node
 * 10.0.24.140 sat at 80.6% with 13 runtime + 12 api digests and blocked four
 * `Build, Test, and Deploy` runs.
 *
 * These tests run the real script (never a copy of its logic) against a stub
 * `crictl`/`df` on PATH, so what is asserted is what the DaemonSet executes.
 * The retention numbers come from the script's own defaults: if `KEEP_PER_REPO`
 * is ever changed to something that keeps everything, the "stale digests are
 * removed" cases fail — that is the mutation check AC2 asks for.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'node-image-gc.sh')
const SCRIPT_TEXT = readFileSync(SCRIPT, 'utf8')

const REGISTRY = 'us-ashburn-1.ocir.io/idin4oltblww'
const RUNTIME = 'shogo/shogo-runtime'
const API = 'shogo/shogo-api'
const POSTGRES = 'shogo/postgres'
const KNATIVE = 'gcr.io/knative-releases/knative.dev/serving/cmd/queue'

const WORK = mkdtempSync(join(tmpdir(), 'node-image-gc-'))
const BIN = join(WORK, 'bin')
const STORE = join(WORK, 'store')
const RMI_LOG = join(WORK, 'rmi.log')
const FAIL_IDS = join(WORK, 'fail-ids')

/** A stable 64-hex image id / digest for fixture entry `n`. */
function hexId(n: number): string {
  return n.toString(16).padStart(2, '0').repeat(32)
}

interface ImageOpts {
  pinned?: boolean
  /** Omit the store entry so the script has no age for this image. */
  unknownAge?: boolean
}

function image(repo: string, n: number, createdAt: string, opts: ImageOpts = {}) {
  const id = hexId(n)
  return {
    image: {
      id,
      repoTags: [],
      repoDigests: [`${REGISTRY}/${repo}@sha256:${id}`],
      size: '10000000000',
      username: '',
      pinned: opts.pinned ?? false,
    },
    store: opts.unknownAge ? null : { id, created: createdAt, names: [`${REGISTRY}/${repo}@sha256:${id}`] },
  }
}

function container(imageRef: string, imageId: string) {
  return {
    id: `c${imageId.slice(0, 10)}`,
    imageRef,
    imageId,
    state: 'CONTAINER_RUNNING',
  }
}

interface Fixture {
  images: any[]
  store: any[]
  containers: any[]
}

/**
 * 13 runtime + 12 api digests (the staging shape), 2 of them in use — one of
 * those being the OLDEST runtime digest, i.e. older than the newest 2 the
 * script keeps — plus unrelated images that must never be touched, one pinned
 * runtime digest, and one runtime digest with no age at all.
 */
function stagingShape(): Fixture {
  const images: any[] = []
  const store: any[] = []
  const containers: any[] = []
  const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour)).toISOString()

  for (let i = 0; i < 13; i++) {
    const { image: img, store: entry } = image(RUNTIME, i, at(i))
    images.push(img)
    if (entry) store.push(entry)
  }
  for (let i = 0; i < 12; i++) {
    const { image: img, store: entry } = image(API, 100 + i, at(i))
    images.push(img)
    if (entry) store.push(entry)
  }
  // Unrelated images: never candidates, whatever their age.
  const pg = image(POSTGRES, 200, at(0))
  const kn = image(KNATIVE, 201, at(0))
  images.push(pg.image, kn.image)
  store.push(pg.store!, kn.store!)
  // A pinned runtime digest older than the newest two: cri-o is told not to GC
  // it, so neither are we.
  const pinned = image(RUNTIME, 210, at(0), { pinned: true })
  images.push(pinned.image)
  store.push(pinned.store!)
  // A runtime digest with no age anywhere: cannot be shown to be older than
  // the ones we keep, so it stays.
  const ageless = image(RUNTIME, 211, at(0), { unknownAge: true })
  images.push(ageless.image)

  // In use: the oldest runtime digest and one api digest. Exited containers
  // count too, which is what `crictl ps -a` gives us.
  containers.push(container(`${REGISTRY}/${RUNTIME}@sha256:${hexId(0)}`, hexId(0)))
  containers.push(container(`${REGISTRY}/${API}@sha256:${hexId(105)}`, hexId(105)))
  return { images, store, containers }
}

function writeFixtures(fixture: Fixture) {
  writeFileSync(join(WORK, 'images.json'), JSON.stringify({ images: fixture.images }))
  writeFileSync(join(WORK, 'ps.json'), JSON.stringify({ containers: fixture.containers }))
  mkdirSync(STORE, { recursive: true })
  writeFileSync(join(STORE, 'images.json'), JSON.stringify(fixture.store))
}

interface RunResult {
  status: number
  stdout: string
  stderr: string
  removed: string[]
}

interface RunOpts {
  /** Used / available blocks for the stub `df`. 8100/1900 is 81%. */
  used?: number
  available?: number
  env?: Record<string, string>
}

function run(opts: RunOpts = {}): RunResult {
  const used = opts.used ?? 8100
  const available = opts.available ?? 1900
  const result = spawnSync('sh', [SCRIPT], {
    encoding: 'utf-8',
    env: {
      PATH: `${BIN}:${process.env.PATH ?? ''}`,
      FIX: WORK,
      IMAGE_STORE_DIR: STORE,
      IMAGE_DIR: '/',
      STATE_DIR: join(WORK, 'state'),
      ONESHOT: '1',
      DF_USED: String(used),
      DF_AVAIL: String(available),
      ...opts.env,
    },
  })
  const removed = readFileSync(RMI_LOG, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', removed }
}

beforeEach(() => {
  rmSync(BIN, { recursive: true, force: true })
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  writeFileSync(RMI_LOG, '')
  writeFileSync(FAIL_IDS, '')

  // Stub crictl: serves the fixtures, records every rmi, and fails the ids
  // listed in fail-ids the way cri-o fails an image a container still uses.
  writeFileSync(
    join(BIN, 'crictl'),
    `#!/bin/sh
if [ "\${1#--timeout=}" != "$1" ]; then shift; fi
case "$1" in
  images) cat "$FIX/images.json" ;;
  ps) cat "$FIX/ps.json" ;;
  rmi)
    echo "$2" >> "$FIX/rmi.log"
    case " $(cat "$FIX/fail-ids" 2>/dev/null) " in
      *" $2 "*) echo "rpc error: code = Unknown desc = image is in use by a container" >&2; exit 1 ;;
    esac
    exit 0 ;;
  *) echo "stub crictl: unexpected args: $*" >&2; exit 2 ;;
esac
`,
  )
  writeFileSync(
    join(BIN, 'df'),
    `#!/bin/sh
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/mapper/ocivolume-root 10000 %s %s 50%% /\\n' "$DF_USED" "$DF_AVAIL"
`,
  )
  chmodSync(join(BIN, 'crictl'), 0o755)
  chmodSync(join(BIN, 'df'), 0o755)
})

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true })
})

describe('node-image-gc — retention on a node shaped like staging 10.0.24.140', () => {
  const runtimeIds = new Set(Array.from({ length: 13 }, (_, i) => hexId(i)))
  const apiIds = new Set(Array.from({ length: 12 }, (_, i) => hexId(100 + i)))
  const countOf = (ids: string[], set: Set<string>) => ids.filter((id) => set.has(id)).length

  it('removes every Shogo digest except the in-use ones and the newest KEEP_PER_REPO per repo', () => {
    writeFixtures(stagingShape())
    const { status, removed, stdout } = run()

    expect(status).toBe(0)
    // 13 runtime - 1 in use - 2 newest kept = 10.
    expect(countOf(removed, runtimeIds)).toBe(10)
    // 12 api - 1 in use - 2 newest kept = 9.
    expect(countOf(removed, apiIds)).toBe(9)
    expect(removed.length).toBe(19)

    // The newest two of each repo survive, so a rollback stays warm and the
    // image a prepuller is pulling right now is never dropped.
    for (const keep of [hexId(12), hexId(11), hexId(111), hexId(110)]) {
      expect(removed).not.toContain(keep)
    }
    expect(stdout).toContain('removed=19')
  })

  it('keeps an in-use digest even when it is older than the newest KEEP_PER_REPO', () => {
    writeFixtures(stagingShape())
    const { removed } = run()
    // Oldest runtime digest and a mid api digest are held by containers.
    expect(removed).not.toContain(hexId(0))
    expect(removed).not.toContain(hexId(105))
  })

  it('never passes postgres, Knative or any other non-Shogo image to rmi', () => {
    writeFixtures(stagingShape())
    const { removed } = run()
    expect(removed).not.toContain(hexId(200))
    expect(removed).not.toContain(hexId(201))
    expect(removed).toHaveLength(new Set(removed).size)
    // Everything it did remove belongs to a Shogo repo it is allowed to touch.
    const fixture = stagingShape()
    const allowed = new Set(
      fixture.images
        .filter((i) => /\/shogo\/(shogo-runtime|agent-runtime|shogo-api|shogo-web|shogo-docs)@/.test(i.repoDigests[0]))
        .map((i) => i.id),
    )
    for (const id of removed) expect(allowed.has(id)).toBe(true)
  })

  it('never removes a pinned digest or one it has no age for', () => {
    writeFixtures(stagingShape())
    const { removed } = run()
    expect(removed).not.toContain(hexId(210)) // pinned by cri-o
    expect(removed).not.toContain(hexId(211)) // no created time anywhere
  })

  it('does nothing at all below RECLAIM_PCT', () => {
    writeFixtures(stagingShape())
    const { status, removed, stdout } = run({ used: 5000, available: 5000 })
    expect(status).toBe(0)
    expect(removed).toEqual([])
    expect(stdout).toContain('nothing to reclaim')
  })

  it('reclaims at exactly RECLAIM_PCT, not only above it', () => {
    writeFixtures(stagingShape())
    const { removed } = run({ used: 6500, available: 3500 })
    expect(removed.length).toBe(19)
  })

  it('keeps going when an rmi fails because the image came into use mid-pass', () => {
    const fixture = stagingShape()
    writeFixtures(fixture)
    const blocked = hexId(5)
    writeFileSync(FAIL_IDS, blocked)
    const { status, removed, stdout } = run()

    expect(status).toBe(0)
    expect(stdout).toContain(`skipped ${REGISTRY}/${RUNTIME} ${blocked}`)
    expect(stdout).toContain('removed=18')
    expect(stdout).toContain('skipped=1')
    // The failure is not retried in a loop, and the rest of the pass happened.
    expect(removed.filter((id) => id === blocked)).toHaveLength(1)
    expect(removed.length).toBe(19)
  })

  it('writes the pass marker the DaemonSet startupProbe waits for', () => {
    writeFixtures(stagingShape())
    run({ used: 1000, available: 9000 })
    expect(readFileSync(join(WORK, 'state', 'last-pass'), 'utf8')).toBe('')
  })
})

describe('node-image-gc — defaults are what the DaemonSet ships', () => {
  // Mutation check (AC2): these defaults are asserted from the script text AND
  // from its behaviour above. If KEEP_PER_REPO is ever set to a
  // keep-everything value, the "removes every Shogo digest except ..." case
  // stops removing anything and fails.
  it('reclaims at 65% and keeps the newest 2 per repo', () => {
    expect(SCRIPT_TEXT).toContain('RECLAIM_PCT="${RECLAIM_PCT:-65}"')
    expect(SCRIPT_TEXT).toContain('KEEP_PER_REPO="${KEEP_PER_REPO:-2}"')
  })

  it('sends every cri-o call through the long timeout (crictl defaults to 2s)', () => {
    // Verified on staging: a 2s crictl timeout cancels the rmi RPC of a 10 GB
    // image while cri-o keeps deleting server-side, so the pass reports
    // "skipped" for removals that actually happened.
    expect(SCRIPT_TEXT).toContain('CRICTL_TIMEOUT="${CRICTL_TIMEOUT:-10m}"')
    expect(SCRIPT_TEXT).toContain('--timeout="$CRICTL_TIMEOUT"')
  })

  it('is run by the DaemonSet from the same file the deploy applies', () => {
    const manifest = readFileSync(join(REPO_ROOT, 'k8s', 'base', 'node-image-gc.yaml'), 'utf8')
    expect(manifest).toContain('/run/shogo-node-image-gc/node-image-gc.sh')
    // The ConfigMap is created from scripts/node-image-gc.sh by the deploy
    // workflows, so the script has exactly one copy.
    for (const wf of ['.github/workflows/deploy-staging.yml', '.github/workflows/deploy.yml']) {
      const text = readFileSync(join(REPO_ROOT, wf), 'utf8')
      expect(text).toContain('--from-file=node-image-gc.sh=scripts/node-image-gc.sh')
      expect(text).toContain('kubectl apply -f k8s/base/node-image-gc.yaml')
    }
    // Staging + both production regions.
    const deploy = readFileSync(join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8')
    expect(deploy.split('--from-file=node-image-gc.sh=scripts/node-image-gc.sh')).toHaveLength(3)
  })
})

describe('node-image-gc — the deploy wiring that makes a script change actually run', () => {
  // A changed ConfigMap updates the mounted file, but the pod's `sh` already
  // parsed the old copy — so without a pod-template change the GC keeps
  // executing stale logic forever. That is the SHO-136 failure class one level
  // up, and QA caught it live on staging (pods still from 07:09 after a deploy
  // that reported "configmap unchanged / daemonset unchanged").
  const BLOCK_MARKER = '- name: Apply node image GC'

  function gcBlocks(): string[] {
    const blocks: string[] = []
    for (const wf of ['.github/workflows/deploy-staging.yml', '.github/workflows/deploy.yml']) {
      const lines = readFileSync(join(REPO_ROOT, wf), 'utf8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== BLOCK_MARKER) continue
        const rest = lines.slice(i + 1)
        const runIdx = rest.findIndex((l) => /^\s*run: \|/.test(l))
        if (runIdx === -1) continue
        const body: string[] = []
        for (const line of rest.slice(runIdx + 1)) {
          // `run: |` sits at 8 spaces; the shell body at 10. Stop at the next
          // step (or comment) that is not part of the body.
          if (line.trim() && !/^ {10}/.test(line)) break
          body.push(line)
        }
        blocks.push(body.join('\n'))
      }
    }
    return blocks
  }

  function fencedBlocks(doc: string): string[] {
    const out: string[] = []
    let current: string[] | null = null
    for (const line of doc.split('\n')) {
      if (line.trimStart().startsWith('```')) {
        if (current) {
          out.push(current.join('\n'))
          current = null
        } else {
          current = []
        }
        continue
      }
      current?.push(line)
    }
    return out
  }

  it('finds the GC step in staging and both production regions', () => {
    const blocks = gcBlocks()
    expect(blocks).toHaveLength(3)
    for (const block of blocks) expect(block).toContain('set -euo pipefail')
  })

  it('pins the script checksum on the pod template, after apply and before the rollout wait', () => {
    for (const block of gcBlocks()) {
      const applyConfigMap = block.indexOf('--from-file=node-image-gc.sh=scripts/node-image-gc.sh')
      const applyDs = block.indexOf('kubectl apply -f k8s/base/node-image-gc.yaml')
      const checksum = block.indexOf('checksum/script')
      const rollout = block.indexOf('rollout status daemonset/node-image-gc')

      expect(applyConfigMap).toBeGreaterThan(-1)
      expect(applyDs).toBeGreaterThan(applyConfigMap)
      expect(checksum).toBeGreaterThan(applyDs)
      expect(rollout).toBeGreaterThan(checksum)
      // The checksum has to be of the script the ConfigMap was built from.
      expect(block).toContain('sha256sum scripts/node-image-gc.sh')
    }
  })

  it('patches the pod template, not the DaemonSet metadata — only a template change rolls pods', () => {
    for (const block of gcBlocks()) {
      expect(block).toContain('patch daemonset/node-image-gc')
      expect(block).toContain('"template"')
      expect(block).toContain('"annotations"')
      // `kubectl annotate daemonset/...` updates the object, not the template,
      // and would leave every pod running the old script.
      expect(block).not.toContain('annotate --overwrite -n kube-system daemonset/node-image-gc')
    }
  })

  it('documents a hand-run path that exists: exec into the pod, not a host shell', () => {
    // The ConfigMap is mounted into the pod's view of the host root, so
    // /run/shogo-node-image-gc/ is EMPTY from a `kubectl debug node/...` shell
    // (verified on staging 10.0.29.201). No documented command may reach for
    // the script from a host shell.
    const docs = [
      'docs/runbooks/node-image-gc.md',
      'terraform/README.md',
      'scripts/node-image-gc.sh',
      'k8s/base/node-image-gc.yaml',
    ]
    for (const doc of docs) {
      for (const block of fencedBlocks(readFileSync(join(REPO_ROOT, doc), 'utf8'))) {
        if (!block.includes('kubectl debug node')) continue
        expect(block).not.toContain('node-image-gc.sh')
      }
    }

    const runbook = readFileSync(join(REPO_ROOT, 'docs/runbooks/node-image-gc.md'), 'utf8')
    expect(runbook).toContain('kubectl -n kube-system exec -it "$POD"')
    expect(runbook).toContain('--field-selector spec.nodeName=<node>')
  })

  it('points every remediation message at a doc that exists', () => {
    const gate = readFileSync(
      join(REPO_ROOT, '.github/scripts/check-node-disk-headroom.sh'),
      'utf8',
    )
    // The gate's failure text names a real section of terraform/README.md.
    expect(gate).toContain("terraform/README.md 'Node image store remediation'")
    const tfReadme = readFileSync(join(REPO_ROOT, 'terraform/README.md'), 'utf8')
    expect(tfReadme).toContain('## Node image store remediation')

    // The script's own messages name the runbook, which exists.
    expect(SCRIPT_TEXT).toContain('docs/runbooks/node-image-gc.md')
    expect(readFileSync(join(REPO_ROOT, 'docs/runbooks/node-image-gc.md'), 'utf8')).toContain(
      '# Node image GC — runbook',
    )
  })
})
