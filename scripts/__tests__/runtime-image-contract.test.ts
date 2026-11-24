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

describe('agent-runtime image contract', () => {
  const dockerfile = read('packages/agent-runtime/Dockerfile')
  const pkgs = workspacePackages()
  const runtime = [...pkgs.values()].find((p) => p.dir === 'packages/agent-runtime')!

  it('ships every workspace package agent-runtime depends on (else the gateway never starts: Cannot find package)', () => {
    const missing = closure(pkgs, runtime.name)
      .filter((p) => !dockerfile.includes(`COPY --from=workspace /app/${p.dir} `))
      .map((p) => p.dir)
    expect(missing).toEqual([])
  })

  it('declares every workspace package agent-runtime/src imports (the closure above only follows declared deps)', () => {
    const imported = new Set<string>()
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!['__tests__', 'node_modules', 'tech-stacks'].includes(entry.name)) scan(full)
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          for (const m of readFileSync(full, 'utf8').matchAll(/from ['"](@shogo(?:-ai)?\/[a-z0-9-]+)/g)) imported.add(m[1])
        }
      }
    }
    scan(join(root, 'packages/agent-runtime/src'))
    const undeclared = [...imported].filter((name) => pkgs.has(name) && name !== runtime.name && !runtime.deps.includes(name))
    expect(undeclared).toEqual([])
  })
})
