// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Coverage for `.github/scripts/render-image-prepuller.sh` — the deploy-time
 * renderer that adds a BOUNDED set of extra runtime prepulls (SHO-592 §2).
 *
 * Why a cap at all: prod has 29 distinct `shogo-runtime` tags across 131 ksvcs
 * but only 10 across the 14 always-on apps. At ~9 GB per tag, prepulling every
 * in-use tag is ~260 GB per node on a 189 GB boot disk — recreating the exact
 * incident. So: the deploy's own tag plus at most PREPULL_MAX_EXTRA more,
 * ranked by how many always-on apps use them.
 *
 * These tests run the real script against a fixture ksvc list (`KSVC_JSON_FILE`)
 * and parse the rendered YAML, so a wrong image list / cap / ordering fails
 * here rather than 26 minutes into a cold-node pull on prod.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const SCRIPT = join(REPO_ROOT, '.github', 'scripts', 'render-image-prepuller.sh')
const WORK = mkdtempSync(join(tmpdir(), 'render-prepuller-'))
const RUNTIME_IMAGE = 'us-ashburn-1.ocir.io/id/shogo/shogo-runtime:production-current'

interface KsvcOpts {
  image: string
  /** `autoscaling.knative.dev/min-scale`, or undefined for scale-to-zero. */
  minScale?: string
  /** Put the annotation on the ksvc metadata instead of the pod template. */
  metadataAnnotation?: boolean
}

function ksvc(opts: KsvcOpts) {
  const annotations = opts.minScale ? { 'autoscaling.knative.dev/min-scale': opts.minScale } : {}
  return {
    metadata: opts.metadataAnnotation ? { annotations } : {},
    spec: {
      template: {
        metadata: { annotations: opts.metadataAnnotation ? {} : annotations },
        spec: { containers: [{ image: opts.image }] },
      },
    },
  }
}

const rt = (tag: string) => `us-ashburn-1.ocir.io/id/shogo/shogo-runtime:${tag}`

/** The shape that matters: three tags with more than one always-on app. */
function fixture(items: ReturnType<typeof ksvc>[]) {
  return { items }
}

interface RenderResult {
  status: number
  yaml: string
  stderr: string
  extras: string[]
  containers: { name: string; image: string; command?: string[] }[]
  namespace: string
}

function render(
  ksvcs: unknown,
  env: Record<string, string> = {},
): RenderResult {
  const file = join(WORK, 'ksvcs.json')
  writeFileSync(file, JSON.stringify(ksvcs))
  const count = join(WORK, 'count.out')
  rmSync(count, { force: true })
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH ?? '',
      RUNTIME_IMAGE,
      NS_SYSTEM: 'shogo-production-system',
      KSVC_JSON_FILE: file,
      PREPULL_COUNT_OUT: count,
      ...env,
    },
  })
  const text = result.stdout ?? ''
  const doc = text ? (parseYaml(text) as any) : {}
  const containers = doc?.spec?.template?.spec?.containers ?? []
  return {
    status: result.status ?? -1,
    yaml: text,
    stderr: result.stderr ?? '',
    extras: containers.filter((c: any) => c.name.startsWith('runtime-prepull-extra')).map((c: any) => c.image),
    containers,
    namespace: doc?.metadata?.namespace ?? '',
  }
}

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true })
})

describe('render-image-prepuller — bounded, ranked extras', () => {
  it('renders the deploy image, namespace and an empty marker when nothing is always on', () => {
    const { status, containers, namespace, yaml } = render(
      fixture([
        ksvc({ image: rt('production-a'), minScale: '0' }),
        ksvc({ image: rt('production-b') }),
      ]),
    )
    expect(status).toBe(0)
    expect(namespace).toBe('shogo-production-system')
    expect(containers.map((c: any) => c.name)).toEqual(['runtime-prepull', 'postgres-prepull'])
    expect(containers[0].image).toBe(RUNTIME_IMAGE)
    // The placeholders must never survive into the applied manifest.
    expect(yaml).not.toContain('PREPULL_EXTRA_PLACEHOLDER')
    expect(yaml).not.toContain('RUNTIME_IMAGE_PLACEHOLDER')
    expect(yaml).not.toContain('shogo-staging-system')
  })

  it('ranks by number of always-on apps and pulls each with a sleep-infinity container', () => {
    const { extras, containers } = render(
      fixture([
        ksvc({ image: rt('production-busy'), minScale: '1' }),
        ksvc({ image: rt('production-busy'), minScale: '1' }),
        ksvc({ image: rt('production-busy'), minScale: '2' }),
        ksvc({ image: rt('production-solo'), minScale: '1' }),
      ]),
    )
    expect(extras).toEqual([rt('production-busy'), rt('production-solo')])
    for (const c of containers) {
      if (!c.name.startsWith('runtime-prepull-extra')) continue
      expect(c.command).toEqual(['sleep', 'infinity'])
    }
  })

  it('caps the extras at PREPULL_MAX_EXTRA and drops the rest', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((t) => ksvc({ image: rt(`production-${t}`), minScale: '1' }))
    const capped = render(fixture(items))
    expect(capped.extras).toHaveLength(3)
    // Deterministic: ties break on the image name, so a re-render of the same
    // cluster state does not churn every prepuller pod.
    expect(capped.extras).toEqual([rt('production-a'), rt('production-b'), rt('production-c')])

    const widened = render(fixture(items), { PREPULL_MAX_EXTRA: '5' })
    expect(widened.extras).toHaveLength(5)

    const off = render(fixture(items), { PREPULL_MAX_EXTRA: '0' })
    expect(off.extras).toHaveLength(0)
  })

  it('never duplicates the tag this deploy already pulls', () => {
    const { extras } = render(
      fixture([
        ksvc({ image: RUNTIME_IMAGE, minScale: '1' }),
        ksvc({ image: RUNTIME_IMAGE, minScale: '1' }),
        ksvc({ image: rt('production-other'), minScale: '1' }),
      ]),
    )
    expect(extras).toEqual([rt('production-other')])
  })

  it('only ever pulls shogo-runtime — never api/web/docs/postgres tags', () => {
    const reg = 'us-ashburn-1.ocir.io/id/'
    const { extras } = render(
      fixture([
        ksvc({ image: `${reg}shogo/shogo-api:production-1`, minScale: '1' }),
        ksvc({ image: `${reg}shogo/shogo-web:production-2`, minScale: '1' }),
        ksvc({ image: `${reg}shogo/shogo-docs:production-3`, minScale: '1' }),
        ksvc({ image: `${reg}shogo/agent-runtime:production-4`, minScale: '1' }),
        ksvc({ image: rt('production-rt'), minScale: '1' }),
      ]),
    )
    expect(extras).toEqual([rt('production-rt')])
  })

  it('honours min-scale on either the template or the ksvc metadata', () => {
    const { extras } = render(
      fixture([
        ksvc({ image: rt('production-template'), minScale: '1' }),
        ksvc({ image: rt('production-metadata'), minScale: '1', metadataAnnotation: true }),
      ]),
    )
    expect(extras.sort()).toEqual([rt('production-metadata'), rt('production-template')])
  })

  it('reports how many extras it rendered, so the gate can budget for them', () => {
    const { extras } = render(
      fixture([
        ksvc({ image: rt('production-a'), minScale: '1' }),
        ksvc({ image: rt('production-b'), minScale: '1' }),
      ]),
    )
    expect(extras).toHaveLength(2)
    expect(readFileSync(join(WORK, 'count.out'), 'utf8')).toBe('2')
  })

  it('renders a single-image manifest when there is no workspaces namespace', () => {
    const { status, extras, stderr } = render(
      fixture([ksvc({ image: rt('production-a'), minScale: '1' })]),
      { NS_WORKSPACES: '', KSVC_JSON_FILE: '' },
    )
    expect(status).toBe(0)
    expect(extras).toEqual([])
    expect(stderr).toContain('no extra runtime tags')
  })
})

describe('render-image-prepuller — wired into the deploy that actually runs', () => {
  it('apply-release-images.sh renders through it instead of a bare sed', () => {
    const apply = readFileSync(join(REPO_ROOT, '.github', 'scripts', 'apply-release-images.sh'), 'utf8')
    expect(apply).toContain('"$SCRIPTS/render-image-prepuller.sh" | kubectl apply -f -')
    expect(apply).not.toContain('"$REPO_ROOT/k8s/base/image-prepuller.yaml" | kubectl apply -f -')
    // The prepull gate gets a budget that accounts for the extra pulls it now
    // has to wait for (~6 min each on a cold node).
    expect(apply).toMatch(/wait-runtime-prepulled\.sh" "\$NS_SYSTEM" "\$\(\(1800 \+ 360 \* PREPULL_EXTRA\)\)"/)
  })

  it('the manifest carries the marker the renderer replaces', () => {
    const manifest = readFileSync(join(REPO_ROOT, 'k8s', 'base', 'image-prepuller.yaml'), 'utf8')
    expect(manifest).toContain('PREPULL_EXTRA_PLACEHOLDER')
    // Unrendered, it must stay a comment — applying the file by hand is documented.
    expect(manifest).toMatch(/^\s*# PREPULL_EXTRA_PLACEHOLDER$/m)
  })
})
