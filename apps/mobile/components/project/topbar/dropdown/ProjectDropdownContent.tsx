// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React, { useCallback, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { X } from "lucide-react-native";
import { useRouter } from "expo-router";
import type { UsageWindows } from "@shogo/shared-app/hooks";
import type { UsageOverageContext } from "../../../../lib/billing-config";
import { api } from "../../../../lib/api";
import { NATIVE_PHONE_SHEET_FADE_MS } from "../../../../lib/native-phone-layout";
import { NativePhoneSheet } from "../../../phone/NativePhoneSheet";
import { ProjectExportModal } from "../../ProjectExportModal";
import { NativeCircleButton } from "../native/NativeCircleButton";
import type { ProjectSwitcherItem, TopBarOverlayState } from "../types";
import { ProjectDetailsModal } from "./ProjectDetailsModal";
import { ProjectMenuView } from "./ProjectMenuView";
import { ProjectSwitcherView } from "./ProjectSwitcherView";
import { MoveToFolderModal } from "./MoveToFolderModal";
import { RenameProjectModal } from "./RenameProjectModal";

type DropdownView = "menu" | "switcher";

export interface ProjectDropdownContentProps {
  projects: ProjectSwitcherItem[];
  currentProjectId: string;
  projectName: string;
  onSelect: (projectId: string) => void;
  onGoToDashboard: () => void;
  onClose: () => void;
  workspaceName: string;
  planLabel: string;
  usageWindows?: UsageWindows;
  usageOverage?: UsageOverageContext;
  ownerName: string;
  projectCreatedAt?: string | number;
  projectModifiedAt?: string | number;
  isStarred: boolean;
  onRenameProject?: (newName: string) => void;
  onToggleStar?: () => void;
  onMoveToFolder?: (folderId: string | null) => void;
  folders: { id: string; name: string }[];
  canvasThemeSupported?: boolean | null;
  variant?: "popover" | "sheet";
  overlayState: TopBarOverlayState;
}

export function ProjectDropdownContent({
  projects,
  currentProjectId,
  projectName,
  onSelect,
  onGoToDashboard,
  onClose,
  workspaceName,
  planLabel,
  usageWindows,
  usageOverage,
  ownerName,
  projectCreatedAt,
  projectModifiedAt,
  isStarred,
  onRenameProject,
  onToggleStar,
  onMoveToFolder,
  folders,
  canvasThemeSupported,
  variant = "popover",
  overlayState,
}: ProjectDropdownContentProps) {
  const [view, setView] = useState<DropdownView>("menu");
  const router = useRouter();
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const isSheet = variant === "sheet";

  const presentOverlay = useCallback(
    (open: () => void) => {
      if (!isSheet) {
        open();
        return;
      }
      onClose();
      setTimeout(open, NATIVE_PHONE_SHEET_FADE_MS);
    },
    [isSheet, onClose],
  );

  const runExport = useCallback(
    async (options: { includeChats: boolean; password?: string }) => {
      if (isExporting) return;
      setIsExporting(true);
      try {
        const { blob, filename } = await api.exportProjectBlob(
          currentProjectId,
          {
            includeChats: options.includeChats,
            password: options.password,
          },
        );

        if (Platform.OS === "web" && typeof document !== "undefined") {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else if (Platform.OS !== "web") {
          const { documentDirectory, writeAsStringAsync, EncodingType } =
            await import("expo-file-system/legacy");
          const Sharing = await import("expo-sharing");
          const dir = documentDirectory;
          if (!dir) throw new Error("Could not access app storage");
          const fileUri = `${dir}${filename}`;
          const arrayBuf = await blob.arrayBuffer();
          const bytes = new Uint8Array(arrayBuf);
          let binary = "";
          for (let i = 0; i < bytes.length; i++)
            binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          await writeAsStringAsync(fileUri, base64, {
            encoding: EncodingType.Base64,
          });
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/zip",
            UTI: "public.zip-archive" as any,
            dialogTitle: "Export Project",
          });
        }
        setShowExportModal(false);
        onClose();
      } catch (err: any) {
        console.error("[ProjectTopBar] Export failed:", err);
        setShowExportModal(false);
        if (Platform.OS !== "web") {
          const { Alert } = await import("react-native");
          Alert.alert(
            "Export Failed",
            err.message || "Failed to export project",
          );
        } else if (typeof window !== "undefined") {
          window.alert(
            `Export Failed: ${err?.message || "Failed to export project"}`,
          );
        }
      } finally {
        setIsExporting(false);
      }
    },
    [currentProjectId, isExporting, onClose],
  );

  const menu = (
    <ProjectMenuView
      projectId={currentProjectId}
      projectName={projectName}
      workspaceName={workspaceName}
      planLabel={planLabel}
      usageWindows={usageWindows}
      usageOverage={usageOverage}
      onGoToDashboard={onGoToDashboard}
      onSwitchProject={() => setView("switcher")}
      onClose={onClose}
      router={router}
      ownerName={ownerName}
      projectCreatedAt={projectCreatedAt}
      projectModifiedAt={projectModifiedAt}
      isStarred={isStarred}
      onRenameProject={onRenameProject}
      onToggleStar={onToggleStar}
      onMoveToFolder={onMoveToFolder}
      folders={folders}
      canvasThemeSupported={canvasThemeSupported}
      variant={variant}
      isExporting={isExporting}
      onRequestRename={() => presentOverlay(() => setShowRenameModal(true))}
      onRequestExport={() => presentOverlay(() => setShowExportModal(true))}
      onRequestDetails={() => presentOverlay(() => setShowDetailsModal(true))}
      onRequestMove={() => presentOverlay(() => setShowMoveModal(true))}
    />
  );

  const body =
    view === "switcher" ? (
      <ProjectSwitcherView
        projects={projects}
        currentProjectId={currentProjectId}
        onSelect={onSelect}
        onGoToDashboard={onGoToDashboard}
        onBack={() => setView("menu")}
      />
    ) : (
      menu
    );

  const overlays = (
    <>
      <ProjectDetailsModal
        visible={showDetailsModal}
        onClose={() => setShowDetailsModal(false)}
        projectName={projectName}
        workspaceName={workspaceName}
        ownerName={ownerName}
        createdAt={projectCreatedAt}
        modifiedAt={projectModifiedAt}
      />
      <RenameProjectModal
        visible={showRenameModal}
        currentName={projectName}
        onClose={() => setShowRenameModal(false)}
        onRename={(newName) => {
          onRenameProject?.(newName);
          setShowRenameModal(false);
          onClose();
        }}
      />
      <MoveToFolderModal
        visible={showMoveModal}
        folders={folders}
        onClose={() => setShowMoveModal(false)}
        onMove={(folderId) => {
          onMoveToFolder?.(folderId);
          setShowMoveModal(false);
          onClose();
        }}
      />
      <ProjectExportModal
        open={showExportModal}
        onOpenChange={(o) => {
          if (!isExporting) setShowExportModal(o);
        }}
        isExporting={isExporting}
        onExport={runExport}
      />
    </>
  );

  if (isSheet) {
    return (
      <>
        <NativePhoneSheet
          visible={overlayState.showProjectSheet}
          onClose={onClose}
        >
          <View className="flex-row items-center px-4 pb-1">
            <NativeCircleButton
              icon={X}
              onPress={onClose}
              accessibilityLabel="Close"
            />
          </View>
          <ScrollView
            bounces={false}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            {body}
          </ScrollView>
        </NativePhoneSheet>
        {overlays}
      </>
    );
  }

  return (
    <>
      {body}
      {overlays}
    </>
  );
}
