// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState } from "react";
import { useLocalSearchParams } from "expo-router";
import {
  ProjectSurfaceView,
  type ProjectSurface,
} from "../../../components/project/ProjectSurfaceView";
import { ProjectSurfaceHeader } from "../../../components/project/ProjectSurfaceHeader";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function ProjectSurfaceScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    surface?: string | string[];
  }>();
  const [headerHeight, setHeaderHeight] = useState(0);
  return (
    <ProjectSurfaceView
      headerHeight={headerHeight}
      header={
        <ProjectSurfaceHeader
          projectId={firstParam(params.id)}
          onHeight={setHeaderHeight}
        />
      }
      projectId={firstParam(params.id)}
      surface={(firstParam(params.surface) ?? "canvas") as ProjectSurface}
    />
  );
}
