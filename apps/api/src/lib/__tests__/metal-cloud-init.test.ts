// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { buildBurstUserData, DEFAULT_IDLE_SUSPEND_MS, type BurstUserDataOpts } from '../metal-cloud-init'

const BASE: BurstUserDataOpts = {
  hostId: 'shogo-fc-burst-eu-20260706',
  region: 'eu',
  controlPlaneUrl: 'https://api.example/',
  registerToken: 'tok-secret',
  fwdAllowCidr: '157.151.142.64/32',
  s3Endpoint: 'https://ns.compat.objectstorage.eu-frankfurt-1.oraclecloud.com',
  s3Region: 'eu-frankfurt-1',
  s3Bucket: 'shogo-workspaces-eu',
  s3Prefix: 'metal-snapshots/',
  s3AccessKeyId: 'AKID',
  s3SecretAccessKey: 'SEKRET',
  ocirDockerConfigB64: 'eyJhdXRocyI6e319',
  runtimeImage: 'us-ashburn-1.ocir.io/ns/shogo/shogo-runtime:staging-multiarch-latest',
  bundleUrl: 'https://objectstorage.example/p/abc/n/ns/b/bucket/o/metal-fleet/v1/metal-fleet-bundle.tgz',
}

describe('buildBurstUserData', () => {
  it('is a bash script that writes env, fetches the bundle, and runs the orchestrator', () => {
    const s = buildBurstUserData(BASE)
    expect(s.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(s).toContain('/etc/metal-agent.env')
    expect(s).toContain(BASE.bundleUrl)
    expect(s).toContain('provision-burst-host.sh')
  })

  it('embeds the per-host identity + shared secrets', () => {
    const s = buildBurstUserData(BASE)
    expect(s).toContain("METAL_HOST_ID='shogo-fc-burst-eu-20260706'")
    expect(s).toContain("METAL_REGION='eu'")
    expect(s).toContain("METAL_CONTROL_PLANE_URL='https://api.example/'")
    expect(s).toContain("METAL_REGISTER_TOKEN='tok-secret'")
    expect(s).toContain("METAL_FWD_ALLOW_CIDR='157.151.142.64/32'")
  })

  it('points the durable store at the region S3 bucket/endpoint (data residency)', () => {
    const s = buildBurstUserData(BASE)
    expect(s).toContain("METAL_SNAP_BUCKET='shogo-workspaces-eu'")
    expect(s).toContain("S3_ENDPOINT='https://ns.compat.objectstorage.eu-frankfurt-1.oraclecloud.com'")
    expect(s).toContain("S3_REGION='eu-frankfurt-1'")
    expect(s).toContain("AWS_ACCESS_KEY_ID='AKID'")
  })

  it('detects the public IP at boot for the dial-back address', () => {
    const s = buildBurstUserData(BASE)
    expect(s).toContain('METAL_MESH_IP=')
    expect(s).toContain('METAL_PUBLIC_HOST=')
    expect(s).toMatch(/ipify\.org|ifconfig\.me/)
  })

  it('carries the OCIR pull config + runtime image for the on-box rootfs build', () => {
    const s = buildBurstUserData(BASE)
    expect(s).toContain(BASE.ocirDockerConfigB64)
    expect(s).toContain(`RUNTIME_IMAGE='${BASE.runtimeImage}'`)
  })

  it('persists RUNTIME_IMAGE + DOCKER_CONFIG into the agent env so self-update can rebuild the rootfs', () => {
    const s = buildBurstUserData(BASE)
    // These live in the METAL_ENV_EOF heredoc that becomes /etc/metal-agent.env,
    // which the metal-agent process (and thus self-update's rebuildRootfs child)
    // inherits. Without them a rebuildRootfs release silently no-ops.
    const envBlock = s.slice(s.indexOf('METAL_ENV_EOF'), s.lastIndexOf('METAL_ENV_EOF'))
    expect(envBlock).toContain(`RUNTIME_IMAGE='${BASE.runtimeImage}'`)
    expect(envBlock).toContain("DOCKER_CONFIG='/root/.docker-ocir'")
  })

  it('honours tunable overrides', () => {
    const s = buildBurstUserData({ ...BASE, poolSize: 12, memMiB: 8192, rootfsCow: 'reflink' })
    expect(s).toContain("METAL_POOL_SIZE='12'")
    expect(s).toContain("METAL_MEM_MIB='8192'")
    expect(s).toContain("METAL_ROOTFS_COW='reflink'")
  })

  it('defaults the idle-suspend window to 30 minutes (avoids suspend/resume churn)', () => {
    expect(DEFAULT_IDLE_SUSPEND_MS).toBe(30 * 60 * 1000)
    const s = buildBurstUserData(BASE)
    expect(s).toContain("METAL_IDLE_SUSPEND_MS='1800000'")
  })

  it('honours an explicit idleSuspendMs override', () => {
    const s = buildBurstUserData({ ...BASE, idleSuspendMs: 60_000 })
    expect(s).toContain("METAL_IDLE_SUSPEND_MS='60000'")
  })

  it('injects the SigNoz endpoint + key for the host log shipper when provided', () => {
    const s = buildBurstUserData({
      ...BASE,
      signozEndpoint: 'https://ingest.us.signoz.cloud:443',
      signozIngestionKey: 'sk-signoz-123',
    })
    expect(s).toContain("OTEL_EXPORTER_OTLP_ENDPOINT='https://ingest.us.signoz.cloud:443'")
    expect(s).toContain("SIGNOZ_INGESTION_KEY='sk-signoz-123'")
  })

  it('omits the SigNoz env entirely when not configured (collector stays stopped)', () => {
    const s = buildBurstUserData(BASE)
    expect(s).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT')
    expect(s).not.toContain('SIGNOZ_INGESTION_KEY')
  })
})
