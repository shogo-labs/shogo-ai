// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Folder, Plus } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProjectCollection } from "../../contexts/domain";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { api, createHttpClient, type AgentTask } from "../../lib/api";
import { notesApi } from "../../lib/notes-api";
import { getPinnedProjectIds } from "../../lib/project-prefs-store";
import { NativePhoneSheet } from "../phone/NativePhoneSheet";
import { NOTES_DESIGN_TOKENS as T } from "./notes-design-tokens";

type Destination = {
  projectId: string;
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
  onSaved: (task: AgentTask) => void;
}) {
  const projects = useProjectCollection();
  const workspace = useActiveWorkspace() as { id: string } | null;
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [confirmation, setConfirmation] = useState<Destination | null>(null);
  const [saving, setSaving] = useState(false);
  const http = useMemo(() => createHttpClient(), []);
  const allProjects = useMemo(
    () =>
      (projects?.all || []).filter(
        (project: any) =>
          !workspace?.id || project.workspaceId === workspace.id,
      ),
    [projects?.all, workspace?.id],
  );
  // Project pins are a device-local preference, shared with the sidebar and
  // task picker. Projects themselves do not carry an `isPinned` field, so
  // checking the project model silently put every pinned project in Recents.
  const pinnedProjectIds = new Set(getPinnedProjectIds());
  const pinned = allProjects.filter((project: any) =>
    pinnedProjectIds.has(project.id),
  );
  const recent = allProjects.filter(
    (project: any) =>
      !pinned.some((candidate: any) => candidate.id === project.id),
  );
  // The reference is a 402 × 874 frame with a 68%-tall sheet. The panel also
  // contains its own grabber chrome and safe-area padding, neither of which is
  // part of this child view. Account for both so the persistent create action
  // is never clipped below the sheet viewport.
  const sheetContentHeight = Math.max(
    360,
    Math.round(height * 0.68) - Math.max(insets.bottom, 20) - 28,
  );

  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };
  const reset = () => {
    setConfirmation(null);
  };
  const choose = (project: any) =>
    setConfirmation({ projectId: project.id, name: project.name });
  const createNewProject = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // The note conversion endpoint creates the project and a note-backed
      // task transactionally. Starting that task then persists the note text
      // as the project chat prompt and forwards image attachments as files.
      const note = await notesApi.get(noteId);
      const result = await notesApi.convertToTask(noteId, {
        newProjectName: noteTitle.trim() || "New Project",
        expectedNoteVersion: note.version,
        idempotencyKey: `${noteId}:${note.version}:new-project`,
      });
      const startedTask = await api.startAgentTask(http, result.task.id);
      reset();
      onClose();
      onSaved(startedTask);
    } catch {
      Alert.alert(
        "Could not start new project agent",
        "The note was kept. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  };
  const save = async () => {
    if (!confirmation || !workspace?.id) return;
    setSaving(true);
    try {
      const note = await notesApi.get(noteId);
      const result = await notesApi.convertToTask(noteId, {
        projectId: confirmation.projectId,
        expectedNoteVersion: note.version,
        idempotencyKey: `${noteId}:${note.version}:${confirmation.projectId}`,
      });
      // Notes-derived tasks use the same project-agent path as the Task tab.
      // The server resolves the project's active chat before responding, so the
      // caller can open the live response immediately.
      const startedTask = await api.startAgentTask(http, result.task.id);
      // `close` intentionally ignores user dismissals while saving. Complete
      // the successful flow explicitly so the sheet cannot remain mounted.
      reset();
      onClose();
      onSaved(startedTask);
    } catch {
      Alert.alert(
        "Could not start project agent",
        "The note was kept. Please try again.",
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
        <View style={styles.createProjectFooter}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create New Project"
            style={styles.createProjectAction}
            onPress={() => void createNewProject()}
          >
            <Plus size={24} color={T.text} strokeWidth={1.5} />
            <Text style={styles.createProjectActionText}>Create New Project</Text>
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
  list: { flex: 1, minHeight: 0 },
  listContent: {
    paddingHorizontal: 24,
    paddingTop: 29,
    paddingBottom: 12,
    gap: 24,
  },
  createProjectFooter: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: T.border,
  },
  createProjectAction: {
    height: 48,
    borderWidth: 1,
    borderColor: T.border,
    borderRadius: 1000,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    gap: 12,
  },
  createProjectActionText: {
    color: T.text,
    fontFamily: "Poppins",
    fontSize: 16,
    lineHeight: 16,
    fontWeight: "400" as const,
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
  empty: {
    paddingVertical: 16,
    color: T.secondaryText,
    fontFamily: "Poppins",
    fontSize: 14,
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
