// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { createHttpClient } from "./api";
import {
  enqueueNoteMutation,
  flushNoteMutations,
  type PendingNoteMutation,
} from "./notes-offline";

export type NoteNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: NoteNode[];
};

export type NoteAsset = {
  id: string;
  kind: "image" | "file" | "audio";
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey?: string;
  transcriptionStatus?: string;
  transcriptText?: string | null;
};

export type Note = {
  id: string;
  workspaceId: string;
  ownerId: string;
  folderId: string | null;
  title: string;
  contentJson: NoteNode;
  plainText: string;
  preview: string;
  isPinned: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  assets?: NoteAsset[];
};

export type NoteFolder = {
  id: string;
  workspaceId: string;
  ownerId: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type NoteTaskConversion = {
  task: {
    id: string;
    title: string;
    projectId: string | null;
    status: string;
    sourceType?: string;
  };
  project: { id: string; name: string };
};

const http = createHttpClient();
const data = <T>(response: { data?: { data?: T; items?: T } }): T => {
  const envelope = response.data;
  return (envelope?.data ?? envelope?.items) as T;
};

function isNetworkFailure(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "NETWORK_ERROR",
  );
}

function collection<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const nested = value as { data?: unknown; items?: unknown };
    if (Array.isArray(nested.data)) return nested.data as T[];
    if (Array.isArray(nested.items)) return nested.items as T[];
  }
  return [];
}

function query(params: Record<string, string | undefined>) {
  const value = Object.entries(params)
    .filter(([, item]) => item)
    .map(
      ([key, item]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(item!)}`,
    )
    .join("&");
  return value ? `?${value}` : "";
}

export const notesApi = {
  async list(
    workspaceId: string,
    options: { folderId?: string | null; includeDeleted?: boolean } = {},
  ) {
    const response = await http.get<{ data: Note[] }>(
      `/api/notes${query({ workspaceId, folderId: options.folderId ?? undefined, includeDeleted: options.includeDeleted ? "true" : undefined })}`,
    );
    return collection<Note>(data(response));
  },
  async get(noteId: string) {
    const response = await http.get<{ data: Note }>(
      `/api/notes/${encodeURIComponent(noteId)}`,
    );
    return data(response);
  },
  async create(input: {
    workspaceId: string;
    folderId?: string | null;
    title?: string;
    contentJson?: NoteNode;
  }) {
    const response = await http.post<{ data: Note }>("/api/notes", input);
    return data(response);
  },
  async update(
    noteId: string,
    input: {
      expectedVersion: number;
      title?: string;
      contentJson?: NoteNode;
      plainText?: string;
      isPinned?: boolean;
      folderId?: string | null;
    },
  ) {
    try {
      const response = await http.patch<{ data: Note }>(
        `/api/notes/${encodeURIComponent(noteId)}`,
        input,
      );
      return data(response);
    } catch (error) {
      // A validation or version conflict cannot succeed merely by retrying.
      // Keep only genuine offline saves for the outbox.
      if (isNetworkFailure(error)) {
        await enqueueNoteMutation(
          noteId,
          input as Record<string, unknown>,
        ).catch(() => {});
      }
      throw error;
    }
  },
  async flushOfflineMutations() {
    await flushNoteMutations(async (item: PendingNoteMutation) => {
      await http.patch(
        `/api/notes/${encodeURIComponent(item.noteId)}`,
        JSON.parse(item.payload),
      );
    });
  },
  async remove(noteId: string) {
    await http.delete(`/api/notes/${encodeURIComponent(noteId)}`);
  },
  async restore(noteId: string) {
    await http.post(`/api/notes/${encodeURIComponent(noteId)}/restore`, {});
  },
  async permanentlyDelete(noteId: string) {
    await http.delete(`/api/notes/${encodeURIComponent(noteId)}/permanent`);
  },
  async search(workspaceId: string, q: string, signal?: AbortSignal) {
    const response = await http.request<{ data: Note[] }>(
      `/api/notes/search${query({ workspaceId, q })}`,
      { method: "GET", signal },
    );
    return collection<Note>(data(response));
  },
  async listFolders(workspaceId: string, parentId?: string | null) {
    const response = await http.get<{ data: NoteFolder[] }>(
      `/api/note-folders${query({ workspaceId, parentId: parentId ?? undefined })}`,
    );
    return collection<NoteFolder>(data(response));
  },
  async createFolder(input: {
    workspaceId: string;
    parentId?: string | null;
    name: string;
  }) {
    const response = await http.post<{ data: NoteFolder }>(
      "/api/note-folders",
      input,
    );
    return data(response);
  },
  async updateFolder(
    folderId: string,
    input: { name?: string; parentId?: string | null },
  ) {
    const response = await http.patch<{ data: NoteFolder }>(
      `/api/note-folders/${encodeURIComponent(folderId)}`,
      input,
    );
    return data(response);
  },
  async removeFolder(folderId: string) {
    await http.delete(`/api/note-folders/${encodeURIComponent(folderId)}`);
  },
  async uploadAsset(
    noteId: string,
    input: {
      dataUrl: string;
      originalName: string;
      mimeType: string;
      kind: NoteAsset["kind"];
    },
  ) {
    const response = await http.post<{ data: NoteAsset }>(
      `/api/notes/${encodeURIComponent(noteId)}/assets`,
      input,
    );
    return data(response);
  },
  async transcribeAudio(noteId: string, input: { dataUrl: string }) {
    const response = await http.post<{ data: { text: string } }>(
      `/api/notes/${encodeURIComponent(noteId)}/transcribe-audio`,
      input,
    );
    return data(response);
  },
  async getAssetPreviewUrl(assetId: string) {
    const response = await http.get<{ data: { url: string } }>(
      `/api/note-assets/${encodeURIComponent(assetId)}/download`,
    );
    return data(response).url;
  },
  async updateTranscript(assetId: string, transcriptText: string) {
    const response = await http.patch<{ data: NoteAsset }>(
      `/api/note-assets/${encodeURIComponent(assetId)}/transcript`,
      { transcriptText },
    );
    return data(response);
  },
  async requestTranscription(assetId: string) {
    const response = await http.post<{ data: NoteAsset }>(
      `/api/note-assets/${encodeURIComponent(assetId)}/transcribe`,
      {},
    );
    return data(response);
  },
  async convertToTask(
    noteId: string,
    input: {
      projectId?: string;
      newProjectName?: string;
      expectedNoteVersion: number;
      idempotencyKey: string;
    },
  ) {
    const response = await http.post<{ data: NoteTaskConversion }>(
      `/api/notes/${encodeURIComponent(noteId)}/convert-to-task`,
      input,
    );
    return data(response);
  },
};
