// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono, type Context } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { wakeNotesTranscriptionWorker } from "../jobs/notes-transcription";
import { prisma } from "../lib/prisma";
import { getPresignedReadUrl, getS3Client } from "../lib/s3";
import { transcribe } from "../services/transcription.service";

const db = prisma as any;
const LOCAL_MODE = process.env.SHOGO_LOCAL_MODE === "true";
const MAX_ASSETS = 20;
const MAX_LIVE_ASSETS = 100 * 1024 * 1024;
const LIMITS: Record<string, number> = {
  image: 10 * 1024 * 1024,
  file: 25 * 1024 * 1024,
  audio: 50 * 1024 * 1024,
};

function userId(c: Context): string | null {
  const auth = c.get("auth") as
    { userId?: string; isAuthenticated?: boolean } | undefined;
  return auth?.isAuthenticated === false ? null : (auth?.userId ?? null);
}

function unauthorized(c: Context) {
  return c.json(
    { error: { code: "unauthorized", message: "Authentication required" } },
    401,
  );
}

function bad(c: Context, code: string, message: string, status = 400) {
  return c.json(
    { error: { code, message } },
    status as 400 | 401 | 403 | 404 | 409 | 413 | 422,
  );
}

async function memberOfWorkspace(
  ownerId: string,
  workspaceId: string,
): Promise<boolean> {
  const member = await db.member.findFirst({
    where: { userId: ownerId, workspaceId },
    select: { id: true },
  });
  return Boolean(member);
}

async function requireWorkspace(
  c: Context,
  owner: string,
): Promise<{ workspaceId: string } | null> {
  const workspaceId =
    c.req.query("workspaceId") || c.req.header("x-workspace-id");
  if (!workspaceId) return null;
  if (!(await memberOfWorkspace(owner, workspaceId))) return null;
  return { workspaceId };
}

function emptyDocument() {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function parseDocument(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return emptyDocument();
    }
  }
  return (
    value && typeof value === "object" ? value : emptyDocument()
  ) as Record<string, unknown>;
}

function storedDocument(value: Record<string, unknown>): unknown {
  return LOCAL_MODE ? JSON.stringify(value) : value;
}

function plainText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { type?: unknown; text?: unknown; content?: unknown[] };
  const own = typeof node.text === "string" ? node.text : "";
  const children = Array.isArray(node.content)
    ? node.content.map(plainText).join(node.type === "paragraph" ? "\n" : "")
    : "";
  return `${own}${children}`.replace(/\n{3,}/g, "\n\n").trim();
}

// iOS contenteditable occasionally reports its visible text before its DOM
// nodes have settled. Keep the text rather than persisting an empty document.
function documentFromPlainText(value: string): Record<string, unknown> {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  return {
    type: "doc",
    content: (lines.length ? lines : [""]).map((line) =>
      line
        ? { type: "paragraph", content: [{ type: "text", text: line }] }
        : { type: "paragraph" },
    ),
  };
}

function documentForStorage(
  content: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  return plainText(content).trim() || !text.trim()
    ? content
    : documentFromPlainText(text);
}

function validDocument(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as {
    type?: unknown;
    content?: unknown[];
    attrs?: Record<string, unknown>;
  };
  const allowed = new Set([
    "doc",
    "paragraph",
    "heading",
    "text",
    "bulletList",
    "orderedList",
    "listItem",
    "hardBreak",
    "image",
    "file",
    "audio",
    "transcript",
  ]);
  if (typeof node.type !== "string" || !allowed.has(node.type)) return false;
  if (
    node.type === "text" &&
    typeof (node as { text?: unknown }).text !== "string"
  )
    return false;
  if (node.type === "image" || node.type === "file" || node.type === "audio") {
    if (!node.attrs || typeof node.attrs.assetId !== "string") return false;
  }
  return (
    !node.content ||
    (Array.isArray(node.content) && node.content.every(validDocument))
  );
}

function noteResponse(note: any) {
  const contentJson = parseDocument(note.contentJson);
  return {
    ...note,
    contentJson: documentForStorage(contentJson, note.plainText || ""),
    assets:
      note.assets?.map((asset: any) => ({
        ...asset,
        sizeBytes: Number(asset.sizeBytes),
      })) ?? undefined,
  };
}

async function ownedNote(id: string, ownerId: string, includeDeleted = false) {
  return db.note.findFirst({
    where: {
      id,
      ownerId,
      workspace: { members: { some: { userId: ownerId } } },
      ...(includeDeleted ? {} : { deletedAt: null }),
    },
    include: {
      assets: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
      folder: true,
    },
  });
}

async function ownedFolder(id: string, ownerId: string) {
  return db.noteFolder.findFirst({
    where: {
      id,
      ownerId,
      deletedAt: null,
      workspace: { members: { some: { userId: ownerId } } },
    },
  });
}

async function isDescendant(
  folderId: string,
  possibleParentId: string,
  ownerId: string,
): Promise<boolean> {
  let cursor = possibleParentId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === folderId) return true;
    seen.add(cursor);
    const parent = await db.noteFolder.findFirst({
      where: { id: cursor, ownerId },
      select: { parentId: true },
    });
    cursor = parent?.parentId ?? "";
  }
  return false;
}

function assetKind(
  kind: unknown,
  mimeType: string,
): "image" | "file" | "audio" | null {
  if (kind === "image" || kind === "file" || kind === "audio") return kind;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function decodeDataUrl(
  dataUrl: string,
): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase(),
    bytes: Buffer.from(match[2], "base64"),
  };
}

function hasVideoMime(mimeType: string) {
  return mimeType.toLowerCase().startsWith("video/");
}

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

async function persistAssetLocally(storageKey: string, bytes: Buffer) {
  const path = localAssetPath(storageKey);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function persistAsset(input: {
  workspaceId: string;
  ownerId: string;
  noteId: string;
  kind: "image" | "file" | "audio";
  originalName: string;
  mimeType: string;
  bytes: Buffer;
}) {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const assetId = randomUUID();
  const storageKey = `notes/${input.workspaceId}/${input.ownerId}/${input.noteId}/${assetId}/${sha256}`;
  const bucket =
    process.env.S3_NOTES_BUCKET || process.env.S3_WORKSPACES_BUCKET;
  if (bucket) {
    try {
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: storageKey,
          Body: input.bytes,
          ContentType: input.mimeType,
        }),
      );
      return { assetId, storageKey, sha256 };
    } catch (error) {
      // Local development must remain usable when an optional MinIO/S3 service
      // is offline. Production keeps the failed upload visible to callers.
      if (process.env.NODE_ENV === "production") throw error;
      const localStorageKey = storageKey.replace(/^notes\//, "local-notes/");
      await persistAssetLocally(localStorageKey, input.bytes);
      return { assetId, storageKey: localStorageKey, sha256 };
    }
  }
  await persistAssetLocally(storageKey, input.bytes);
  return { assetId, storageKey, sha256 };
}

export function notesRoutes() {
  const router = new Hono();

  router.get("/notes", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const scope = await requireWorkspace(c, owner);
    if (!scope)
      return bad(c, "forbidden", "Active workspace membership required", 403);
    const folderId = c.req.query("folderId") || null;
    const includeDeleted = c.req.query("includeDeleted") === "true";
    const notes = await db.note.findMany({
      where: {
        workspaceId: scope.workspaceId,
        ownerId: owner,
        ...(includeDeleted
          ? { deletedAt: { not: null } }
          : { deletedAt: null }),
        folderId,
      },
      include: {
        assets: {
          where: { deletedAt: null },
          select: {
            id: true,
            kind: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
          },
        },
      },
      orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
    });
    return c.json({ ok: true, data: notes.map(noteResponse) });
  });

  router.post("/notes", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const workspaceId =
      typeof body.workspaceId === "string"
        ? body.workspaceId
        : c.req.query("workspaceId");
    if (!workspaceId || !(await memberOfWorkspace(owner, workspaceId)))
      return bad(c, "forbidden", "Active workspace membership required", 403);
    const content = validDocument(body.contentJson)
      ? (body.contentJson as Record<string, unknown>)
      : emptyDocument();
    const folderId = typeof body.folderId === "string" ? body.folderId : null;
    if (
      folderId &&
      !(await db.noteFolder.findFirst({
        where: { id: folderId, ownerId: owner, workspaceId, deletedAt: null },
      }))
    )
      return bad(c, "invalid_folder", "Folder not found", 422);
    const text =
      typeof body.plainText === "string"
        ? body.plainText.slice(0, 1_000_000)
        : plainText(content);
    const normalizedContent = documentForStorage(content, text);
    const note = await db.note.create({
      data: {
        workspaceId,
        ownerId: owner,
        folderId,
        title: typeof body.title === "string" ? body.title.slice(0, 500) : "",
        contentJson: storedDocument(normalizedContent),
        plainText: text,
        preview: text.slice(0, 240),
      },
      include: { assets: true },
    });
    return c.json({ ok: true, data: noteResponse(note) }, 201);
  });

  router.get("/notes/search", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const scope = await requireWorkspace(c, owner);
    if (!scope)
      return bad(c, "forbidden", "Active workspace membership required", 403);
    const q = (c.req.query("q") || "").trim().slice(0, 200);
    if (!q) return c.json({ ok: true, data: [] });
    // Prisma's SQLite adapter (used by the simulator/local app) performs
    // `contains` comparisons case-sensitively. Fetch the user's active notes
    // and normalize the searchable fields in one place so searching for
    // "united" also finds content saved as "United". This also keeps the
    // behavior consistent with the hosted PostgreSQL database.
    const candidates = await db.note.findMany({
      where: {
        workspaceId: scope.workspaceId,
        ownerId: owner,
        deletedAt: null,
      },
      include: {
        assets: {
          where: { deletedAt: null },
          select: {
            id: true,
            kind: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            transcriptText: true,
            transcriptionStatus: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
    const normalizedQuery = q.toLowerCase();
    const notes = candidates
      .filter((note: any) => {
        const searchableText = [
          note.title,
          note.plainText,
          note.preview,
          ...(note.assets || []).flatMap((asset: any) => [
            asset.originalName,
            asset.transcriptText,
          ]),
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        return searchableText.includes(normalizedQuery);
      })
      .slice(0, 50);
    return c.json({ ok: true, data: notes.map(noteResponse) });
  });

  router.get("/notes/:noteId", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const note = await ownedNote(c.req.param("noteId"), owner);
    if (!note) return bad(c, "not_found", "Note not found", 404);
    return c.json({ ok: true, data: noteResponse(note) });
  });

  router.patch("/notes/:noteId", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const current = await ownedNote(c.req.param("noteId"), owner);
    if (!current) return bad(c, "not_found", "Note not found", 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const expected = Number(body.expectedVersion);
    if (!Number.isInteger(expected) || expected !== current.version)
      return bad(
        c,
        "note_version_conflict",
        "The note changed elsewhere; preserve this local copy and resolve the conflict.",
        409,
      );
    const content: unknown =
      body.contentJson === undefined
        ? parseDocument(current.contentJson)
        : body.contentJson;
    if (!validDocument(content))
      return bad(c, "invalid_content", "Unsupported note document", 422);
    if (
      typeof body.folderId === "string" &&
      !(await db.noteFolder.findFirst({
        where: {
          id: body.folderId,
          ownerId: owner,
          workspaceId: current.workspaceId,
          deletedAt: null,
        },
      }))
    )
      return bad(c, "invalid_folder", "Folder not found", 422);
    const text =
      typeof body.plainText === "string"
        ? body.plainText.slice(0, 1_000_000)
        : plainText(content);
    const normalizedContent = documentForStorage(
      content as Record<string, unknown>,
      text,
    );
    const note = await db.note.update({
      where: { id: current.id },
      data: {
        title:
          typeof body.title === "string"
            ? body.title.slice(0, 500)
            : current.title,
        contentJson: storedDocument(normalizedContent),
        plainText: text,
        preview: text.slice(0, 240),
        isPinned:
          typeof body.isPinned === "boolean" ? body.isPinned : current.isPinned,
        folderId:
          body.folderId === null || typeof body.folderId === "string"
            ? body.folderId
            : current.folderId,
        version: { increment: 1 },
      },
      include: { assets: { where: { deletedAt: null } }, folder: true },
    });
    return c.json({ ok: true, data: noteResponse(note) });
  });

  router.delete("/notes/:noteId", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const note = await ownedNote(c.req.param("noteId"), owner);
    if (!note) return bad(c, "not_found", "Note not found", 404);
    await db.note.update({
      where: { id: note.id },
      data: { deletedAt: new Date() },
    });
    await db.noteAsset.updateMany({
      where: { noteId: note.id, ownerId: owner, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return c.json({ ok: true });
  });

  router.post("/notes/:noteId/restore", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const note = await ownedNote(c.req.param("noteId"), owner, true);
    if (!note || !note.deletedAt)
      return bad(c, "not_found", "Deleted note not found", 404);
    const restored = await db.note.update({
      where: { id: note.id },
      data: { deletedAt: null },
    });
    await db.noteAsset.updateMany({
      where: { noteId: note.id, ownerId: owner },
      data: { deletedAt: null },
    });
    return c.json({ ok: true, data: noteResponse(restored) });
  });

  router.delete("/notes/:noteId/permanent", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const note = await ownedNote(c.req.param("noteId"), owner, true);
    if (!note || !note.deletedAt)
      return bad(c, "not_found", "Deleted note not found", 404);
    await db.note.delete({ where: { id: note.id } });
    return c.json({ ok: true });
  });

  router.get("/note-folders", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const scope = await requireWorkspace(c, owner);
    if (!scope)
      return bad(c, "forbidden", "Active workspace membership required", 403);
    const parentId = c.req.query("parentId") || null;
    const folders = await db.noteFolder.findMany({
      where: {
        workspaceId: scope.workspaceId,
        ownerId: owner,
        parentId,
        deletedAt: null,
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    return c.json({ ok: true, data: folders });
  });

  router.post("/note-folders", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const workspaceId =
      typeof body.workspaceId === "string"
        ? body.workspaceId
        : c.req.query("workspaceId");
    if (!workspaceId || !(await memberOfWorkspace(owner, workspaceId)))
      return bad(c, "forbidden", "Active workspace membership required", 403);
    const parentId = typeof body.parentId === "string" ? body.parentId : null;
    if (
      parentId &&
      !(await db.noteFolder.findFirst({
        where: { id: parentId, ownerId: owner, workspaceId, deletedAt: null },
      }))
    )
      return bad(c, "invalid_parent", "Parent folder not found", 422);
    const folder = await db.noteFolder.create({
      data: {
        workspaceId,
        ownerId: owner,
        parentId,
        name:
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim().slice(0, 200)
            : "New Folder",
      },
    });
    return c.json({ ok: true, data: folder }, 201);
  });

  router.patch("/note-folders/:folderId", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const folder = await ownedFolder(c.req.param("folderId"), owner);
    if (!folder) return bad(c, "not_found", "Folder not found", 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const parentId =
      body.parentId === null
        ? null
        : typeof body.parentId === "string"
          ? body.parentId
          : folder.parentId;
    const parentFolder = parentId ? await ownedFolder(parentId, owner) : null;
    if (
      parentId &&
      (!parentFolder || parentFolder.workspaceId !== folder.workspaceId)
    )
      return bad(c, "invalid_parent", "Parent folder not found", 422);
    if (
      parentId === folder.id ||
      (parentId && (await isDescendant(folder.id, parentId, owner)))
    )
      return bad(
        c,
        "folder_cycle",
        "A folder cannot be moved into itself or a descendant",
        409,
      );
    const updated = await db.noteFolder.update({
      where: { id: folder.id },
      data: {
        name:
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim().slice(0, 200)
            : folder.name,
        parentId,
      },
    });
    return c.json({ ok: true, data: updated });
  });

  router.delete("/note-folders/:folderId", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const folder = await ownedFolder(c.req.param("folderId"), owner);
    if (!folder) return bad(c, "not_found", "Folder not found", 404);
    await db.$transaction([
      db.note.updateMany({
        where: { folderId: folder.id, ownerId: owner },
        data: { folderId: folder.parentId },
      }),
      db.noteFolder.updateMany({
        where: { parentId: folder.id, ownerId: owner },
        data: { parentId: folder.parentId },
      }),
      db.noteFolder.update({
        where: { id: folder.id },
        data: { deletedAt: new Date() },
      }),
    ]);
    return c.json({ ok: true });
  });

  router.post("/notes/:noteId/assets", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const note = await ownedNote(c.req.param("noteId"), owner);
    if (!note) return bad(c, "not_found", "Note not found", 404);
    const existing = await db.noteAsset.findMany({
      where: { noteId: note.id, ownerId: owner, deletedAt: null },
      select: { sizeBytes: true },
    });
    if (existing.length >= MAX_ASSETS)
      return bad(c, "asset_limit", "A note can contain at most 20 assets", 413);
    let originalName = "attachment";
    let mimeType = "application/octet-stream";
    let kindValue: unknown;
    let bytes: Buffer | null = null;
    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (file instanceof File) {
        originalName = file.name || originalName;
        mimeType = file.type || mimeType;
        bytes = Buffer.from(await file.arrayBuffer());
      }
      kindValue = form.get("kind");
    } else {
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      originalName =
        typeof body.originalName === "string"
          ? body.originalName.slice(0, 255)
          : originalName;
      mimeType =
        typeof body.mimeType === "string"
          ? body.mimeType.toLowerCase()
          : mimeType;
      kindValue = body.kind;
      const decoded =
        typeof body.dataUrl === "string" ? decodeDataUrl(body.dataUrl) : null;
      if (decoded) {
        mimeType = decoded.mimeType;
        bytes = decoded.bytes;
      }
    }
    if (!bytes?.length)
      return bad(c, "invalid_asset", "Attachment data is required");
    if (hasVideoMime(mimeType))
      return bad(
        c,
        "video_not_supported",
        "Video attachments are not supported",
        422,
      );
    const kind = assetKind(kindValue, mimeType);
    if (!kind)
      return bad(c, "invalid_asset_kind", "Unsupported attachment type", 422);
    if (bytes.length > LIMITS[kind])
      return bad(
        c,
        "asset_too_large",
        `This ${kind} exceeds the size limit`,
        413,
      );
    const liveBytes = existing.reduce(
      (sum: number, asset: any) => sum + Number(asset.sizeBytes),
      0,
    );
    if (liveBytes + bytes.length > MAX_LIVE_ASSETS)
      return bad(
        c,
        "note_storage_limit",
        "This note exceeds its live attachment limit",
        413,
      );
    const persisted = await persistAsset({
      workspaceId: note.workspaceId,
      ownerId: owner,
      noteId: note.id,
      kind,
      originalName,
      mimeType,
      bytes,
    });
    const asset = await db.noteAsset.create({
      data: {
        id: persisted.assetId,
        workspaceId: note.workspaceId,
        ownerId: owner,
        noteId: note.id,
        kind,
        storageKey: persisted.storageKey,
        originalName,
        mimeType,
        sizeBytes: BigInt(bytes.length),
        sha256: persisted.sha256,
        transcriptionStatus: kind === "audio" ? "pending" : "not_applicable",
      },
    });
    if (kind === "audio") {
      await db.noteTranscriptionJob.create({
        data: {
          assetId: asset.id,
          workspaceId: note.workspaceId,
          status: "queued",
        },
      });
      wakeNotesTranscriptionWorker();
    }
    return c.json(
      { ok: true, data: { ...asset, sizeBytes: Number(asset.sizeBytes) } },
      201,
    );
  });

  // Fallback for devices without Apple's live speech-recognition service.
  // The supplied audio exists only in a temporary file and is never an asset.
  router.post("/notes/:noteId/transcribe-audio", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const note = await ownedNote(c.req.param("noteId"), owner);
    if (!note) return bad(c, "not_found", "Note not found", 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const decoded =
      typeof body.dataUrl === "string" ? decodeDataUrl(body.dataUrl) : null;
    if (!decoded?.bytes.length)
      return bad(c, "invalid_audio", "Audio data is required");
    if (!decoded.mimeType.startsWith("audio/"))
      return bad(c, "invalid_audio", "An audio recording is required", 422);
    if (decoded.bytes.length > LIMITS.audio)
      return bad(
        c,
        "audio_too_large",
        "This recording exceeds the size limit",
        413,
      );
    const tempDir = await mkdtemp(join(tmpdir(), "shogo-note-dictation-"));
    const audioPath = join(
      tempDir,
      `${createHash("sha1").update(decoded.bytes).digest("hex")}.m4a`,
    );
    try {
      await writeFile(audioPath, decoded.bytes);
      const result = await transcribe(audioPath, { preferLocal: true });
      return c.json({ ok: true, data: { text: result.text.trim() } });
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  router.get("/note-assets/:assetId/download", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const asset = await db.noteAsset.findFirst({
      where: {
        id: c.req.param("assetId"),
        ownerId: owner,
        deletedAt: null,
        note: {
          deletedAt: null,
          workspace: { members: { some: { userId: owner } } },
        },
      },
    });
    if (!asset) return bad(c, "not_found", "Asset not found", 404);
    const bucket =
      process.env.S3_NOTES_BUCKET || process.env.S3_WORKSPACES_BUCKET;
    if (bucket && !isLocalAsset(asset.storageKey))
      return c.json({
        ok: true,
        data: {
          url: await getPresignedReadUrl(asset.storageKey, {
            bucket,
            expiresIn: 900,
          }),
        },
      });
    // The native app authenticates the request that obtains this URL. Returning
    // an image data URL here keeps locally stored attachments private while still
    // allowing React Native's Image/WebView components to render them.
    if (asset.kind !== "image")
      return bad(
        c,
        "asset_stream_unavailable",
        "Only image previews are available from local storage",
        422,
      );
    try {
      const bytes = await readFile(localAssetPath(asset.storageKey));
      return c.json({
        ok: true,
        data: {
          url: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
        },
      });
    } catch {
      return bad(
        c,
        "asset_missing",
        "The attachment is no longer available",
        404,
      );
    }
  });

  router.delete("/note-assets/:assetId", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const asset = await db.noteAsset.findFirst({
      where: {
        id: c.req.param("assetId"),
        ownerId: owner,
        deletedAt: null,
        note: { workspace: { members: { some: { userId: owner } } } },
      },
    });
    if (!asset) return bad(c, "not_found", "Asset not found", 404);
    await db.noteAsset.update({
      where: { id: asset.id },
      data: { deletedAt: new Date() },
    });
    return c.json({ ok: true });
  });

  router.patch("/note-assets/:assetId/transcript", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const asset = await db.noteAsset.findFirst({
      where: {
        id: c.req.param("assetId"),
        ownerId: owner,
        kind: "audio",
        deletedAt: null,
        note: { workspace: { members: { some: { userId: owner } } } },
      },
    });
    if (!asset) return bad(c, "not_found", "Audio asset not found", 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const updated = await db.noteAsset.update({
      where: { id: asset.id },
      data: {
        transcriptText:
          typeof body.transcriptText === "string"
            ? body.transcriptText.slice(0, 1_000_000)
            : "",
        transcriptionStatus: "available",
      },
    });
    await db.noteTranscriptionJob.updateMany({
      where: { assetId: asset.id },
      data: { status: "completed", completedAt: new Date(), error: null },
    });
    return c.json({
      ok: true,
      data: { ...updated, sizeBytes: Number(updated.sizeBytes) },
    });
  });

  router.post("/note-assets/:assetId/transcribe", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const asset = await db.noteAsset.findFirst({
      where: {
        id: c.req.param("assetId"),
        ownerId: owner,
        kind: "audio",
        deletedAt: null,
        note: { workspace: { members: { some: { userId: owner } } } },
      },
    });
    if (!asset) return bad(c, "not_found", "Audio asset not found", 404);
    await db.noteTranscriptionJob.upsert({
      where: { assetId: asset.id },
      create: {
        assetId: asset.id,
        workspaceId: asset.workspaceId,
        status: "queued",
      },
      update: { status: "queued", nextRetryAt: null, error: null },
    });
    const updated = await db.noteAsset.update({
      where: { id: asset.id },
      data: { transcriptionStatus: "queued" },
    });
    wakeNotesTranscriptionWorker();
    return c.json(
      { ok: true, data: { ...updated, sizeBytes: Number(updated.sizeBytes) } },
      202,
    );
  });

  router.post("/notes/:noteId/convert-to-task", async (c) => {
    const owner = userId(c);
    if (!owner) return unauthorized(c);
    const note = await ownedNote(c.req.param("noteId"), owner);
    if (!note) return bad(c, "not_found", "Note not found", 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const projectId =
      typeof body.projectId === "string" ? body.projectId : undefined;
    const newProjectName =
      typeof body.newProjectName === "string" && body.newProjectName.trim()
        ? body.newProjectName.trim().slice(0, 200)
        : undefined;
    const expectedNoteVersion = Number(body.expectedNoteVersion);
    const idempotencyKey =
      typeof body.idempotencyKey === "string"
        ? body.idempotencyKey.slice(0, 200)
        : "";
    if (
      (projectId ? 1 : 0) + (newProjectName ? 1 : 0) !== 1 ||
      !Number.isInteger(expectedNoteVersion) ||
      !idempotencyKey
    )
      return bad(
        c,
        "invalid_conversion",
        "Choose exactly one destination and provide the expected note version and idempotency key",
      );
    const existing = await db.noteTaskSnapshot.findUnique({
      where: { idempotencyKey },
      include: { task: { include: { project: true } } },
    });
    if (existing?.task && existing.task.userId === owner)
      return c.json({
        ok: true,
        data: { task: existing.task, project: existing.task.project },
      });
    if (expectedNoteVersion !== note.version)
      return bad(
        c,
        "note_version_conflict",
        "Save the latest note before converting it",
        409,
      );
    const destination = projectId
      ? await db.project.findFirst({
          where: { id: projectId, workspaceId: note.workspaceId },
          select: { id: true, name: true },
        })
      : null;
    if (projectId && !destination)
      return bad(c, "invalid_project", "Destination project not found", 422);
    const assets = await db.noteAsset.findMany({
      where: { noteId: note.id, ownerId: owner, deletedAt: null },
    });
    const result = await db.$transaction(async (tx: any) => {
      const project =
        destination ??
        (await tx.project.create({
          data: {
            name: newProjectName,
            description: note.plainText.slice(0, 500),
            workspaceId: note.workspaceId,
            createdBy: owner,
            tier: "starter",
            status: "draft",
            accessLevel: "anyone",
            schemas: LOCAL_MODE ? "[]" : [],
            settings: LOCAL_MODE
              ? JSON.stringify({ activeMode: "canvas" })
              : { activeMode: "canvas" },
          },
          select: { id: true, name: true },
        }));
      const task = await tx.agentTask.create({
        data: {
          userId: owner,
          workspaceId: note.workspaceId,
          projectId: project.id,
          title: note.title.trim() || "Untitled",
          notes: note.plainText || null,
          status: "draft",
          sourceType: "note",
        },
        include: { project: { select: { id: true, name: true } } },
      });
      const snapshot = await tx.noteTaskSnapshot.create({
        data: {
          taskId: task.id,
          noteId: note.id,
          sourceVersion: note.version,
          title: note.title,
          contentJson: storedDocument(parseDocument(note.contentJson)),
          plainText: note.plainText,
          idempotencyKey,
        },
      });
      if (assets.length)
        await tx.noteTaskSnapshotAsset.createMany({
          data: assets.map((asset: any) => ({
            snapshotId: snapshot.id,
            assetId: asset.id,
            storageKey: asset.storageKey,
            originalName: asset.originalName,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
          })),
        });
      return { task, project };
    });
    return c.json({ ok: true, data: result }, 201);
  });

  return router;
}
