// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  Plus,
} from "lucide-react-native";
import { useActiveWorkspace } from "../../../hooks/useActiveWorkspace";
import { notesApi, type Note, type NoteFolder } from "../../../lib/notes-api";
import { formatNoteUpdatedAt } from "../../../lib/note-display";
import { NOTES_DESIGN_TOKENS as T } from "../../../components/notes/notes-design-tokens";
import { NotesCreateIcon } from "../../../components/notes/NotesCreateIcon";
import { NotesSearchIcon } from "../../../components/notes/FigmaNotesIcons";

export default function NotesListScreen() {
  const router = useRouter();
  const workspace = useActiveWorkspace() as { id: string } | null;
  const params = useLocalSearchParams<{
    folderId?: string;
    folderName?: string;
    deleted?: string;
  }>();
  const folderId = typeof params.folderId === "string" ? params.folderId : null;
  const deleted = params.deleted === "true";
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [showFolderInput, setShowFolderInput] = useState(false);

  const load = useCallback(async () => {
    if (!workspace?.id) return;
    try {
      await notesApi.flushOfflineMutations();
      const [nextNotes, nextFolders] = await Promise.all([
        notesApi.list(workspace.id, {
          folderId: deleted ? null : folderId,
          includeDeleted: deleted,
        }),
        deleted
          ? Promise.resolve([])
          : notesApi.listFolders(workspace.id, folderId),
      ]);
      // A new note is intentionally blank until the user starts writing. It is
      // still a persisted draft and must be shown so it can be reopened later.
      const loadedNotes = Array.isArray(nextNotes) ? nextNotes : [];
      setNotes(loadedNotes);
      setFolders(Array.isArray(nextFolders) ? nextFolders : []);
    } catch (error) {
      console.warn("[Notes] Could not load notes", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [deleted, folderId, workspace?.id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const createNote = async () => {
    if (!workspace?.id) return;
    try {
      const note = await notesApi.create({
        workspaceId: workspace.id,
        folderId,
      });
      router.push({
        pathname: "/(app)/notes/[noteId]" as any,
        params: { noteId: note.id },
      } as any);
    } catch {
      Alert.alert("Could not create note", "Please try again.");
    }
  };

  const createFolder = () => {
    if (!workspace?.id) return;
    if (Platform.OS === "ios" && Alert.prompt) {
      Alert.prompt("New folder", "Name this folder", async (name) => {
        if (!name?.trim()) return;
        try {
          await notesApi.createFolder({
            workspaceId: workspace.id,
            parentId: folderId,
            name: name.trim(),
          });
          void load();
        } catch {
          Alert.alert("Could not create folder", "Please try again.");
        }
      });
      return;
    }
    setShowFolderInput(true);
  };
  const submitFolder = async () => {
    if (!workspace?.id || !folderName.trim()) return;
    try {
      await notesApi.createFolder({
        workspaceId: workspace.id,
        parentId: folderId,
        name: folderName.trim(),
      });
      setFolderName("");
      setShowFolderInput(false);
      void load();
    } catch {
      Alert.alert("Could not create folder", "Please try again.");
    }
  };

  const pinned = notes.filter((note) => note.isPinned);
  const recent = notes.filter((note) => !note.isPinned);
  const rows = [
    ...(folders.length
      ? [{ type: "section", id: "folders", title: "Folders" } as const]
      : []),
    ...folders.map((folder) => ({
      type: "folder" as const,
      id: folder.id,
      folder,
    })),
    ...(pinned.length
      ? [
          {
            type: "noteGroup" as const,
            id: "pinned",
            title: "Pinned",
            notes: pinned,
          },
        ]
      : []),
    ...(recent.length
      ? [
          {
            type: "noteGroup" as const,
            id: "recent",
            title: "Recents",
            notes: recent,
          },
        ]
      : []),
  ];

  return (
    <View className="flex-1 bg-background">
      {folderId || deleted ? (
        <View className="flex-row items-center justify-between px-4 pb-3 pt-5">
          <View className="flex-1 flex-row items-center">
            {folderId || deleted ? (
              <Pressable
                className="mr-2 rounded-full p-1"
                onPress={() => router.back()}
              >
                <ChevronLeft size={23} color={T.text} />
              </Pressable>
            ) : null}
            <View>
              <Text className="text-xl font-semibold text-foreground">
                {deleted ? "Recently Deleted" : params.folderName || "Folder"}
              </Text>
            </View>
          </View>
          <View className="flex-row gap-2">
            {!deleted ? (
              <Pressable
                accessibilityLabel="New note"
                className="rounded-full bg-primary p-3"
                onPress={() => void createNote()}
              >
                <Plus size={19} color="#141313" />
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      {!deleted && showFolderInput ? (
        <View className="mx-4 mb-3 flex-row items-center rounded-xl bg-card px-3">
          <TextInput
            autoFocus
            value={folderName}
            onChangeText={setFolderName}
            onSubmitEditing={() => void submitFolder()}
            placeholder="Folder name"
            placeholderTextColor={T.placeholder}
            className="flex-1 py-3 text-foreground"
          />
          <Pressable onPress={() => void submitFolder()}>
            <Text className="font-semibold text-primary">Create</Text>
          </Pressable>
        </View>
      ) : null}
      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={T.primary} />
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
              tintColor={T.primary}
            />
          }
          contentContainerStyle={{
            paddingHorizontal: 29,
            paddingTop: folderId || deleted ? 0 : 30,
            paddingBottom: 78,
            flexGrow: rows.length ? undefined : 1,
          }}
          ListEmptyComponent={
            <View className="flex-1 items-center justify-center py-24">
              <FileText size={34} color={T.secondaryText} />
              <Text className="mt-4 text-base text-foreground">
                No notes yet
              </Text>
              <Text className="mt-1 text-sm text-muted-foreground">
                Tap + to capture an idea.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            if (item.type === "section")
              return <Text style={styles.sectionTitle}>{item.title}</Text>;
            if (item.type === "folder")
              return (
                <Pressable
                  className="mb-2 flex-row items-center rounded-lg bg-card px-3 py-3"
                  onPress={() =>
                    router.push({
                      pathname: "/(app)/notes" as any,
                      params: {
                        folderId: item.folder.id,
                        folderName: item.folder.name,
                      },
                    } as any)
                  }
                >
                  <Folder size={20} color={T.secondaryText} />
                  <Text className="ml-3 flex-1 text-[15px] text-foreground">
                    {item.folder.name}
                  </Text>
                  <ChevronRight size={17} color={T.secondaryText} />
                </Pressable>
              );
            return (
              <View
                style={[
                  styles.noteSection,
                  item.id === "recent" ? styles.noteSectionSpaced : null,
                ]}
              >
                <Text style={styles.sectionTitle}>{item.title}</Text>
                <View style={styles.noteGroupCard}>
                  {item.notes.map((note, index) => {
                    const open = () =>
                      deleted
                        ? Alert.alert("Deleted note", "Restore this note?", [
                            {
                              text: "Restore",
                              onPress: () => {
                                void notesApi
                                  .restore(note.id)
                                  .then(() => load());
                              },
                            },
                            {
                              text: "Delete permanently",
                              style: "destructive",
                              onPress: () => {
                                void notesApi
                                  .permanentlyDelete(note.id)
                                  .then(() => load());
                              },
                            },
                            { text: "Cancel", style: "cancel" },
                          ])
                        : router.push({
                            pathname: "/(app)/notes/[noteId]" as any,
                            params: { noteId: note.id },
                          } as any);
                    return (
                      <Pressable
                        key={note.id}
                        style={[
                          styles.noteEntry,
                          index > 0 ? styles.noteEntrySpaced : null,
                        ]}
                        onPress={open}
                      >
                        <Text numberOfLines={1} style={styles.noteTitle}>
                          {note.title.trim() || "Untitled"}
                        </Text>
                        <Text style={styles.noteDate}>
                          {formatNoteUpdatedAt(note.updatedAt)}
                        </Text>
                        <Text numberOfLines={3} style={styles.notePreview}>
                          {note.preview || "No text"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          }}
        />
      )}
      {!deleted && !folderId ? (
        <View style={styles.searchDock}>
          <Pressable
            accessibilityLabel="Search notes"
            style={styles.searchButton}
            onPress={() => router.push("/(app)/notes/search" as any)}
          >
            <View style={styles.searchIconBox}>
              <NotesSearchIcon size={24} color={T.text} />
            </View>
            <Text style={styles.searchLabel}>Search</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="New note"
            style={styles.newNoteButton}
            onPress={() => void createNote()}
          >
            <NotesCreateIcon />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = {
  noteSection: {
    marginTop: 0,
  },
  noteSectionSpaced: {
    marginTop: 23,
  },
  sectionTitle: {
    marginBottom: 15,
    color: T.secondaryText,
    fontFamily: "Poppins",
    fontSize: 16,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  noteGroupCard: {
    borderRadius: 12,
    backgroundColor: T.card,
    overflow: "hidden" as const,
  },
  noteEntry: {
    height: 116,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  noteEntrySpaced: {
    borderTopWidth: 1,
    borderTopColor: T.border,
  },
  noteTitle: {
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 16,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  noteDate: {
    marginTop: 4,
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 12,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  notePreview: {
    marginTop: 4,
    color: T.secondaryText,
    fontFamily: "Poppins",
    fontSize: 12,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  searchDock: {
    position: "absolute" as const,
    bottom: 64,
    left: 30,
    right: 30,
    height: 56,
    flexDirection: "row" as const,
    alignItems: "center" as const,
  },
  searchButton: {
    height: 56,
    flex: 1,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    borderRadius: 28,
    backgroundColor: T.elevated,
    padding: 4,
  },
  searchIconBox: {
    width: 36,
    height: 48,
    paddingLeft: 12,
    alignItems: "flex-start" as const,
    justifyContent: "center" as const,
  },
  searchLabel: {
    marginLeft: 8,
    color: T.secondaryText,
    fontFamily: "Poppins",
    fontSize: 16,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  newNoteButton: {
    marginLeft: 8,
    height: 56,
    width: 56,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: 28,
    backgroundColor: T.primary,
  },
} as const;
