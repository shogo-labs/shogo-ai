import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const script = resolve(import.meta.dir, '../metal-agent/build-runtime-rootfs.sh')
const source = readFileSync(script, 'utf8')

describe('build-runtime-rootfs.sh contract', () => {
  it('checks every boot-critical rootfs invariant', () => {
    expect(source).toContain('[ -x "$root/entrypoint.sh" ]')
    expect(source).toContain('[ -x "$root/usr/local/bin/bun" ]')
    expect(source).toContain('[ -x "$root/usr/bin/git" ]')
    expect(source).toContain('safe.directory = *')
    expect(source).toContain('ulimit -n 1048576')
    expect(source).toContain("printf '127.0.0.1\\tlocalhost")
    expect(source).toContain('> /etc/resolv.conf')
    expect(source).toContain('^exec /entrypoint.sh')
    expect(source).toContain("grep -q 'blkid -L shogo-ws'")
    expect(source).toContain('blkid missing')
  })

  it('mounts the workspace drive before handing off to the entrypoint', () => {
    const init = source.slice(source.indexOf('cat > "$MNT/usr/local/bin/fc-init" <<INIT'), source.indexOf('\nINIT\n'))
    const mountAt = init.indexOf('WS_DEV=\\$(blkid -L shogo-ws')
    expect(mountAt).toBeGreaterThan(-1)
    expect(mountAt).toBeLessThan(init.indexOf('exec /entrypoint.sh'))
    expect(init).toContain('mount --bind /data/workspace /app/workspace')
    for (const d of ['.bun/cache', '.npm', '.cache']) expect(init).toContain(d)
  })

  it('only exports SHOGO_SPOOL_DIR onto a drive it actually mounted', () => {
    // Export tarballs are gigabytes; spooling them onto /app (the 16 GiB rootfs
    // shared with node_modules) is how a guest hits ENOSPC and every later
    // backup fails (SHO-352). The env must therefore be set *inside* the
    // successful-mount branch, on the drive, and beside the workspace — never
    // inside it, where packProjectArchive would ship it to durable storage.
    const init = source.slice(source.indexOf('cat > "$MNT/usr/local/bin/fc-init" <<INIT'), source.indexOf('\nINIT\n'))
    const exportAt = init.indexOf('export SHOGO_SPOOL_DIR=/data/.shogo-spool')
    expect(exportAt).toBeGreaterThan(-1)
    expect(exportAt).toBeGreaterThan(init.indexOf('mount -t ext4 -o noatime'))
    expect(exportAt).toBeLessThan(init.indexOf('exec /entrypoint.sh'))
    // Inside the `then` branch of the mount check, before its `else`.
    const elseAt = init.indexOf('WARNING: workspace drive \\$WS_DEV failed to mount')
    expect(exportAt).toBeLessThan(elseAt)
    expect(init).toContain('mkdir -p /data/.shogo-spool')
    expect(init).not.toContain('/data/workspace/.shogo-spool')
    // The drive mount happens once; so does the export.
    expect(init.split('export SHOGO_SPOOL_DIR=').length - 1).toBe(1)
  })

  it('reports contract failures and treats the revision stamp as advisory', () => {
    expect(source).toContain('CONTRACT:')
    expect(source).toContain('WARNING: /etc/shogo-runtime-revision missing')
    expect(source).toContain('return "$bad"')
  })

  it('verifies the staged image before it is renamed over the live one', () => {
    const verifyAt = source.indexOf('verify_rootfs "$MNT"')
    expect(verifyAt).toBeGreaterThan(source.indexOf('chmod 0755 "$MNT/usr/local/bin/fc-init"'))
    expect(verifyAt).toBeLessThan(source.indexOf('mv -f "$STAGE" "$OUT"'))
  })
})
