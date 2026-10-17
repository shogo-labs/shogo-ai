// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  View,
} from "react-native";
import { Building2 as Building2Icon, Check as CheckIcon, X as XIcon } from "lucide-react-native";
import {
  Text,
  TextInput,
  accountSheetIcon,
} from "../../settings/account-sheet-chrome";
import type { PooledWorkspaceParentOption } from "../../../hooks/pooledWorkspaceParent";

const X = accountSheetIcon(XIcon);
const Building2 = accountSheetIcon(Building2Icon);
const Check = accountSheetIcon(CheckIcon);

function ParentRow({
  option,
  selected,
  selectable,
  onPress,
}: {
  option: PooledWorkspaceParentOption;
  selected: boolean;
  selectable: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!selectable}
      accessibilityRole={selectable ? "radio" : undefined}
      accessibilityState={selectable ? { checked: selected } : undefined}
      accessibilityLabel={`${option.name || "Workspace"}, ${option.planLabel} plan`}
      className={`flex-row items-center gap-2.5 rounded-md border px-3 py-2 ${
        selected ? "border-primary bg-primary/5" : "border-border"
      }${selectable ? " active:bg-muted" : ""}`}
    >
      <Building2 size={16} className="text-muted-foreground" />
      <Text className="flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
        {option.name || "Untitled workspace"}
      </Text>
      <Text className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
        {option.planLabel}
      </Text>
      {selectable && selected && <Check size={14} className="text-primary" />}
    </Pressable>
  );
}

// ─── CreateWorkspaceModal ──────────────────────────────────────────────────────

export function CreateWorkspaceModal({
  visible,
  onClose,
  onSubmit,
  parent,
  parentOptions = [],
}: {
  visible: boolean;
  onClose: () => void;
  /** Resolving to `false` keeps the modal open so the typed name isn't lost. */
  onSubmit: (name: string, parentId?: string) => void | boolean | Promise<void | boolean>;
  /** Default parent for an included (child) workspace; omit for a standalone one. */
  parent?: PooledWorkspaceParentOption | null;
  /** Every workspace the new one could be included in; shown as a picker when > 1. */
  parentOptions?: PooledWorkspaceParentOption[];
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [parentId, setParentId] = useState<string | undefined>(parent?.id);

  useEffect(() => {
    if (visible) setParentId(parent?.id);
  }, [visible, parent?.id]);

  const options = parent
    ? parentOptions.some((option) => option.id === parent.id)
      ? parentOptions
      : [parent, ...parentOptions]
    : [];
  const selectedParent = options.find((option) => option.id === parentId) ?? parent ?? null;

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give your workspace a name to continue.");
      return;
    }
    setSubmitting(true);
    try {
      if ((await onSubmit(trimmed, selectedParent?.id)) === false) return;
    } finally {
      setSubmitting(false);
    }
    setName("");
    setError(null);
    onClose();
  }, [name, onSubmit, onClose, selectedParent?.id, submitting]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        className="flex-1 bg-black/50 items-center justify-center"
        onPress={onClose}
      >
        <Pressable
          className="bg-card rounded-xl p-6 w-80 border border-border"
          onPress={(e) => e.stopPropagation()}
        >
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-base font-semibold text-foreground">
              Create new workspace
            </Text>
            <Pressable onPress={onClose} className="p-1">
              <X size={20} className="text-muted-foreground" />
            </Pressable>
          </View>
          <Text className="text-sm text-muted-foreground mb-4">
            {selectedParent
              ? "Included at no extra cost in the workspace below."
              : "Create a new workspace for your team or projects"}
          </Text>
          {selectedParent && (
            <View className="mb-4">
              <Text className="text-sm font-medium text-foreground mb-1.5">
                {options.length > 1 ? "Include in" : "Part of"}
              </Text>
              <View className="gap-1.5">
                {(options.length > 1 ? options : [selectedParent]).map((option) => (
                  <ParentRow
                    key={option.id}
                    option={option}
                    selected={option.id === selectedParent.id}
                    selectable={options.length > 1}
                    onPress={() => setParentId(option.id)}
                  />
                ))}
              </View>
              <Text className="text-xs text-muted-foreground mt-1.5">
                Uses {selectedParent.name || "this workspace"}'s {selectedParent.planLabel} plan: its usage limits, billing, and seats.
              </Text>
            </View>
          )}
          <Text className="text-sm font-medium text-foreground mb-1.5">
            Workspace name
          </Text>
          <TextInput
            value={name}
            onChangeText={(t) => {
              setName(t);
              if (error) setError(null);
            }}
            placeholder="e.g. My Team, Acme Corp"
            placeholderTextColor="#9ca3af"
            className="border border-border rounded-md px-3 py-2 text-sm text-foreground bg-background"
            autoFocus={Platform.OS === "web"}
            onSubmitEditing={handleSubmit}
          />
          <Text className="text-xs text-muted-foreground mt-1.5 mb-3">
            You can rename it later in settings.
          </Text>
          {error && (
            <Text className="text-xs text-destructive mb-3">{error}</Text>
          )}
          <View className="flex-row gap-2 justify-end">
            <Pressable
              onPress={onClose}
              className="px-4 py-2 rounded-md border border-border active:bg-muted"
            >
              <Text className="text-sm text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSubmit}
              disabled={submitting}
              className={`px-4 py-2 rounded-md bg-primary active:bg-primary/80${submitting ? " opacity-60" : ""}`}
            >
              <Text className="text-sm text-primary-foreground">
                {submitting ? "Creating..." : "Create workspace"}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
