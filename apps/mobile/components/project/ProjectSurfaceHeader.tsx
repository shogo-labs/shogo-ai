// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { observer } from "mobx-react-lite";
import { ArrowLeft } from "lucide-react-native";
import { useProjectCollection } from "../../contexts/domain";
import { NATIVE_PHONE_CONTROL_SIZE } from "../../lib/native-phone-layout";
import { NativeCircleButton } from "./topbar/native/NativeCircleButton";

/**
 * Back and the project's name above a standalone project surface (canvas,
 * files, plans). Reached from the project's tab bar, these have no project
 * header of their own, so without this the only way out was the drawer.
 */
export const ProjectSurfaceHeader = observer(function ProjectSurfaceHeader({
  projectId,
}: {
  projectId: string | undefined;
}) {
  const router = useRouter();
  const projects = useProjectCollection();
  const name = projects.all.find((project: any) => project.id === projectId)?.name;
  const leaveProject = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/(app)/home" as any);
  }, [router]);

  return (
    <View
      testID="project-surface-header"
      className="flex-row items-center gap-3 bg-background px-3 pb-2 pt-1"
      style={{ minHeight: NATIVE_PHONE_CONTROL_SIZE + 12 }}
    >
      <NativeCircleButton
        icon={ArrowLeft}
        onPress={leaveProject}
        accessibilityLabel="Back"
        testID="project-surface-back"
      />
      <Text
        className="flex-1 text-[17px] font-semibold text-foreground"
        numberOfLines={1}
      >
        {name ?? "Project"}
      </Text>
    </View>
  );
});
