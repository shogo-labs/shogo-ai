// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useActiveWorkspace } from "../../../hooks/useActiveWorkspace";
import { notesApi, type Note } from "../../../lib/notes-api";
import { formatNoteUpdatedAt } from "../../../lib/note-display";
import { NOTES_DESIGN_TOKENS as T } from "../../../components/notes/notes-design-tokens";
import { NotesSearchIcon } from "../../../components/notes/FigmaNotesIcons";

const SEARCH_DEBOUNCE_MS = 250;

export default function NotesSearchScreen() {
  const router = useRouter();
  const workspace = useActiveWorkspace() as { id: string } | null;
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Note[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const keyboardOverlap = Math.max(0, keyboardHeight - insets.bottom);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      requestRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const updateKeyboardFrame = (event: {
      endCoordinates: { height: number };
    }) => {
      setKeyboardHeight(Math.max(0, event.endCoordinates.height));
    };
    const frameSubscription = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow",
      updateKeyboardFrame,
    );
    const hideSubscription = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setKeyboardHeight(0),
    );
    return () => {
      frameSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  const search = useCallback(
    (value: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      requestRef.current?.abort();

      const sequence = ++sequenceRef.current;
      const trimmed = value.trim();
      if (!workspace?.id || !trimmed) {
        setResults([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      timerRef.current = setTimeout(() => {
        const controller = new AbortController();
        requestRef.current = controller;
        void notesApi
          .search(workspace.id, trimmed, controller.signal)
          .then((next) => {
            if (sequence === sequenceRef.current) setResults(next);
          })
          .catch((error) => {
            if (
              error?.name !== "AbortError" &&
              sequence === sequenceRef.current
            )
              setResults([]);
          })
          .finally(() => {
            if (sequence === sequenceRef.current) setLoading(false);
          });
      }, SEARCH_DEBOUNCE_MS);
    },
    [workspace?.id],
  );

  // If the screen opens before the active workspace has loaded, the first
  // keystrokes cannot be searched. Retry the current query once the workspace
  // becomes available.
  useEffect(() => {
    if (workspace?.id && query.trim()) search(query);
  }, [query, search, workspace?.id]);

  const openNote = (note: Note) => {
    router.push({
      pathname: "/(app)/notes/[noteId]" as any,
      params: { noteId: note.id },
    } as any);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <Pressable
          accessibilityLabel="Back"
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <ChevronLeft size={24} color={T.text} strokeWidth={1.7} />
        </Pressable>

        {loading ? (
          <ActivityIndicator color={T.primary} style={styles.loading} />
        ) : results.length ? (
          <FlatList
            data={results}
            keyExtractor={(note) => note.id}
            contentContainerStyle={[
              styles.resultsContent,
              { paddingBottom: 140 + keyboardOverlap },
            ]}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                style={styles.resultCard}
                onPress={() => openNote(item)}
              >
                <Text numberOfLines={1} style={styles.resultTitle}>
                  {item.title.trim() || "Untitled"}
                </Text>
                <Text style={styles.resultDate}>
                  {formatNoteUpdatedAt(item.updatedAt)}
                </Text>
                <Text numberOfLines={3} style={styles.resultPreview}>
                  {item.preview || "No text"}
                </Text>
              </Pressable>
            )}
          />
        ) : (
          <View style={styles.emptyState} pointerEvents="none">
            <Text style={styles.emptyText}>
              {query.trim() ? "No results" : "No recent Searches"}
            </Text>
          </View>
        )}

        <View
          style={[
            styles.searchDock,
            { bottom: keyboardHeight > 0 ? keyboardOverlap + 8 : 8 },
          ]}
        >
          <View style={styles.searchPill}>
            <View style={styles.searchIconBox}>
              <NotesSearchIcon size={24} color={T.text} />
            </View>
            <TextInput
              autoFocus
              value={query}
              onChangeText={(value) => {
                setQuery(value);
              }}
              accessibilityLabel="Search notes"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              placeholder=""
              placeholderTextColor={T.placeholder}
              selectionColor={T.text}
              style={styles.searchInput}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = {
  screen: {
    flex: 1,
    backgroundColor: T.background,
  },
  content: {
    flex: 1,
    position: "relative" as const,
  },
  backButton: {
    position: "absolute" as const,
    top: 16,
    left: 8,
    width: 48,
    height: 48,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    zIndex: 2,
  },
  resultsContent: {
    paddingHorizontal: 29,
    paddingTop: 95,
    paddingBottom: 140,
  },
  resultCard: {
    height: 116,
    marginBottom: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: T.card,
  },
  resultTitle: {
    color: T.text,
    fontSize: 16,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  resultDate: {
    marginTop: 4,
    color: T.text,
    fontSize: 12,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  resultPreview: {
    marginTop: 4,
    color: T.secondaryText,
    fontSize: 12,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  emptyState: {
    position: "absolute" as const,
    top: 209,
    left: 0,
    right: 0,
    alignItems: "center" as const,
  },
  emptyText: {
    color: T.text,
    fontSize: 16,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  loading: {
    position: "absolute" as const,
    top: 209,
    left: 0,
    right: 0,
  },
  searchDock: {
    position: "absolute" as const,
    right: 30,
    bottom: 30,
    left: 31,
    height: 56,
  },
  searchPill: {
    height: 56,
    width: "100%" as const,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    padding: 4,
    borderRadius: 1000,
    backgroundColor: T.elevated,
  },
  searchIconBox: {
    width: 36,
    height: 48,
    paddingLeft: 12,
    alignItems: "flex-start" as const,
    justifyContent: "center" as const,
  },
  searchInput: {
    flex: 1,
    height: 48,
    padding: 0,
    paddingVertical: 0,
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 16,
    fontWeight: "400" as const,
    lineHeight: 16,
    textAlignVertical: "center" as const,
  },
} as const;
