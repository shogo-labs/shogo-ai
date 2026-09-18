// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { Folder, Plus } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProjectCollection } from "../../contexts/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { notesApi } from "../../lib/notes-api";
import { NativePhoneSheet } from "../phone/NativePhoneSheet";
import { NOTES_DESIGN_TOKENS as T } from "./notes-design-tokens";

type Destination = {
  projectId?: string;
  newProjectName?: string;
  name: string;
};

export function NotesDestinationSheet({
  noteId,
  noteTitle,
  visible,
  onClose,
  onSaved,
}: {
  noteId: string;
  noteTitle: string;
  visible: boolean;
  onClose: () => void;
  onSaved: (taskId: string) => void;
}) {
  const projects = useProjectCollection();
  const workspace = useActiveWorkspace() as { id: string } | null;
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [confirmation, setConfirmation] = useState<Destination | null>(null);
  const [saving, setSaving] = useState(false);
  const allProjects = useMemo(
    () =>
      (projects?.all || []).filter(
        (project: any) =>
          !workspace?.id || project.workspaceId === workspace.id,
      ),
    [projects?.all, workspace?.id],
  );
  const pinned = allProjects.filter(
    (project: any) => project.isPinned || project.pinned,
  );
  const recent = allProjects.filter(
    (project: any) =>
      !pinned.some((candidate: any) => candidate.id === project.id),
  );
  // The reference is a 402 × 874 frame with a 68%-tall sheet. NativePhoneSheet
  // owns the safe-area padding, so the content reserves that space explicitly.
  const sheetContentHeight = Math.max(
    420,
    Math.round(height * 0.68) - Math.max(insets.bottom, 20),
  );

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };
  const reset = () => {
    setConfirmation(null);
    setNewProjectOpen(false);
    setNewProjectName("");
  };
  const choose = (project: any) =>
    setConfirmation({ projectId: project.id, name: project.name });
  const chooseNew = () => {
    const name = newProjectName.trim();
    if (!name) {
      setNewProjectOpen(true);
      return;
    }
    setConfirmation({ newProjectName: name, name });
  };
  const save = async () => {
    if (!confirmation || !workspace?.id) return;
    setSaving(true);
    try {
      const note = await notesApi.get(noteId);
      const result = await notesApi.convertToTask(noteId, {
        ...(confirmation.projectId
          ? { projectId: confirmation.projectId }
          : { newProjectName: confirmation.newProjectName }),
        expectedNoteVersion: note.version,
        idempotencyKey: `${noteId}:${note.version}:${confirmation.projectId || confirmation.newProjectName}`,
      });
      // `close` intentionally ignores user dismissals while saving. Complete
      // the successful flow explicitly so the sheet cannot remain mounted.
      reset();
      onClose();
      onSaved(result.task.id);
    } catch {
      Alert.alert(
        "Could not create task",
        "Your note was not changed. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const projectRow = (project: any) => (
    <Pressable
      key={project.id}
      accessibilityRole="button"
      style={styles.projectRow}
      onPress={() => choose(project)}
    >
      <View style={styles.projectLeading}>
        <View style={styles.projectIcon}>
          <Folder size={20} color={T.text} strokeWidth={1.35} />
        </View>
        <Text numberOfLines={1} style={styles.projectName}>
          {project.name}
        </Text>
      </View>
      <Text style={styles.projectCount}>
        {Number(project.taskCount || project.tasksCount || 0)}
      </Text>
    </Pressable>
  );

  return (
    <NativePhoneSheet
      visible={visible}
      onClose={close}
      animationType="slide"
      grabber={<View style={styles.handle} />}
      bordered={false}
      draggable
      dragBehavior="dismiss"
      maxHeightRatio={0.68}
      testID="notes-destination-sheet"
    >
      <View style={[styles.sheet, { height: sheetContentHeight }]}>
        <View style={styles.sheetTitle}>
          <Text style={styles.title}>Select Destination Project</Text>
        </View>
        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        >
          {pinned.length ? (
            <Section label="Pinned">{pinned.map(projectRow)}</Section>
          ) : null}
          <Section label="Recent Projects">
            {recent.map(projectRow)}
            {!allProjects.length ? (
              <Text style={styles.empty}>No projects yet</Text>
            ) : null}
          </Section>
        </ScrollView>
        <View style={styles.createArea}>
          {newProjectOpen ? (
            <TextInput
              autoFocus
              value={newProjectName}
              onChangeText={setNewProjectName}
              onSubmitEditing={chooseNew}
              placeholder="New project name"
              placeholderTextColor={T.placeholder}
              style={styles.newProjectInput}
            />
          ) : null}
          <Pressable
            accessibilityRole="button"
            style={styles.createRow}
            onPress={chooseNew}
          >
            <View style={styles.projectIcon}>
              <Plus size={22} color={T.text} strokeWidth={1.35} />
            </View>
            <Text style={styles.createText}>Create New Project</Text>
          </Pressable>
        </View>
        {confirmation ? (
          <View style={styles.confirmationLayer}>
            <Pressable
              style={styles.confirmationDismiss}
              onPress={() => !saving && setConfirmation(null)}
            />
            <View style={styles.confirmation}>
              <Text style={styles.confirmationText}>
                Create ‘{noteTitle.trim() || "Untitled"}’ task in ‘
                {confirmation.name}’?
              </Text>
              <View style={styles.confirmationActions}>
                <Pressable
                  disabled={saving}
                  style={styles.cancelAction}
                  onPress={() => setConfirmation(null)}
                >
                  <Text style={styles.confirmationActionText}>Cancel</Text>
                </Pressable>
                <Pressable
                  disabled={saving}
                  style={styles.saveAction}
                  onPress={() => void save()}
                >
                  {saving ? (
                    <ActivityIndicator color={T.background} />
                  ) : (
                    <Text style={styles.saveActionText}>Create</Text>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}
      </View>
    </NativePhoneSheet>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = {
  sheet: { backgroundColor: "#201f1f", overflow: "hidden" as const },
  handle: {
    width: 100,
    height: 7,
    borderRadius: 99,
    backgroundColor: T.elevated,
    alignSelf: "center" as const,
    marginTop: 12,
  },
  sheetTitle: {
    height: 48,
    marginTop: 11,
    borderBottomWidth: 1,
    borderBottomColor: T.border,
    justifyContent: "center" as const,
    paddingHorizontal: 25,
  },
  title: {
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 16,
    lineHeight: 16,
    fontWeight: "400" as const,
  },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: 24,
    paddingTop: 29,
    paddingBottom: 12,
    gap: 24,
  },
  section: { gap: 8 },
  sectionLabel: {
    color: T.secondaryText,
    fontFamily: "Poppins",
    fontSize: 16,
    lineHeight: 16,
    fontWeight: "400" as const,
  },
  projectRow: {
    height: 48,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "space-between" as const,
  },
  projectLeading: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row" as const,
    alignItems: "center" as const,
  },
  projectIcon: {
    height: 48,
    width: 48,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  },
  projectName: {
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 14,
    lineHeight: 16,
    fontWeight: "400" as const,
  },
  projectCount: {
    color: "#969696",
    fontFamily: "Poppins",
    fontSize: 14,
    lineHeight: 16,
    fontWeight: "400" as const,
  },
  empty: {
    paddingVertical: 16,
    color: T.secondaryText,
    fontFamily: "Poppins",
    fontSize: 14,
  },
  createArea: { paddingHorizontal: 24, paddingBottom: 20 },
  newProjectInput: {
    height: 44,
    marginHorizontal: 18,
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 14,
    borderBottomColor: T.elevated,
    borderBottomWidth: 1,
  },
  createRow: {
    height: 48,
    borderWidth: 1,
    borderColor: T.border,
    borderRadius: 1000,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    paddingHorizontal: 6,
  },
  createText: {
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 14,
    lineHeight: 16,
    fontWeight: "400" as const,
  },
  confirmationLayer: {
    ...{
      position: "absolute" as const,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      justifyContent: "flex-end" as const,
    },
  },
  confirmationDismiss: {
    ...{
      position: "absolute" as const,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0,0,0,0.24)",
    },
  },
  confirmation: {
    marginHorizontal: 24,
    marginBottom: 24,
    borderRadius: 12,
    backgroundColor: "#201f1f",
    padding: 20,
    shadowColor: "#000000",
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  confirmationText: {
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 14,
    lineHeight: 16,
    fontWeight: "400" as const,
  },
  confirmationActions: {
    height: 48,
    marginTop: 24,
    flexDirection: "row" as const,
    gap: 8,
  },
  cancelAction: {
    width: 153,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderWidth: 1,
    borderColor: T.border,
    borderRadius: 1000,
  },
  confirmationActionText: {
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 14,
    lineHeight: 16,
  },
  saveAction: {
    flex: 1,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: 1000,
    backgroundColor: T.primary,
  },
  saveActionText: {
    color: T.background,
    fontFamily: "Poppins",
    fontSize: 16,
    lineHeight: 16,
    fontWeight: "400" as const,
  },
} as const;
