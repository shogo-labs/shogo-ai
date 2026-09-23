// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import {
  useDomainActions,
  useProjectCollection,
} from "@shogo/shared-app/domain";
import { Text } from "./account-sheet-chrome";

export function ProjectSettingsContent({ projectId }: { projectId: string }) {
  const projects = useProjectCollection();
  const actions = useDomainActions();
  const project = projects.all.find((item: any) => item.id === projectId);
  const [name, setName] = useState(project?.name ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(project?.name ?? "");
  }, [project?.name]);

  const save = async () => {
    const nextName = name.trim();
    if (!nextName || nextName === project?.name) return;
    setSaving(true);
    try {
      await actions.updateProject(projectId, { name: nextName });
    } finally {
      setSaving(false);
    }
  };

  return (
    <View className="flex-1">
      <Text className="text-sm text-muted-foreground">
        Settings for this project only.
      </Text>

      <View className="mt-6">
        <Text className="mb-2 text-xs font-medium text-muted-foreground">
          PROJECT NAME
        </Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Project name"
          placeholderTextColor="#8a8a8f"
          className="rounded-xl border border-border bg-card px-3 py-3 text-sm text-foreground web:outline-none"
          style={
            {
              outlineWidth: 0,
              outlineStyle: "none",
              boxShadow: "none",
            } as any
          }
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save project name"
          disabled={saving || !name.trim() || name.trim() === project?.name}
          onPress={() => void save()}
          className="mt-3 self-start rounded-lg bg-primary px-4 py-2.5 disabled:opacity-50"
        >
          <Text className="text-sm font-medium text-primary-foreground">
            {saving ? "Saving…" : "Save changes"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
