// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Platform } from "react-native";
import * as SQLite from "expo-sqlite";

export type PendingNoteMutation = {
  id: number;
  noteId: string;
  payload: string;
  createdAt: number;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function database() {
  if (Platform.OS === "web") return null;
  databasePromise ||= SQLite.openDatabaseAsync("shogo-notes.db");
  const db = await databasePromise;
  await db.execAsync(
    "CREATE TABLE IF NOT EXISTS notes_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  return db;
}

export async function enqueueNoteMutation(
  noteId: string,
  payload: Record<string, unknown>,
) {
  const db = await database();
  if (!db) return;
  // Each note has one latest-write-wins outbox item. Multiple offline edits
  // otherwise carry the same optimistic version and the second replay would
  // inevitably conflict after the first succeeds.
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM notes_outbox WHERE note_id = ?", noteId);
    await db.runAsync(
      "INSERT INTO notes_outbox (note_id, payload, created_at) VALUES (?, ?, ?)",
      noteId,
      JSON.stringify(payload),
      Date.now(),
    );
  });
}

export async function pendingNoteMutations(): Promise<PendingNoteMutation[]> {
  const db = await database();
  if (!db) return [];
  return db.getAllAsync<PendingNoteMutation>(
    "SELECT id, note_id as noteId, payload, created_at as createdAt FROM notes_outbox ORDER BY id ASC",
  );
}

export async function flushNoteMutations(
  send: (item: PendingNoteMutation) => Promise<void>,
) {
  const db = await database();
  if (!db) return;
  const items = await pendingNoteMutations();
  for (const item of items) {
    try {
      await send(item);
      await db.runAsync("DELETE FROM notes_outbox WHERE id = ?", item.id);
    } catch {
      break;
    }
  }
}

export async function clearNotesOfflineData() {
  const db = await database();
  if (db) await db.execAsync("DROP TABLE IF EXISTS notes_outbox");
  databasePromise = null;
}
