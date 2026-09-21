// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, mock } from 'bun:test'

interface S3State {
  presignedUrl: string
  sendCalls: Array<any>
  sendThrow: Error | null
  bucketThrow: Error | null
}

const s3: S3State = {
  presignedUrl: 'https://artifacts.example.com/avatars/workspace-1.png?sig=abc',
  sendCalls: [],
  sendThrow: null,
  bucketThrow: null,
}

mock.module('../../lib/s3', () => ({
  getArtifactS3Client: () => ({
    send: async (cmd: any) => {
      s3.sendCalls.push(cmd)
      if (s3.sendThrow) throw s3.sendThrow
    },
  }),
  getArtifactBucket: () => {
    if (s3.bucketThrow) throw s3.bucketThrow
    return 'cloud-agent-artifacts'
  },
  buildArtifactKey: (folder: string, name: string) => `${folder}/${name}`,
  getArtifactPresignedReadUrl: async (_key: string, _opts: any) => s3.presignedUrl,
}))

mock.module('@aws-sdk/client-s3', () => ({
  PutObjectCommand: class PutObjectCommand {
    input: any
    constructor(input: any) {
      this.input = input
    }
  },
}))

const { saveAgentAvatar } = await import('../workspace-agent-cloud-storage')

describe('saveAgentAvatar (cloud storage)', () => {
  it('uploads to S3 and returns the presigned URL', async () => {
    const url = await saveAgentAvatar('workspace-1', Buffer.from([1, 2, 3]))
    expect(url).toBe(s3.presignedUrl)
    expect(s3.sendCalls.at(-1).input).toMatchObject({
      Bucket: 'cloud-agent-artifacts',
      Key: 'avatars/workspace-1.png',
      ContentType: 'image/png',
    })
  })

  // Regression test for the 2026-09-21 incident: a missing S3_ARTIFACT_BUCKET/
  // S3_SCHEMA_BUCKET env var made getArtifactBucket() throw on every call, and
  // this function used to swallow that into a base64 data: URI fallback. That
  // got persisted forever in workspace_agent_profiles.avatarUrl and resent as
  // chat context on every turn, single-handedly blowing a personal-agent
  // chat past the model's context window. Failures must now propagate so the
  // caller gets a normal error instead of a silent multi-MB context bomb.
  it('propagates the error instead of falling back to a base64 data URI', async () => {
    s3.bucketThrow = new Error('S3_ARTIFACT_BUCKET environment variable is required for S3 storage')
    try {
      await expect(saveAgentAvatar('workspace-1', Buffer.from([1, 2, 3]))).rejects.toThrow(
        'S3_ARTIFACT_BUCKET environment variable is required for S3 storage',
      )
    } finally {
      s3.bucketThrow = null
    }
  })

  it('propagates an S3 upload failure instead of falling back to a base64 data URI', async () => {
    s3.sendThrow = new Error('access denied')
    try {
      await expect(saveAgentAvatar('workspace-1', Buffer.from([1, 2, 3]))).rejects.toThrow('access denied')
    } finally {
      s3.sendThrow = null
    }
  })
})
