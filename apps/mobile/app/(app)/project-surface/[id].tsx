// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useLocalSearchParams } from "expo-router";
import {
  ProjectSurfaceView,
  type ProjectSurface,
} from "../../../components/project/ProjectSurfaceView";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function ProjectSurfaceScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    surface?: string | string[];
  }>();
  return (
    <ProjectSurfaceView
      projectId={firstParam(params.id)}
      surface={(firstParam(params.surface) ?? "canvas") as ProjectSurface}
    />
  );
}
