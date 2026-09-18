// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../lib/prisma";
import { getS3Client } from "../lib/s3";
import { homeRegionWorkspaceWhere } from "../lib/region";
import { transcribe } from "../services/transcription.service";

const db = prisma as any;
const POLL_INTERVAL_MS = 30_000;
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

let workerStarted = false;

function localAssetPath(storageKey: string): string {
  return join(
    process.env.SHOGO_DATA_DIR || ".data",
    "notes",
    storageKey.replace(/^(?:notes|local-notes)\//, ""),
  );
}

function isLocalAsset(storageKey: string): boolean {
  return storageKey.startsWith("local-notes/");
}

async function objectBytes(storageKey: string): Promise<Buffer> {
  const bucket =
    process.env.S3_NOTES_BUCKET || process.env.S3_WORKSPACES_BUCKET;
  if (!bucket || isLocalAsset(storageKey))
    return readFile(localAssetPath(storageKey));

  const response = await getS3Client().send(
    new GetObjectCommand({ Bucket: bucket, Key: storageKey }),
  );
  if (!response.Body) throw new Error("Notes audio object has no body");
  const chunks: Buffer[] = [];
  for await (const chunk of response.Body as any)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function claimJob(job: any): Promise<boolean> {
  const now = new Date();
  const result = await db.noteTranscriptionJob.updateMany({
    where: {
      id: job.id,
      OR: [
        { status: "queued" },
        { status: "failed", attemptCount: { lt: MAX_ATTEMPTS } },
        {
          status: "processing",
          startedAt: { lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) },
        },
      ],
    },
    data: { status: "processing", startedAt: now, error: null },
  });
  return result.count === 1;
}

async function processOne(): Promise<void> {
  const now = new Date();
  const home = homeRegionWorkspaceWhere();
  const job = await db.noteTranscriptionJob.findFirst({
    where: {
      OR: [
        { status: "queued" },
        {
          status: "failed",
          attemptCount: { lt: MAX_ATTEMPTS },
          nextRetryAt: null,
        },
        {
          status: "failed",
          attemptCount: { lt: MAX_ATTEMPTS },
          nextRetryAt: { lte: now },
        },
        {
          status: "processing",
          startedAt: { lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) },
        },
      ],
      workspace: home ? home : undefined,
    },
    orderBy: { createdAt: "asc" },
    include: { asset: true },
  });
  if (!job || !job.asset || job.asset.deletedAt) return;
  if (!(await claimJob(job))) return;

  const tempDir = await mkdtemp(join(tmpdir(), "shogo-note-transcription-"));
  const extension =
    job.asset.originalName
      ?.split(".")
      .pop()
      ?.replace(/[^a-z0-9]/gi, "") || "m4a";
  const audioPath = join(
    tempDir,
    `${createHash("sha1").update(job.asset.storageKey).digest("hex")}.${extension}`,
  );
  try {
    await writeFile(audioPath, await objectBytes(job.asset.storageKey));
    const result = await transcribe(audioPath, { preferLocal: true });
    await db.$transaction([
      db.noteAsset.update({
        where: { id: job.asset.id },
        data: { transcriptionStatus: "available", transcriptText: result.text },
      }),
      db.noteTranscriptionJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          error: null,
          nextRetryAt: null,
        },
      }),
    ]);
  } catch (error: any) {
    const attemptCount = Number(job.attemptCount || 0) + 1;
    const retryDelay = Math.min(
      60 * 60 * 1000,
      2 ** Math.min(attemptCount, 10) * 1000,
    );
    await db.$transaction([
      db.noteAsset.update({
        where: { id: job.asset.id },
        data: { transcriptionStatus: "failed" },
      }),
      db.noteTranscriptionJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          attemptCount,
          error: String(error?.message || error).slice(0, 2000),
          nextRetryAt:
            attemptCount < MAX_ATTEMPTS
              ? new Date(Date.now() + retryDelay)
              : null,
        },
      }),
    ]);
    console.warn(
      `[NotesTranscription] Job ${job.id} failed (attempt ${attemptCount}/${MAX_ATTEMPTS}):`,
      error?.message || error,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Start a queued job now rather than making a newly recorded voice note wait
 * for the normal polling interval. Claiming keeps this safe with the worker. */
export function wakeNotesTranscriptionWorker(): void {
  void processOne().catch((error) =>
    console.warn(
      "[NotesTranscription] Immediate job failed:",
      error?.message || error,
    ),
  );
}

export function startNotesTranscriptionWorker(): void {
  if (workerStarted) return;
  workerStarted = true;
  const tick = wakeNotesTranscriptionWorker;
  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref?.();
  console.log("[NotesTranscription] Worker started");
}
