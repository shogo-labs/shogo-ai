// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The decision logic of a native release, with no Expo call and no database in
 * the way. Each case here is an acceptance criterion from SHO-323.
 */

import { describe, expect, it } from 'bun:test'
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'
import {
  buildTestWorkflowYaml,
  decideReleaseKind,
  OTA_UPDATES_SUPPORTED,
  storeResourceClass,
  validateRunnerJobDraft,
  assertRunnerJobDraft,
} from '../release.service'
import { NativeReleaseError } from '../client'
import {
  BUILD_PRICE_USD,
  billedUsd,
  buildPriceUsd,
  projectedReleaseRawUsd,
  updateMauRawUsd,
  NATIVE_UPDATE_INCLUDED_MAU,
} from '../usage.service'
import { verifyEasSignature } from '../webhook'
import { ASC_JWT_TTL_SECONDS, ascJwtLifetimeSeconds, createAscJwt } from '../signing.service'
import { MARKUP_MULTIPLIER } from '../../../lib/usage-cost'

describe('the runner cannot widen its own job', () => {
  it('rejects a top-level secret', () => {
    const violations = validateRunnerJobDraft({ platform: 'ios', secrets: { buildCredentials: [] } })
    expect(violations.map((v) => v.path)).toEqual(['secrets'])
  })

  it('rejects a nested escape, not just the root', () => {
    const violations = validateRunnerJobDraft({
      platform: 'ios',
      builderEnvironment: { image: 'evil/image:latest', secrets: {} },
    })
    expect(violations.map((v) => v.path).sort()).toEqual([
      'builderEnvironment',
      'builderEnvironment.secrets',
    ])
  })

  it('rejects a class or token role the meter and the account own', () => {
    const paths = validateRunnerJobDraft({ resourceClass: 'LINUX_LARGE', expoTokenRole: 'ADMIN' }).map(
      (v) => v.path,
    )
    expect(paths.sort()).toEqual(['expoTokenRole', 'resourceClass'])
  })

  it('accepts a draft that stays in its lane', () => {
    expect(
      validateRunnerJobDraft({
        platform: 'ios',
        projectRootDirectory: 'apps/mobile',
        appVersion: '1.2.0',
        env: { EXPO_PUBLIC_API_URL: 'https://example.test' },
      }),
    ).toEqual([])
  })

  it('throws the API error a route can serialise', () => {
    expect(() => assertRunnerJobDraft({ username: 'root' })).toThrow(NativeReleaseError)
  })
})

describe('build vs update', () => {
  it('builds when there is no previous store build', () => {
    expect(decideReleaseKind({ previousFingerprint: null, fingerprint: 'abc', hasStoreBuild: false })).toBe(
      'build',
    )
  })

  it('updates when the fingerprint is unchanged, once OTA can deliver it', () => {
    expect(
      decideReleaseKind({ previousFingerprint: 'abc', fingerprint: 'abc', hasStoreBuild: true, otaAvailable: true }),
    ).toBe('update')
  })

  it('falls back to a store build when OTA is not available, rather than claiming an update shipped', () => {
    // The update path (expo export + asset upload + manifest) is not implemented
    // yet, so an unchanged fingerprint must still produce a build: reporting an OTA
    // update would tell the user their change shipped when nothing left the pod.
    expect(
      decideReleaseKind({ previousFingerprint: 'abc', fingerprint: 'abc', hasStoreBuild: true, otaAvailable: false }),
    ).toBe('build')
    // …and that is the default this deployment ships with.
    expect(decideReleaseKind({ previousFingerprint: 'abc', fingerprint: 'abc', hasStoreBuild: true })).toBe('build')
    expect(OTA_UPDATES_SUPPORTED).toBe(false)
  })

  it('builds when the native side changed', () => {
    expect(decideReleaseKind({ previousFingerprint: 'abc', fingerprint: 'def', hasStoreBuild: true })).toBe(
      'build',
    )
  })
})

describe('pricing', () => {
  it('prices only the rows Expo publishes', () => {
    expect(BUILD_PRICE_USD.IOS_MEDIUM).toBe(2)
    expect(BUILD_PRICE_USD.IOS_LARGE).toBe(4)
    expect(BUILD_PRICE_USD.ANDROID_MEDIUM).toBe(1)
    expect(BUILD_PRICE_USD.ANDROID_LARGE).toBe(2)
  })

  it('never invents a price for an unpublished class', () => {
    for (const cls of ['IOS_M_MEDIUM', 'IOS_M_LARGE', 'IOS_DEFAULT', 'ANDROID_DEFAULT', 'LINUX_LARGE', 'LEGACY']) {
      expect(buildPriceUsd(cls)).toBeNull()
    }
    expect(buildPriceUsd(null)).toBeNull()
  })

  it('bills raw × MARKUP_MULTIPLIER, round6', () => {
    expect(MARKUP_MULTIPLIER).toBe(1.2)
    expect(billedUsd(2)).toBe(2.4)
    expect(billedUsd(0.05)).toBe(0.06)
    expect(billedUsd(1 / 3)).toBe(0.4)
  })

  it('projects a release from the classes we intend to request', () => {
    const raw = projectedReleaseRawUsd({
      builds: [
        { platform: 'ios', resourceClass: 'IOS_MEDIUM' },
        { platform: 'android', resourceClass: 'ANDROID_MEDIUM' },
      ],
      hasTests: false,
    })
    expect(raw).toBe(3)
  })

  it('asks for a class it can price, on both platforms', () => {
    expect(buildPriceUsd(storeResourceClass('ios'))).toBe(2)
    expect(buildPriceUsd(storeResourceClass('android'))).toBe(1)
  })

  it('includes the test stage in the projection because it is charged too', () => {
    const withTests = projectedReleaseRawUsd({
      builds: [{ platform: 'ios', resourceClass: 'IOS_MEDIUM' }],
      hasTests: true,
      testCiMinutes: 10,
    })
    expect(withTests).toBeGreaterThan(2)
  })

  it('charges Updates MAU only above the included allowance', () => {
    expect(updateMauRawUsd(NATIVE_UPDATE_INCLUDED_MAU)).toBe(0)
    expect(updateMauRawUsd(NATIVE_UPDATE_INCLUDED_MAU + 2_000)).toBe(10)
    expect(updateMauRawUsd(0)).toBe(0)
  })
})

describe('the EAS webhook signature', () => {
  const secret = 'a'.repeat(32)
  const body = JSON.stringify({
    id: '147a3212-49fd-446f-b4e3-a6519acf264a',
    status: 'finished',
    artifacts: { buildUrl: 'https://expo.dev/artifacts/eas/abc.ipa' },
  })
  // HMAC-SHA1 of the body above with a 32×`a` secret, computed independently of
  // the implementation so a change to either side shows up here.
  const digest = 'd89e42fc3c5b5fff27c57fa80557481284a48e48'

  it('accepts a bare hex digest', () => {
    expect(verifyEasSignature(body, digest, secret)).toBe(true)
  })

  it('accepts the sha1= prefix', () => {
    expect(verifyEasSignature(body, `sha1=${digest}`, secret)).toBe(true)
  })

  it('rejects a body that changed', () => {
    expect(verifyEasSignature(`${body} `, digest, secret)).toBe(false)
  })

  it('rejects a missing signature or secret rather than allowing the request', () => {
    expect(verifyEasSignature(body, undefined, secret)).toBe(false)
    expect(verifyEasSignature(body, digest, '')).toBe(false)
  })
})

describe('the App Store Connect JWT avoids the 1200 s bug', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const key = {
    keyP8: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'KEYID12345',
    issuerId: '69a6de70-0000-0000-0000-000000000000',
    teamId: 'TEAM123456',
  }

  it('lives under Apple hard maximum, with margin', () => {
    const token = createAscJwt(key, { now: 1_700_000_000_000 })
    expect(ascJwtLifetimeSeconds(token)).toBe(ASC_JWT_TTL_SECONDS)
    expect(ASC_JWT_TTL_SECONDS).toBeLessThan(1200)
  })

  it('caps a caller that asks for longer, because that is the whole bug', () => {
    const token = createAscJwt(key, { ttlSeconds: 3600 })
    expect(ascJwtLifetimeSeconds(token)).toBe(ASC_JWT_TTL_SECONDS)
  })

  it('signs ES256 over the right header and claims', () => {
    const token = createAscJwt(key, { now: 1_700_000_000_000 })
    const [header, claims, signature] = token.split('.')
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    const decodedClaims = JSON.parse(Buffer.from(claims, 'base64').toString('utf8'))
    expect(decodedHeader).toEqual({ alg: 'ES256', kid: key.keyId, typ: 'JWT' })
    expect(decodedClaims.iss).toBe(key.issuerId)
    expect(decodedClaims.aud).toBe('appstoreconnect-v1')
    expect(decodedClaims.exp - decodedClaims.iat).toBeLessThan(1200)
    // P1363 (raw r||s) is 64 bytes for P-256; a DER signature would be ~70 and
    // Apple answers 401 to it.
    expect(Buffer.from(signature, 'base64').length).toBe(64)
  })

  it('does not depend on eas-cli or apple-utils to sign', () => {
    const token = createAscJwt(key)
    const verify = createVerify('SHA256')
    verify.update(token.split('.').slice(0, 2).join('.'))
    verify.end()
    expect(
      verify.verify(
        { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' },
        Buffer.from(token.split('.')[2], 'base64'),
      ),
    ).toBe(true)
  })
})

describe('the generated test workflow', () => {
  it('gives each platform its own Maestro job, naming the build it tests', () => {
    const yaml = buildTestWorkflowYaml({ platforms: ['ios', 'android'] })
    expect(yaml).toContain('type: build')
    expect(yaml).toContain('type: maestro')
    // One maestro job per platform: a job takes a single `build_id`, so a shared
    // job could only ever test one of the two builds, and `needs.*.outputs` is
    // not a documented selector.
    expect(yaml).toContain('maestro_ios:')
    expect(yaml).toContain('maestro_android:')
    expect(yaml).toContain('needs: ["build_test_ios"]')
    expect(yaml).toContain('needs: ["build_test_android"]')
    expect(yaml).toContain('build_id: ${{ needs.build_test_ios.outputs.build_id }}')
    expect(yaml).toContain('build_id: ${{ needs.build_test_android.outputs.build_id }}')
    expect(yaml).not.toContain('needs.*')
    expect(yaml).toContain('profile: shogo-test')
  })

  it('is only the platforms the release asked for', () => {
    const yaml = buildTestWorkflowYaml({ platforms: ['ios'] })
    expect(yaml).toContain('build_test_ios')
    expect(yaml).not.toContain('build_test_android')
    expect(yaml).toContain('maestro_ios:')
    expect(yaml).not.toContain('maestro_android:')
  })
})
