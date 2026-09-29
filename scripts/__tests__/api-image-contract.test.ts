import { describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

type Pkg = { name: string; dir: string; deps: string[] }

function workspacePackages(): Map<string, Pkg> {
  const byName = new Map<string, Pkg>()
  for (const parent of ['apps', 'packages']) {
    for (const child of readdirSync(join(root, parent))) {
      const file = join(root, parent, child, 'package.json')
      if (!existsSync(file)) continue
      const json = JSON.parse(readFileSync(file, 'utf8'))
      const deps = Object.entries({ ...json.dependencies, ...json.peerDependencies })
        .filter(([, v]) => String(v).startsWith('workspace:'))
        .map(([k]) => k)
      byName.set(json.name, { name: json.name, dir: `${parent}/${child}`, deps })
    }
  }
  return byName
}

function closure(pkgs: Map<string, Pkg>, start: string): Pkg[] {
  const seen = new Map<string, Pkg>()
  const walk = (name: string) => {
    const pkg = pkgs.get(name)
    if (!pkg || seen.has(name)) return
    seen.set(name, pkg)
    pkg.deps.forEach(walk)
  }
  walk(start)
  return [...seen.values()]
}

const bunPin = (dockerfile: string) => {
  const src = read(dockerfile)
  return src.match(/bun-v(\d+\.\d+\.\d+)/)?.[1] ?? src.match(/oven\/bun:(\d+\.\d+\.\d+)/)?.[1] ?? null
}

describe('API image contract', () => {
  const dockerfile = read('apps/api/Dockerfile')

  it('ships every workspace package the API depends on (else it crashes at boot with Cannot find module)', () => {
    const pkgs = workspacePackages()
    const api = [...pkgs.values()].find((p) => p.dir === 'apps/api')!
    const missing = closure(pkgs, api.name)
      .filter((p) => p.dir !== 'apps/api' && !dockerfile.includes(`COPY --from=workspace /app/${p.dir} `))
      .map((p) => p.dir)
    expect(missing).toEqual([])
  })

  it('declares every workspace package apps/api imports (the closure above only follows declared deps)', () => {
    const pkgs = workspacePackages()
    const api = [...pkgs.values()].find((p) => p.dir === 'apps/api')!
    const imported = new Set<string>()
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') scan(full)
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          for (const m of readFileSync(full, 'utf8').matchAll(/from ['"](@shogo(?:-ai)?\/[a-z0-9-]+)/g)) imported.add(m[1])
        }
      }
    }
    scan(join(root, 'apps/api/src'))
    const undeclared = [...imported].filter((name) => pkgs.has(name) && !api.deps.includes(name))
    expect(undeclared).toEqual([])
  })

  it('installs git and fails the build if it is missing', () => {
    expect(dockerfile).toMatch(/apt-get install[^\n]*\n?[^\n]*\bgit\b/)
    expect(dockerfile).toContain('command -v git')
  })

  it('pins the same Bun as the images it is built from and deploys alongside', () => {
    const pins = Object.fromEntries(
      ['apps/api/Dockerfile', 'docker/workspace-deps/Dockerfile', 'packages/agent-runtime/Dockerfile.base'].map((f) => [
        f,
        bunPin(f),
      ]),
    )
    const api = pins['apps/api/Dockerfile']
    expect(api).not.toBeNull()
    expect(pins).toEqual(Object.fromEntries(Object.keys(pins).map((f) => [f, api])))
  })
})
