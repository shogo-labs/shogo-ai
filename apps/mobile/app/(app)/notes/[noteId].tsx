// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { File } from "lucide-react-native";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import {
  deleteAsync,
  readAsStringAsync,
  EncodingType,
} from "expo-file-system/legacy";
import {
  RichNotesEditor,
  type RichNotesEditorHandle,
} from "../../../components/notes/RichNotesEditor";
import { useVoiceInput } from "../../../components/chat/useVoiceInput";
import {
  executeNativeAttachAction,
  type NativePickedAttachment,
} from "../../../lib/native-attachment-picker";
import {
  notesApi,
  type Note,
  type NoteAsset,
  type NoteNode,
} from "../../../lib/notes-api";
import { NOTES_DESIGN_TOKENS as T } from "../../../components/notes/notes-design-tokens";
import {
  NotesAddIcon,
  NotesBackIcon,
  NotesCameraIcon,
  NotesDeleteIcon,
  NotesDropdownIcon,
  NotesMicIcon,
  NotesPinIcon,
  NotesUnpinIcon,
} from "../../../components/notes/FigmaNotesIcons";
import { NotesDestinationSheet } from "../../../components/notes/NotesDestinationSheet";

const meaningful = (note: Note | null, text: string) =>
  Boolean(text.trim() || note?.assets?.length);

function imageAssetIds(node: NoteNode, ids = new Set<string>()): Set<string> {
  if (node.type === "image" && typeof node.attrs?.assetId === "string")
    ids.add(node.attrs.assetId);
  node.content?.forEach((child) => imageAssetIds(child, ids));
  return ids;
}

function documentWithImageAssets(
  document: NoteNode,
  assets: NoteAsset[],
): NoteNode {
  const existing = imageAssetIds(document);
  const missing = assets.filter(
    (asset) => asset.kind === "image" && !existing.has(asset.id),
  );
  if (!missing.length) return document;
  return {
    ...document,
    content: [
      ...(document.content || [{ type: "paragraph" }]),
      ...missing.map((asset) => ({
        type: "image",
        attrs: { assetId: asset.id },
      })),
    ],
  };
}

async function previewUrls(
  assets: NoteAsset[],
): Promise<Record<string, string>> {
  const resolved = await Promise.all(
    assets
      .filter((asset) => asset.kind === "image")
      .map(async (asset) => {
        try {
          return [
            asset.id,
            await notesApi.getAssetPreviewUrl(asset.id),
          ] as const;
        } catch {
          return null;
        }
      }),
  );
  return Object.fromEntries(
    resolved.filter((entry): entry is readonly [string, string] =>
      Boolean(entry),
    ),
  );
}

export default function NoteEditorScreen() {
  const router = useRouter();
  const { noteId } = useLocalSearchParams<{ noteId: string }>();
  const fallbackRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const fallbackRecorderState = useAudioRecorderState(fallbackRecorder);
  const editorRef = useRef<RichNotesEditorHandle>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [document, setDocument] = useState<NoteNode>({
    type: "doc",
    content: [{ type: "paragraph" }],
  });
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [activeMenu, setActiveMenu] = useState<"format" | "size" | null>(null);
  const [fontSize, setFontSize] = useState("16");
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [editorHydrationKey, setEditorHydrationKey] = useState(0);
  const lastSavedSignature = useRef<string | null>(null);
  const noteRef = useRef<Note | null>(null);
  const saveInFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let active = true;
    void notesApi
      .get(noteId)
      .then(async (value) => {
        if (!active) return;
        const nextDocument = documentWithImageAssets(
          value.contentJson,
          value.assets || [],
        );
        lastSavedSignature.current = JSON.stringify({
          title: value.title,
          document: nextDocument,
          text: value.plainText,
          pinned: value.isPinned,
        });
        setNote(value);
        setTitle(value.title);
        setDocument(nextDocument);
        setText(value.plainText);
        setEditorHydrationKey((key) => key + 1);
        const urls = await previewUrls(value.assets || []);
        if (active) setAssetUrls(urls);
      })
      .catch(() => Alert.alert("Could not open note"))
      .finally(() => setLoading(false));
    return () => {
      active = false;
    };
  }, [noteId]);
  useEffect(() => {
    noteRef.current = note;
  }, [note]);
  useEffect(() => {
    const showSubscription = Keyboard.addListener("keyboardWillShow", () =>
      setKeyboardVisible(true),
    );
    const hideSubscription = Keyboard.addListener("keyboardWillHide", () =>
      setKeyboardVisible(false),
    );
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);
  useEffect(
    () => () => {
      // Dictation recordings are deliberately ephemeral. Do not leave the
      // microphone active if the user navigates away mid-recording.
      if (fallbackRecorder.getStatus().isRecording)
        void fallbackRecorder.stop().catch(() => {});
    },
    [fallbackRecorder],
  );
  const dismissKeyboard = () => {
    Keyboard.dismiss();
    editorRef.current?.blur();
  };
  const voiceInput = useVoiceInput({
    onTranscript: (transcript) =>
      editorRef.current?.command("insertTranscript", transcript),
  });
  useEffect(() => {
    if (!voiceInput.error) return;
    Alert.alert("Voice-to-text", voiceInput.error);
    voiceInput.clearError();
  }, [voiceInput.error]);
  const fallbackDictation = async () => {
    if (!note || transcribing) return;
    if (!fallbackRecorderState.isRecording) {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Microphone access needed",
          "Allow microphone access to dictate into your note.",
        );
        return;
      }
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
      await fallbackRecorder.prepareToRecordAsync();
      fallbackRecorder.record();
      return;
    }
    await fallbackRecorder.stop();
    const sourceUri = fallbackRecorder.uri;
    if (!sourceUri) return;
    setTranscribing(true);
    try {
      const base64 = await readAsStringAsync(sourceUri, {
        encoding: EncodingType.Base64,
      });
      const result = await notesApi.transcribeAudio(note.id, {
        dataUrl: `data:audio/mp4;base64,${base64}`,
      });
      if (result.text)
        editorRef.current?.command("insertTranscript", result.text);
      else
        Alert.alert(
          "No speech detected",
          "Try speaking a little closer to the microphone.",
        );
    } catch {
      Alert.alert(
        "Transcription failed",
        "We could not transcribe this recording. Please try again.",
      );
    } finally {
      await deleteAsync(sourceUri, { idempotent: true }).catch(() => {});
      setTranscribing(false);
    }
  };
  const save = useCallback(async () => {
    if (saveInFlight.current) {
      await saveInFlight.current;
      return;
    }
    const currentNote = noteRef.current;
    if (!currentNote) return;
    const signature = JSON.stringify({
      title,
      document,
      text,
      pinned: currentNote.isPinned,
    });
    if (signature === lastSavedSignature.current) return;
    const request = (async () => {
      try {
        const updated = await notesApi.update(currentNote.id, {
          expectedVersion: currentNote.version,
          title,
          contentJson: document,
          plainText: text,
          isPinned: currentNote.isPinned,
        });
        lastSavedSignature.current = signature;
        noteRef.current = updated;
        setNote(updated);
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error &&
          "status" in error &&
          (error as { status?: number }).status === 409
        )
          Alert.alert(
            "Note changed elsewhere",
            "Your local changes were kept. Reopen this note to resolve the conflict.",
          );
        else console.warn("[Notes] save failed", error);
      }
    })();
    saveInFlight.current = request;
    try {
      await request;
    } finally {
      if (saveInFlight.current === request) saveInFlight.current = null;
    }
  }, [document, text, title]);
  const draftSignature = JSON.stringify({
    title,
    document,
    text,
    pinned: note?.isPinned,
  });
  useEffect(() => {
    if (!note || loading || draftSignature === lastSavedSignature.current)
      return;
    const timer = setTimeout(() => {
      void save();
    }, 800);
    return () => clearTimeout(timer);
  }, [draftSignature, loading, note, save]);

  // The transcription job is asynchronous. Refresh its status while this note
  // is open so the completed voice-to-text result appears without reopening it.
  const pendingAudioSignature = (note?.assets || [])
    .filter(
      (asset) =>
        asset.kind === "audio" &&
        ["queued", "processing"].includes(asset.transcriptionStatus || ""),
    )
    .map((asset) => `${asset.id}:${asset.transcriptionStatus}`)
    .join(",");
  useEffect(() => {
    if (!note || !pendingAudioSignature) return;
    let active = true;
    const refresh = async () => {
      try {
        const updated = await notesApi.get(note.id);
        if (active) setNote(updated);
      } catch {
        /* The next poll will retry. */
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [note?.id, pendingAudioSignature]);

  const handleFiles = async (files: NativePickedAttachment[]) => {
    if (!note) return;
    setUploading(true);
    try {
      const uploaded: NoteAsset[] = [];
      for (const file of files) {
        const kind: NoteAsset["kind"] = file.type.startsWith("image/")
          ? "image"
          : file.type.startsWith("audio/")
            ? "audio"
            : "file";
        uploaded.push(
          await notesApi.uploadAsset(note.id, {
            dataUrl: file.dataUrl,
            originalName: file.name,
            mimeType: file.type,
            kind,
          }),
        );
      }
      const updated = await notesApi.get(note.id);
      const nextDocument = documentWithImageAssets(
        document,
        updated.assets || [],
      );
      const urls = await previewUrls(updated.assets || []);
      setNote(updated);
      setAssetUrls(urls);
      setDocument(nextDocument);
      for (const asset of uploaded.filter((item) => item.kind === "image")) {
        const url = urls[asset.id];
        if (url)
          editorRef.current?.command(
            "insertImage",
            JSON.stringify({
              assetId: asset.id,
              url,
              name: asset.originalName,
            }),
          );
      }
    } catch (error) {
      Alert.alert(
        "Attachment failed",
        "The note was kept. Try uploading this attachment again.",
      );
    } finally {
      setUploading(false);
    }
  };
  const pick = (action: "library" | "camera" | "documents") =>
    executeNativeAttachAction(action, {
      currentCount: note?.assets?.length || 0,
      maxFiles: 20,
      maxFileSizeBytes:
        action === "documents" ? 25 * 1024 * 1024 : 10 * 1024 * 1024,
      onFiles: (files) => {
        void handleFiles(files);
      },
      onError: (message) => Alert.alert("Attachment", message),
    });
  const flushSave = async () => {
    // The first call may wait for a previous autosave. The second persists
    // edits made while that request was in flight with its new version.
    await save();
    await save();
  };
  const back = async () => {
    await flushSave();
    router.back();
  };
  const deleteNote = () => {
    if (!note) return;
    Alert.alert("Delete note?", "This note will move to Recently Deleted.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              // Flush the current draft before its recoverable deletion, so a
              // restored note never loses the user’s most recent edits.
              await flushSave();
              await notesApi.remove(note.id);
              router.back();
            } catch {
              Alert.alert(
                "Could not delete note",
                "Your note is still available. Please try again.",
              );
            }
          })();
        },
      },
    ]);
  };
  const applyEditorCommand = (command: string, value?: string) => {
    editorRef.current?.command(command, value);
    // The command briefly focuses the WebView to retain the text selection;
    // immediately blur it again so choosing a toolbar option never reopens the keyboard.
    dismissKeyboard();
    setActiveMenu(null);
  };

  if (loading)
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={T.primary} />
      </View>
    );
  if (!note)
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <Text className="text-foreground">Note not found</Text>
      </View>
    );

  // The task action lives in its own lower section in the design, beneath the
  // editor controls. It is deliberately removed while the system keyboard is
  // present, leaving the formatting toolbar directly above the keyboard.
  const showConvertAction = meaningful(note, text) && !keyboardVisible;
  const bottomStackHeight = 50 + (showConvertAction ? 88 : 0);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.header}>
        <View style={styles.headerLeading}>
          <Pressable
            accessibilityLabel="Back"
            style={styles.iconButton}
            onPress={() => {
              dismissKeyboard();
              void back();
            }}
          >
            <NotesBackIcon size={24} color={T.text} />
          </Pressable>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Untitled"
            placeholderTextColor={T.placeholder}
            style={styles.titleInput}
            numberOfLines={1}
          />
        </View>
        <View style={styles.headerActions}>
          <Pressable
            accessibilityLabel={note.isPinned ? "Unpin note" : "Pin note"}
            style={styles.iconButton}
            onPress={() => {
              dismissKeyboard();
              setNote((current) =>
                current ? { ...current, isPinned: !current.isPinned } : current,
              );
            }}
          >
            {note.isPinned ? (
              <NotesUnpinIcon size={24} color={T.text} />
            ) : (
              <NotesPinIcon size={24} color={T.text} />
            )}
          </Pressable>
          <Pressable
            accessibilityLabel="Delete note"
            style={styles.iconButton}
            onPress={() => {
              dismissKeyboard();
              deleteNote();
            }}
          >
            <NotesDeleteIcon size={24} color={T.text} />
          </Pressable>
        </View>
      </View>
      <View style={styles.editorArea}>
        <RichNotesEditor
          key={`${noteId}:${editorHydrationKey}`}
          ref={editorRef}
          document={document}
          hydrationKey={`${noteId}:${editorHydrationKey}`}
          assetUrls={assetUrls}
          onChange={(next, nextText) => {
            setDocument(next);
            setText(nextText);
          }}
        />
        {note.assets
          ?.filter((asset) => asset.kind !== "image")
          .map((asset) => (
            <View key={asset.id} style={styles.assetRow}>
              <File size={18} color={T.secondaryText} />
              <View style={styles.assetDetails}>
                <Text numberOfLines={1} style={styles.assetName}>
                  {asset.originalName}
                </Text>
                {asset.kind === "audio" ? (
                  <Text numberOfLines={3} style={styles.transcriptText}>
                    {asset.transcriptionStatus === "available"
                      ? asset.transcriptText || "No speech detected."
                      : asset.transcriptionStatus === "failed"
                        ? "Transcription failed. Record again to retry."
                        : "Transcribing…"}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.assetType}>
                {asset.kind === "audio" ? "Audio file" : asset.kind}
              </Text>
            </View>
          ))}
        {uploading || transcribing ? (
          <View style={styles.uploading}>
            <ActivityIndicator size="small" color={T.primary} />
            <Text style={styles.uploadingText}>
              {transcribing ? "Transcribing…" : "Uploading…"}
            </Text>
          </View>
        ) : null}
      </View>
      {activeMenu ? (
        <Pressable
          accessibilityLabel="Close formatting menu"
          style={[styles.menuBackdrop, { bottom: bottomStackHeight }]}
          onPress={() => {
            dismissKeyboard();
            setActiveMenu(null);
          }}
        />
      ) : null}
      {activeMenu === "format" ? (
        <View
          style={[
            styles.editorMenu,
            styles.formatMenu,
            { bottom: bottomStackHeight + 6 },
          ]}
        >
          <Pressable
            style={styles.menuRow}
            onPress={() => {
              dismissKeyboard();
              applyEditorCommand("bold");
            }}
          >
            <Text style={styles.menuRowLabel}>Bold</Text>
            <Text style={styles.menuShortcut}>B</Text>
          </Pressable>
          <Pressable
            style={styles.menuRow}
            onPress={() => {
              dismissKeyboard();
              applyEditorCommand("italic");
            }}
          >
            <Text style={styles.menuRowLabel}>Italic</Text>
            <Text style={styles.menuShortcut}>I</Text>
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={styles.menuRow}
            onPress={() => {
              dismissKeyboard();
              applyEditorCommand("insertUnorderedList");
            }}
          >
            <Text style={styles.menuRowLabel}>Bulleted List</Text>
          </Pressable>
          <Pressable
            style={styles.menuRow}
            onPress={() => {
              dismissKeyboard();
              applyEditorCommand("insertOrderedList");
            }}
          >
            <Text style={styles.menuRowLabel}>Numbered List</Text>
          </Pressable>
          <View style={styles.menuDivider} />
          <Pressable
            style={styles.menuRow}
            onPress={() => {
              dismissKeyboard();
              applyEditorCommand("removeFormat");
            }}
          >
            <Text style={styles.menuRowLabel}>Clear Formatting</Text>
          </Pressable>
        </View>
      ) : null}
      {activeMenu === "size" ? (
        <View
          style={[
            styles.editorMenu,
            styles.sizeMenu,
            { bottom: bottomStackHeight + 6 },
          ]}
        >
          {["12", "14", "16", "18", "22"].map((size) => (
            <Pressable
              key={size}
              style={styles.menuRow}
              onPress={() => {
                dismissKeyboard();
                setFontSize(size);
                applyEditorCommand("setFontSize", size);
              }}
            >
              <Text style={[styles.menuRowLabel, { fontSize: Number(size) }]}>
                {size}
              </Text>
              {fontSize === size ? (
                <Text style={styles.menuCheck}>✓</Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.toolbar}>
        <Pressable
          accessibilityLabel="Take photo"
          style={styles.toolbarButton}
          onPress={() => {
            dismissKeyboard();
            pick("camera");
          }}
        >
          <NotesCameraIcon size={24} color={T.text} />
        </Pressable>
        <Pressable
          accessibilityLabel="Add attachment"
          style={styles.toolbarButton}
          onPress={() => {
            dismissKeyboard();
            Alert.alert("Add to note", "Choose an attachment", [
              { text: "Choose file", onPress: () => pick("documents") },
              { text: "Choose photo", onPress: () => pick("library") },
              { text: "Cancel", style: "cancel" },
            ]);
          }}
        >
          <NotesAddIcon size={24} color={T.text} />
        </Pressable>
        <Pressable
          accessibilityLabel="Format selected text"
          style={styles.toolbarButton}
          onPress={() => {
            dismissKeyboard();
            setActiveMenu((current) =>
              current === "format" ? null : "format",
            );
          }}
        >
          <Text style={styles.toolbarLabel}>Aa</Text>
          <NotesDropdownIcon size={24} color={T.text} />
        </Pressable>
        <Pressable
          accessibilityLabel="Font size"
          style={styles.toolbarButtonWide}
          onPress={() => {
            dismissKeyboard();
            setActiveMenu((current) => (current === "size" ? null : "size"));
          }}
        >
          <Text style={styles.toolbarLabel}>{fontSize}</Text>
          <NotesDropdownIcon size={24} color={T.text} />
        </Pressable>
        <Pressable
          disabled={transcribing}
          accessibilityLabel={
            voiceInput.isRecording || fallbackRecorderState.isRecording
              ? "Stop voice-to-text"
              : "Start voice-to-text"
          }
          style={styles.toolbarButton}
          onPress={() => {
            dismissKeyboard();
            void (voiceInput.canRecord
              ? voiceInput.toggleRecording()
              : fallbackDictation());
          }}
        >
          <NotesMicIcon
            size={24}
            color={
              voiceInput.isRecording || fallbackRecorderState.isRecording
                ? T.destructive
                : T.text
            }
          />
        </Pressable>
      </View>
      {showConvertAction ? (
        <View style={styles.convertDock}>
          <Pressable
            accessibilityRole="button"
            style={styles.convertButton}
            onPress={() => {
              dismissKeyboard();
              setDestinationOpen(true);
            }}
          >
            <Text style={styles.convertText}>Convert it to Task</Text>
          </Pressable>
        </View>
      ) : null}
      {voiceInput.isRecording || fallbackRecorderState.isRecording ? (
        <Text style={[styles.recordingText, { bottom: bottomStackHeight + 6 }]}>
          {voiceInput.liveTranscript ||
            "Listening… tap the microphone when you are done"}
        </Text>
      ) : null}
      <NotesDestinationSheet
        noteId={note.id}
        noteTitle={title}
        visible={destinationOpen}
        onClose={() => setDestinationOpen(false)}
        onSaved={(taskId) =>
          router.replace({
            pathname: "/(app)/activity" as any,
            params: { taskId },
          } as any)
        }
      />
    </KeyboardAvoidingView>
  );
}

const styles = {
  screen: { flex: 1, backgroundColor: T.background },
  header: {
    height: 49,
    marginTop: 19,
    borderBottomWidth: 1,
    borderBottomColor: T.border,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    paddingHorizontal: 9,
  },
  headerLeading: {
    flex: 1,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    minWidth: 0,
  },
  headerActions: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
  },
  iconButton: {
    width: 48,
    height: 48,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  titleInput: {
    flex: 1,
    minWidth: 0,
    height: 48,
    marginLeft: 8,
    padding: 0,
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 20,
    lineHeight: 24,
    textAlignVertical: "center" as const,
    fontWeight: "400" as const,
  },
  editorArea: { flex: 1, paddingHorizontal: 24, paddingTop: 14 },
  assetRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    backgroundColor: T.card,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
  },
  assetDetails: { flex: 1, minWidth: 0, marginLeft: 8 },
  assetName: { color: T.text, fontSize: 14 },
  assetType: { color: T.secondaryText, fontSize: 12 },
  transcriptText: {
    color: T.secondaryText,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  uploading: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    marginTop: 8,
  },
  uploadingText: { marginLeft: 8, color: T.secondaryText, fontSize: 13 },
  convertDock: {
    height: 88,
    paddingHorizontal: 24,
    paddingVertical: 20,
    backgroundColor: T.background,
  },
  convertButton: {
    height: 48,
    borderRadius: 1000,
    backgroundColor: T.primary,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  convertText: {
    color: T.background,
    fontFamily: "Poppins",
    fontSize: 16,
    lineHeight: 16,
    fontWeight: "400" as const,
  },
  toolbar: {
    height: 50,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: T.border,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
    paddingHorizontal: 16,
  },
  toolbarButton: {
    height: 48,
    width: 48,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexDirection: "row" as const,
  },
  toolbarButtonWide: {
    height: 48,
    width: 64,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    flexDirection: "row" as const,
  },
  toolbarLabel: {
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 16,
    lineHeight: 16,
    fontWeight: "400" as const,
  },
  menuBackdrop: {
    position: "absolute" as const,
    top: 0,
    right: 0,
    bottom: 50,
    left: 0,
    zIndex: 4,
  },
  editorMenu: {
    position: "absolute" as const,
    zIndex: 5,
    backgroundColor: T.elevated,
    borderColor: T.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 6,
    shadowColor: "#000000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  formatMenu: { left: 72, width: 210 },
  sizeMenu: { right: 92, width: 132 },
  menuRow: {
    minHeight: 40,
    paddingHorizontal: 14,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
  },
  menuRowLabel: { color: T.text, fontSize: 16 },
  menuShortcut: {
    color: T.secondaryText,
    fontSize: 15,
    fontWeight: "600" as const,
  },
  menuCheck: { color: T.primary, fontSize: 18, fontWeight: "600" as const },
  menuDivider: { height: 1, marginVertical: 5, backgroundColor: T.border },
  recordingText: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    paddingVertical: 3,
    textAlign: "center" as const,
    color: T.destructive,
    backgroundColor: T.background,
    fontSize: 12,
  },
};
