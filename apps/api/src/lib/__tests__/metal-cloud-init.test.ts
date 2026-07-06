// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it } from 'bun:test'
import { buildBurstUserData, type BurstUserDataOpts } from '../metal-cloud-init'

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

  it('honours tunable overrides', () => {
    const s = buildBurstUserData({ ...BASE, poolSize: 12, memMiB: 8192, rootfsCow: 'reflink' })
    expect(s).toContain("METAL_POOL_SIZE='12'")
    expect(s).toContain("METAL_MEM_MIB='8192'")
    expect(s).toContain("METAL_ROOTFS_COW='reflink'")
  })
})
