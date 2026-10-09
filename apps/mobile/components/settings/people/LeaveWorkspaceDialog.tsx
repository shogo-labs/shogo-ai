// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Confirmation + handler for the current user leaving a workspace. Shared by
 * Settings > Workspace (danger zone) and Settings > People (your own row).
 */
import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { Text } from "../account-sheet-chrome";
import { useDomainHttp, useWorkspaceCollection } from "../../../contexts/domain";
import { api } from "../../../lib/api";
import { setActiveWorkspaceId } from "../../../lib/workspace-store";
import { ConfirmDialog } from "./ConfirmDialog";
import { getErrorMessage } from "./member-permissions";

export interface LeaveWorkspaceDialogProps {
  visible: boolean;
  workspaceId?: string;
  workspaceName?: string;
  onClose: () => void;
}

export function LeaveWorkspaceDialog({
  visible,
  workspaceId,
  workspaceName,
  onClose,
}: LeaveWorkspaceDialogProps) {
  const router = useRouter();
  const http = useDomainHttp();
  const workspaces = useWorkspaceCollection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setBusy(false);
      setError(null);
    }
  }, [visible]);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!workspaceId || !http) {
        setError("Missing workspace information.");
        setBusy(false);
        return;
      }
      await api.leaveWorkspace(http, workspaceId);
      await workspaces.loadAll();
      const remaining = Array.isArray(workspaces.all) ? workspaces.all : [];
      if (remaining.length > 0) {
        setActiveWorkspaceId((remaining[0] as any).id);
      }
      onClose();
      router.replace("/(app)/projects");
    } catch (err) {
      console.error("[Settings] Failed to leave workspace:", err);
      setError(getErrorMessage(err, "Failed to leave workspace."));
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      visible={visible}
      title="Leave workspace"
      confirmLabel="Leave workspace"
      busyLabel="Leaving..."
      busy={busy}
      error={error}
      onCancel={onClose}
      onConfirm={handleConfirm}
      testID="leave-workspace-dialog"
    >
      <Text className="text-sm text-muted-foreground">
        Are you sure you want to leave "{workspaceName}"? You will lose access
        to all projects and data in this workspace.
      </Text>
    </ConfirmDialog>
  );
}
