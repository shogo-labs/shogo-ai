#!/usr/bin/env bun
/**
 * Boots a real Linux aarch64 guest VM and runs the platform-pkg /
 * bin-shim test suites *inside* the guest. This is the same VM image
 * the desktop's warm pool ships in production (`rootfs-provisioned.qcow2`),
 * so a pass here proves `resolveBinInvocation` behaves correctly under
 * Linux + the bundled aarch64 bun, not just on the macOS host.
 *
 * Flow:
 *   1. Convert rootfs.qcow2 -> rootfs.raw (Apple Virtualization needs raw)
 *      and use it as a writable overlay so the production image isn't
 *      mutated.
 *   2. Stage a Linux aarch64 `bun` and create node/npx/npm symlinks
 *      pointing at it (this mirrors how production builds /usr/local/bin
 *      inside the VM image — see scripts/build-vm-image/build-x86_64.ts).
 *   3. Boot the VM via the same Go helper the warm-pool uses, with two
 *      VirtioFS shares: `repo` (the monorepo) and `workspace` (a host
 *      temp dir we use as a bidirectional results channel).
 *   4. Cloud-init runs `bun test` on the two relevant test files and
 *      writes a structured JSON result + the full stdout to
 *      /mnt/workspace/test-result.json. We then poll the host side of
 *      that share and gate on the file.
 *   5. Shut the VM down.
 *
 * No network. No external services. The whole thing finishes in <60s
 * if the VM image cache is warm.
 */

import { spawn, execSync, type ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'

const DESKTOP_DIR = path.dirname(new URL(import.meta.url).pathname)
const REPO_ROOT = path.resolve(DESKTOP_DIR, '../..')
const VM_IMAGE_DIR = path.join(DESKTOP_DIR, 'resources', 'vm')
const GO_HELPER = path.join(DESKTOP_DIR, 'native', 'shogo-vm', 'shogo-vm-arm64')
const TEST_DIR = '/tmp/shogo-vm-bin-shim-test'
const WORKSPACE_DIR = path.join(TEST_DIR, 'workspace')
const BUNDLE_DIR = path.join(TEST_DIR, 'bundle')
const ROOTFS_RAW = path.join(TEST_DIR, 'rootfs.raw')

class TestJsonRpcClient {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private lineBuffer = ''

  constructor(private proc: ChildProcess) {
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString()
      const lines = this.lineBuffer.split('\n')
      this.lineBuffer = lines.pop()!
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const resp = JSON.parse(line)
          const p = this.pending.get(resp.id)
          if (p) {
            this.pending.delete(resp.id)
            if (resp.error) p.reject(new Error(resp.error))
            else p.resolve(resp.result)
          }
        } catch {}
      }
    })
  }

  async call(method: string, params: any, timeout = 30000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const msg = JSON.stringify({ id, method, params }) + '\n'
      this.proc.stdin!.write(msg)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`RPC timeout: ${method}`))
        }
      }, timeout)
    })
  }
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${msg}`)
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function main(): Promise<number> {
  console.log('\n=== VM bin-shim test (resolveBinInvocation in real guest) ===\n')

  // ---------------- Pre-checks ----------------
  if (!fs.existsSync(GO_HELPER)) throw new Error(`Go helper missing: ${GO_HELPER}`)
  for (const f of ['vmlinuz', 'initrd.img']) {
    const p = path.join(VM_IMAGE_DIR, f)
    if (!fs.existsSync(p)) throw new Error(`VM image missing: ${p}`)
  }
  log('VM artifacts present')

  // ---------------- Stage workspace + bundle ----------------
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true })
  fs.mkdirSync(BUNDLE_DIR, { recursive: true })

  const bunLinux = path.join(BUNDLE_DIR, 'bun')
  if (!fs.existsSync(bunLinux)) {
    log('Downloading Linux aarch64 bun...')
    execSync(
      `curl -fsSL -o /tmp/bun-linux.zip "https://github.com/oven-sh/bun/releases/download/bun-v1.3.5/bun-linux-aarch64.zip" && ` +
        `unzip -o /tmp/bun-linux.zip -d /tmp/bun-linux-extract && ` +
        `cp /tmp/bun-linux-extract/bun-linux-aarch64/bun "${bunLinux}" && chmod +x "${bunLinux}"`,
      { stdio: 'pipe' },
    )
  }
  for (const alias of ['node', 'npx', 'npm']) {
    const link = path.join(BUNDLE_DIR, alias)
    if (!fs.existsSync(link)) fs.symlinkSync('bun', link)
  }
  log(`Bundle staged: ${BUNDLE_DIR} (Linux aarch64 bun + node/npx/npm symlinks)`)

  // ---------------- Convert qcow2 -> raw (writable overlay) ----------------
  // Re-converts only if a stale overlay from a previous crashed run exists
  // and is unreadable; the raw image is large so we cache aggressively.
  if (!fs.existsSync(ROOTFS_RAW)) {
    const src = path.join(VM_IMAGE_DIR, 'rootfs-provisioned.qcow2')
    if (!fs.existsSync(src)) throw new Error(`Missing ${src}`)
    log('Converting qcow2 -> raw (one-time, ~10s)...')
    execSync(`qemu-img convert -f qcow2 -O raw "${src}" "${ROOTFS_RAW}"`, { stdio: 'pipe' })
  }
  log(`Root disk ready: ${ROOTFS_RAW}`)

  // ---------------- Build cloud-init seed ISO ----------------
  // Cloud-init drives the *entire* test:
  //   - mounts /mnt/repo  (virtiofs, ro)   <- monorepo source
  //   - mounts /mnt/workspace (virtiofs, rw) <- result channel
  //   - mounts /mnt/bundle (virtiofs, ro)  <- bundled bun + node/npx
  //   - installs the bundled bun into /usr/local/bin (mirroring production
  //     image layout — see scripts/build-vm-image/build-x86_64.ts)
  //   - runs `bun test` on the two relevant test files
  //   - writes a structured JSON result to /mnt/workspace/test-result.json
  //
  // Doing the install/run inside cloud-init avoids needing to keep an
  // interactive shell open or spin up a separate exec channel — the
  // host side just watches for the result file.
  const seedDir = path.join(TEST_DIR, 'seed-data')
  fs.rmSync(seedDir, { recursive: true, force: true })
  fs.mkdirSync(seedDir, { recursive: true })
  fs.writeFileSync(path.join(seedDir, 'meta-data'),
    `instance-id: bin-shim-test-${Date.now()}\nlocal-hostname: shogo-vm\n`)

  // Two test files we run inside the guest:
  //   - the 15 platform-pkg unit tests
  //   - the 4 bin-shim-no-node e2e tests
  const userData = `#cloud-config
users:
  - name: shogo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
runcmd:
  - set -ex
  - mkdir -p /mnt/repo /mnt/workspace /mnt/bundle
  - mount -t virtiofs repo /mnt/repo
  - mount -t virtiofs workspace /mnt/workspace
  - mount -t virtiofs bundle /mnt/bundle
  - echo "BOOT_OK $(uname -m) $(uname -r)" > /mnt/workspace/boot-marker.txt
  - cp /mnt/bundle/bun /usr/local/bin/bun
  - chmod 755 /usr/local/bin/bun
  - ln -sf /usr/local/bin/bun /usr/local/bin/node
  - ln -sf /usr/local/bin/bun /usr/local/bin/npx
  - ln -sf /usr/local/bin/bun /usr/local/bin/npm
  - node --version > /mnt/workspace/node-version.txt 2>&1 || true
  - which node bun >> /mnt/workspace/node-version.txt 2>&1 || true
  - |
    set +e
    cd /mnt/repo
    export PATH=/usr/local/bin:/usr/bin:/bin
    bun test \\
      packages/shared-runtime/src/__tests__/platform-pkg.test.ts \\
      packages/agent-runtime/src/__tests__/bin-shim-no-node.e2e.test.ts \\
      > /mnt/workspace/test-output.txt 2>&1
    EXIT=$?
    PASS=$(grep -cE "^\\(pass\\)" /mnt/workspace/test-output.txt || echo 0)
    FAIL=$(grep -cE "^\\(fail\\)" /mnt/workspace/test-output.txt || echo 0)
    UNAME=$(uname -srm)
    NODE_REAL=$(readlink -f $(which node) 2>/dev/null || echo "")
    printf '{"exit":%d,"pass":%d,"fail":%d,"uname":"%s","nodeReal":"%s"}\\n' \\
      "$EXIT" "$PASS" "$FAIL" "$UNAME" "$NODE_REAL" \\
      > /mnt/workspace/test-result.json
    sync
`
  fs.writeFileSync(path.join(seedDir, 'user-data'), userData)
  const seedISO = path.join(TEST_DIR, 'seed.iso')
  execSync(`hdiutil makehybrid -o "${seedISO}" "${seedDir}" -iso -joliet -default-volume-name cidata`,
    { stdio: 'pipe' })
  log('Cloud-init seed ISO created')

  // ---------------- Boot VM ----------------
  log('Spawning Go helper + booting VM...')
  const goProc = spawn(GO_HELPER, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const consoleLines: string[] = []
  goProc.stderr!.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter((l) => l.trim())
    consoleLines.push(...lines)
  })
  const rpc = new TestJsonRpcClient(goProc)

  let exitCode = 99
  try {
    await rpc.call(
      'start',
      {
        kernelPath: path.join(VM_IMAGE_DIR, 'vmlinuz'),
        initrdPath: path.join(VM_IMAGE_DIR, 'initrd.img'),
        rootDiskPath: ROOTFS_RAW,
        seedISOPath: seedISO,
        memoryMB: 4096,
        cpus: 4,
        shares: { workspace: WORKSPACE_DIR },
        readOnlyShares: { repo: REPO_ROOT, bundle: BUNDLE_DIR },
      },
      30000,
    )
    log('VM started')

    // ---------------- Wait for result file ----------------
    const resultPath = path.join(WORKSPACE_DIR, 'test-result.json')
    const bootMarker = path.join(WORKSPACE_DIR, 'boot-marker.txt')
    log('Waiting for cloud-init + tests to complete (up to 180s)...')
    let result: { exit: number; pass: number; fail: number; uname: string; nodeReal: string } | null = null
    for (let i = 0; i < 180; i++) {
      await sleep(1000)
      if (fs.existsSync(bootMarker) && i === 5) {
        const m = fs.readFileSync(bootMarker, 'utf-8').trim()
        log(`Guest booted: ${m}`)
      }
      if (fs.existsSync(resultPath)) {
        try {
          result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'))
          break
        } catch {
          // Mid-write, try again next tick.
        }
      }
    }

    if (!result) {
      console.log('\n--- Last 25 console lines from VM ---')
      for (const l of consoleLines.slice(-25)) console.log(`  ${l}`)
      const outPath = path.join(WORKSPACE_DIR, 'test-output.txt')
      if (fs.existsSync(outPath)) {
        console.log('\n--- Last 50 lines of test-output.txt ---')
        const lines = fs.readFileSync(outPath, 'utf-8').split('\n')
        for (const l of lines.slice(-50)) console.log(`  ${l}`)
      }
      throw new Error('Test result file never appeared')
    }

    // ---------------- Report ----------------
    console.log('')
    console.log(`  Guest:        ${result.uname}`)
    console.log(`  node ->       ${result.nodeReal}`)
    console.log(`  bun test:     exit=${result.exit} pass=${result.pass} fail=${result.fail}`)

    // Print full test output so the human reading this can see every
    // assertion ran.
    const outPath = path.join(WORKSPACE_DIR, 'test-output.txt')
    if (fs.existsSync(outPath)) {
      console.log('\n--- bun test output (inside guest) ---')
      console.log(fs.readFileSync(outPath, 'utf-8'))
    }

    if (result.exit === 0 && result.fail === 0) {
      console.log(`\nSUCCESS — ${result.pass} tests passed inside the Linux guest VM.`)
      exitCode = 0
    } else {
      console.log(`\nFAILED — ${result.fail} test(s) failed inside the guest (bun test exit ${result.exit}).`)
      exitCode = 1
    }
  } finally {
    try { await rpc.call('stop', {}, 10000) } catch {}
    try { goProc.kill() } catch {}
  }

  return exitCode
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('ERROR:', err)
  process.exit(2)
})
