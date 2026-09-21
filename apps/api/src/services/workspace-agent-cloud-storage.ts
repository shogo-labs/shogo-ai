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
 *
 * Deliberately does NOT swallow S3 failures into a base64 data: URI fallback
 * (unlike routes/thumbnail.ts's saveThumbnail, which has that fallback plus a
 * `rewriteInlineThumbnails` step that swaps the inline data back out for a
 * real URL on the next list fetch). The agent profile has no equivalent
 * rewrite step: a data: URI written here gets persisted forever in
 * workspace_agent_profiles.avatarUrl AND echoed back as this tool call's
 * result, so it stays in that chat's message history and gets resent as
 * context on every future turn. A single ~1.2MB avatar image silently
 * embedded this way is what pushed a personal-agent chat past the model's
 * 1,048,576-token context limit on 2026-09-21 (root cause was a missing
 * S3_ARTIFACT_BUCKET/S3_SCHEMA_BUCKET env var making every call here throw —
 * see the k8s overlay fix alongside this change). Let failures propagate so
 * the route returns a normal error instead of quietly corrupting the profile
 * and bombing every future turn's context.
 */
export async function saveAgentAvatar(workspaceId: string, imageBuffer: Buffer): Promise<string> {
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
}
