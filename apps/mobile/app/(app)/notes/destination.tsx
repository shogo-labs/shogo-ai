// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { notesApi } from "../../../lib/notes-api";
import { NOTES_DESIGN_TOKENS as T } from "../../../components/notes/notes-design-tokens";
import { NotesDestinationSheet } from "../../../components/notes/NotesDestinationSheet";

export default function NoteDestinationScreen() {
  const router = useRouter();
  const { noteId } = useLocalSearchParams<{ noteId: string }>();
  const [title, setTitle] = useState("");
  useEffect(() => {
    void notesApi
      .get(noteId)
      .then((note) => setTitle(note.title))
      .catch(() => {
        Alert.alert("Could not open note");
        router.back();
      });
  }, [noteId, router]);
  if (!title && !noteId)
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: T.background,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={T.primary} />
      </View>
    );
  return (
    <View style={{ flex: 1, backgroundColor: T.background }}>
      <NotesDestinationSheet
        noteId={noteId}
        noteTitle={title}
        visible
        onClose={() => router.back()}
        onSaved={(taskId) =>
          router.replace({
            pathname: "/(app)/activity" as any,
            params: { taskId },
          } as any)
        }
      />
    </View>
  );
}
