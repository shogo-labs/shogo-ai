// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Guard for the SHO-173 ingress hardening (the second half of #1062).
 *
 * On 2026-10-22 12:05Z a distributed scanner sent 13k-41k req/min at dead
 * `preview--<uuid>.shogo.ai` hosts. prod-US served all of it through a single
 * `3scale-kourier-gateway` pod whose liveness probe (`/ready`,
 * `timeoutSeconds: 1`) stopped answering under the load, so kubelet SIGKILLed
 * it six times and the region 502'd for ~10 minutes. #1062 had been written a
 * month earlier and never applied; the *code* was fine and nobody noticed it
 * had drifted out of the cluster.
 *
 * This test cannot prove the values reached the cluster (that is the targeted
 * apply + the runbook's post-apply check). It guards the other half: that the
 * hardening cannot be quietly deleted or edited back down to the upstream
 * sizing — the way it was for a month — without a required check going red.
 *
 * Text-parsed on purpose, same approach as `deploy-secret-parity.test.ts`: no
 * HCL or YAML parser, so a rename in a module does not turn this into a
 * false-green.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const KNATIVE = 'terraform/modules/knative-oci/main.tf'
const EDGE = 'terraform/environments/edge-global/main.tf'
const ALERT = 'terraform/modules/signoz/alerts/kourier-gateway-restarts.yaml'
const APPLY_ALERTS = 'scripts/signoz-apply-alerts.ts'

/**
 * Body of `resource "<type>" "<name>" {` up to the first closing brace in
 * column 0. Terraform fmt guarantees that closing brace, and every block this
 * test reads is top-level.
 */
export function topLevelBlock(source: string, header: string): string {
  const start = source.indexOf(header)
  if (start === -1) return ''
  const end = source.indexOf('\n}\n', start)
  return end === -1 ? source.slice(start) : source.slice(start, end)
}

/** The `default = ...` literal of one `variable "name"` block. */
export function variableDefault(source: string, name: string): string | undefined {
  const block = topLevelBlock(source, `variable "${name}" {`)
  return block.match(/^\s*default\s*=\s*(.+)$/m)?.[1].trim()
}

describe('kourier gateway capacity (terraform/modules/knative-oci)', () => {
  const source = read(KNATIVE)
  const resource = topLevelBlock(source, 'resource "null_resource" "kourier_gateway_capacity"')

  it('keeps the CPU sizing that a flooded Envoy needs for its own probe', () => {
    expect(variableDefault(source, 'kourier_gateway_cpu_request')).toBe('"500m"')
    expect(variableDefault(source, 'kourier_gateway_cpu_limit')).toBe('"2"')
  })

  it('keeps the memory floor and replica floor that stop the OOM/one-pod outage', () => {
    expect(variableDefault(source, 'kourier_gateway_memory_request')).toBe('"512Mi"')
    expect(variableDefault(source, 'kourier_gateway_memory_limit')).toBe('"2Gi"')
    expect(variableDefault(source, 'kourier_gateway_min_replicas')).toBe('2')
  })

  it('keeps a liveness deadline a busy-but-alive Envoy can meet', () => {
    expect(variableDefault(source, 'kourier_gateway_liveness_timeout_seconds')).toBe('5')
    expect(variableDefault(source, 'kourier_gateway_liveness_failure_threshold')).toBe('6')
  })

  it('feeds every tuned value into the patch from its variable, never a literal', () => {
    // A literal here is how the sizing drifts away from the variables above.
    expect(resource).toContain('"cpu":"${var.kourier_gateway_cpu_request}"')
    expect(resource).toContain('"cpu":"${var.kourier_gateway_cpu_limit}"')
    expect(resource).toContain('"memory":"${var.kourier_gateway_memory_request}"')
    expect(resource).toContain('"memory":"${var.kourier_gateway_memory_limit}"')
    expect(resource).toContain('"timeoutSeconds":${var.kourier_gateway_liveness_timeout_seconds}')
    expect(resource).toContain('"failureThreshold":${var.kourier_gateway_liveness_failure_threshold}')
  })

  it('re-runs the local-exec when any tuned value changes', () => {
    const triggers = resource.slice(0, resource.indexOf('provisioner'))
    for (const key of [
      'cluster_id',
      'min_replicas',
      'cpu_request',
      'cpu_limit',
      'memory_request',
      'memory_limit',
      'liveness_timeout_seconds',
      'liveness_failure_threshold',
    ]) {
      expect(triggers).toContain(`${key} `)
    }
  })

  it('spreads replicas across nodes by scheduling rule, not by luck', () => {
    expect(resource).toContain('podAntiAffinity')
    expect(resource).toContain('preferredDuringSchedulingIgnoredDuringExecution')
    expect(resource).toContain('"topologyKey":"kubernetes.io/hostname"')
    // Selector must match the gateway's own pod label (`app: 3scale-kourier-gateway`),
    // otherwise the rule spreads nothing.
    expect(resource).toContain('"matchLabels":{"app":"3scale-kourier-gateway"}')
  })

  it('applies sizing, probe and spread in one strategic patch', () => {
    expect(resource).toContain('--type strategic')
    expect(resource).toContain('"name":"kourier-gateway"')
    // `set resources` would drop the probe/spread edits on the next run.
    expect(resource).not.toContain('kubectl set resources deployment/3scale-kourier-gateway')
  })

  it('keeps the PDB that stops a node drain from taking the last pod', () => {
    expect(resource).toContain('kind: PodDisruptionBudget')
    expect(resource).toContain('maxUnavailable: 1')
  })

  it('leaves readiness able to pull a wedged pod out of rotation', () => {
    // The patch must not touch readinessProbe: readiness gates traffic, so the
    // probe relaxation stays on liveness only.
    expect(resource).not.toContain('readinessProbe')
  })
})

describe('edge block for the retired preview--<id> host scheme', () => {
  const source = read(EDGE)
  const ruleset = topLevelBlock(source, 'resource "cloudflare_ruleset" "worker_m2m_bot_skip"')

  it('owns the zone custom-ruleset phase Cloudflare allows only once', () => {
    expect(ruleset).toContain('phase       = "http_request_firewall_custom"')
  })

  it('blocks hostnames that start with preview--', () => {
    expect(ruleset).toMatch(/expression\s*=\s*"starts_with\(http\.host, \\"preview--\\"\)"/)
    expect(ruleset).toMatch(/ref\s*=\s*"block_retired_preview_hosts"[\s\S]*?action\s*=\s*"block"/)
  })

  it('evaluates the block before the M2M bot-mitigation skip', () => {
    expect(ruleset.indexOf('block_retired_preview_hosts')).toBeGreaterThan(-1)
    expect(ruleset.indexOf('block_retired_preview_hosts')).toBeLessThan(
      ruleset.indexOf('skip_bot_mitigation_m2m_api')
    )
  })
})

describe('KourierGatewayRestarts alert', () => {
  const yaml = read(ALERT)

  it('pages on the k8s_cluster restarts gauge, excluding staging', () => {
    expect(yaml).toContain('alert: KourierGatewayRestarts')
    expect(yaml).toContain('metricName: k8s.container.restarts')
    expect(yaml).toContain("k8s.container.name = 'kourier-gateway'")
    expect(yaml).toContain("k8s.cluster.name != 'shogo-staging'")
    expect(yaml).toContain('channels: [platform-oncall]')
  })

  it('alerts on the delta across the window, not the lifetime counter', () => {
    // max - min over the eval window is "restarts in the last 10 minutes"; an
    // absolute threshold on the counter would fire forever on a healthy pod.
    expect(yaml).toContain('expression: A - B')
    expect(yaml).toMatch(/timeAggregation: max[\s\S]*?timeAggregation: min/)
    expect(yaml).toMatch(/op: above\s*\n\s*matchType: on_average\s*\n\s*target: 2/)
  })

  it('is discoverable by the alert sync script', () => {
    // The script globs `terraform/modules/signoz/alerts/*.yaml` and matches
    // `--only` against the filename.
    const script = read(APPLY_ALERTS)
    expect(script).toContain('"terraform", "modules", "signoz", "alerts"')
    expect(script).toContain('.endsWith(".yaml")')
    expect(ALERT.endsWith('.yaml')).toBe(true)
    expect(ALERT).toContain('kourier-gateway-restarts')
  })
})
