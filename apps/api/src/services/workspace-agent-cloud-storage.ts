// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { PutObjectCommand } from '@aws-sdk/client-s3'
import {
  buildArtifactKey,
  getArtifactBucket,
  getArtifactPresignedReadUrl,
  getArtifactS3Client,
} from '../lib/s3'

/**
 * Cloud-only avatar storage. This module must remain outside the local API
 * dependency graph; desktop avatars use the data-URL fallback in
 * workspace-agent.service.ts.
 */
export async function saveAgentAvatar(workspaceId: string, imageBuffer: Buffer): Promise<string> {
  try {
    const bucket = getArtifactBucket()
    const key = buildArtifactKey('avatars', `${workspaceId}.png`)
    await getArtifactS3Client().send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: imageBuffer,
      ContentType: 'image/png',
      CacheControl: 'max-age=3600',
    }))
    return await getArtifactPresignedReadUrl(key, { expiresIn: 86400 * 7 })
  } catch {
    return `data:image/png;base64,${imageBuffer.toString('base64')}`
  }
}
