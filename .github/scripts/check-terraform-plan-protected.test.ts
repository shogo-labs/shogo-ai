// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for check-terraform-plan-protected.sh (SHO-515).
 *
 * The script is the CI gate that refuses a terraform plan which would REPLACE
 * or DELETE published DNS, Worker routes, PARs, buckets or the studio assets
 * bucket. Its success path runs on every PR that touches terraform/**, but the
 * FAILING path only runs when a plan actually contains a protected replacement
 * — which, on a healthy branch, is never. An unexercised guard is a guard that
 * silently stopped working, so these fixtures pin both directions.
 *
 * Run with:
 *   bun test .github/scripts/check-terraform-plan-protected.test.ts
 *
 * Fixtures are real `terraform show -json <plan>` shapes (format_version 1.2)
 * so the jq filter is exercised against the field layout terraform emits,
 * including `deposed` entries and `replace_paths`.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, 'check-terraform-plan-protected.sh')
const FIXTURES = resolve(import.meta.dir, 'fixtures')

function run(planJsonPath: string) {
  const result = spawnSync('bash', [SCRIPT, planJsonPath], { encoding: 'utf8' })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function fixture(name: string) {
  return join(FIXTURES, name)
}

describe('check-terraform-plan-protected.sh', () => {
  test('passes a plan whose protected resources only change in place', () => {
    const { status, output } = run(fixture('plan-clean.json'))
    expect(output).not.toContain('::error::')
    expect(output).toContain('No protected replacement')
    expect(status).toBe(0)
  })

  test('ignores deposed-object cleanup of a protected type', () => {
    // The clean fixture carries two deposed deletes (an IAM policy and the
    // published-apps PAR). Failing on those would block every future plan
    // because of drift that an earlier apply already resolved.
    const { output } = run(fixture('plan-clean.json'))
    expect(output).not.toContain('lifecycle_service_principal')
    expect(output).not.toContain('preauthrequest.published_apps')
  })

  test('fails a plan that replaces the wildcard DNS record', () => {
    const { status, output } = run(fixture('plan-protected-replace.json'))
    expect(status).toBe(1)
    expect(output).toContain('::error::')
    expect(output).toContain('module.publish_hosting.cloudflare_record.wildcard')
    expect(output).toContain('cloudflare_record')
  })

  test('fails a plan that replaces an object storage bucket', () => {
    const { status, output } = run(fixture('plan-protected-replace.json'))
    expect(status).toBe(1)
    expect(output).toContain('module.object_storage.oci_objectstorage_bucket.published_apps')
    expect(output).toContain('oci_objectstorage_bucket')
  })

  test('fails a plan that deletes a Worker route outright', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-plan-'))
    const path = join(dir, 'plan.json')
    writeFileSync(
      path,
      JSON.stringify({
        format_version: '1.2',
        resource_changes: [
          {
            address: 'module.publish_hosting.cloudflare_worker_route.custom_domains[0]',
            module_address: 'module.publish_hosting',
            mode: 'managed',
            type: 'cloudflare_worker_route',
            name: 'custom_domains',
            index: 0,
            change: {
              actions: ['delete'],
              before: { pattern: '*/*' },
              after: null,
              after_unknown: {},
            },
          },
        ],
      }),
    )

    const { status, output } = run(path)
    expect(status).toBe(1)
    expect(output).toContain('::error::')
    expect(output).toContain('cloudflare_worker_route.custom_domains[0]')
  })

  test('fails closed when the plan JSON is missing', () => {
    const { status, output } = run(join(tmpdir(), 'does-not-exist.json'))
    expect(status).toBe(1)
    expect(output).toContain('::error::')
  })

  test('fails closed when the plan JSON is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-plan-'))
    const path = join(dir, 'empty.json')
    writeFileSync(path, '')

    const { status, output } = run(path)
    expect(status).toBe(1)
    expect(output).toContain('::error::')
  })
})
