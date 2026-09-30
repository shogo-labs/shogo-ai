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
