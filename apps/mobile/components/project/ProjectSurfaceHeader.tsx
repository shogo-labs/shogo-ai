// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback } from "react";
import { useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { observer } from "mobx-react-lite";
import { useProjectCollection } from "../../contexts/domain";
import { isPhoneLayout } from "../../lib/native-phone-layout";
import { PhoneScreenHeader } from "../layout/PhoneScreenHeader";

/**
 * Back and the project's name above a standalone project surface (canvas,
 * files, plans). Reached from the project's tab bar, these have no project
 * header of their own, so without this the only way out was the drawer.
 *
 * It is the phone's floating glass header, so a surface opened from a project
 * looks like every other screen you go into.
 */
export const ProjectSurfaceHeader = observer(function ProjectSurfaceHeader({
  projectId,
  onHeight,
}: {
  projectId: string | undefined;
  /** Reports the measured height, so the surface can start below the glass. */
  onHeight?: (height: number) => void;
}) {
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const projects = useProjectCollection();
  const name = projects.all.find((project: any) => project.id === projectId)?.name;
  const leaveProject = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/(app)/home" as any);
  }, [router]);

  if (!isPhoneLayout(width, height)) return null;

  return (
    <PhoneScreenHeader
      testID="project-surface-header"
      backTestID="project-surface-back"
      title={name ?? "Project"}
      onBack={leaveProject}
      onLayout={onHeight ? (event) => onHeight(Math.round(event.nativeEvent.layout.height)) : undefined}
    />
  );
});
