// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect, useState } from "react";
import { Text } from "../account-sheet-chrome";
import { ConfirmDialog } from "./ConfirmDialog";
import { getErrorMessage } from "./member-permissions";

export interface RemoveMemberDialogProps {
  /** `null` hides the dialog. */
  target: { id: string; name: string } | null;
  workspaceName: string;
  onCancel: () => void;
  /** Perform the removal. Throw to surface an error inline in the dialog. */
  onConfirm: (target: { id: string; name: string }) => Promise<void>;
}

export function RemoveMemberDialog({
  target,
  workspaceName,
  onCancel,
  onConfirm,
}: RemoveMemberDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start clean every time the dialog is opened for a (new) member.
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [target?.id]);

  const handleConfirm = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(target);
    } catch (err) {
      setError(getErrorMessage(err, "Failed to remove member. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      visible={target !== null}
      title={`Remove ${target?.name ?? "member"} from ${workspaceName || "this workspace"}?`}
      confirmLabel="Remove"
      busyLabel="Removing…"
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={handleConfirm}
      testID="remove-member-dialog"
    >
      <Text className="text-sm text-muted-foreground leading-5">
        They will lose access to this workspace's shared projects and data.
      </Text>
      <Text className="text-sm text-muted-foreground leading-5">
        Their seat is removed from billing, and they can be invited again later.
      </Text>
    </ConfirmDialog>
  );
}
