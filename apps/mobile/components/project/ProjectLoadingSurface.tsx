// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The project screen before its data arrives (SHO-581).
 *
 * Opening a project used to replace the whole body with a centred spinner for
 * the length of `GET /api/projects/:id` — on a slow network that is the same
 * "it froze" symptom SHO-580 fixed on the projects list, one tap later. The row
 * the person tapped is usually already on the device, so the screen can draw
 * the surface it is about to become: the header with the project's name, the
 * tab strip and the chat panel's shape, with one line saying what is happening.
 *
 * The runtime gate stays: a project whose runtime is still booting draws this
 * same frame and says "Starting your project…". A load that failed draws an
 * error with a retry instead of an endless spinner. Whatever the caller passes
 * as `children` (the capacity card, the stalled-runtime warning) takes the
 * place of the status line, so the recovery UI still owns the body when there
 * is something to recover from.
 */
import type { ReactNode } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { RefreshCw } from "lucide-react-native";
import { Spinner } from "@/components/ui/spinner";
import { isPhoneLayout } from "../../lib/native-phone-layout";
import { ProjectSurfaceHeader } from "./ProjectSurfaceHeader";
import { usePhoneScreenHeaderInset } from "../layout/PhoneScreenHeader";

export type ProjectLoadingPhase = "project" | "runtime";

export interface ProjectLoadingSurfaceProps {
  projectId: string | undefined;
  /** The name from the row the screen already holds, when it has one. */
  title?: string | null;
  /** `project`: the row is in flight. `runtime`: the row is in, the runtime boots. */
  phase: ProjectLoadingPhase;
  /** A failed load: draw it with a retry instead of the status line. */
  loadError?: string | null;
  onRetryLoad?: () => void;
  onBack: () => void;
  /** Recovery UI (capacity card, stalled warning) in place of the status line. */
  children?: ReactNode;
}

/** Message-shaped placeholders, so the frame reads as the chat it becomes. */
function PanelSkeleton() {
  return (
    <View className="gap-3" testID="project-loading-skeleton">
      <View className="h-14 w-4/5 rounded-2xl bg-muted" />
      <View className="ml-auto h-10 w-3/5 rounded-2xl bg-muted" />
      <View className="ml-auto h-16 w-2/3 rounded-2xl bg-muted" />
      <View className="h-10 w-1/2 rounded-2xl bg-muted" />
    </View>
  );
}

export function ProjectLoadingSurface({
  projectId,
  title,
  phase,
  loadError,
  onRetryLoad,
  onBack,
  children,
}: ProjectLoadingSurfaceProps) {
  const { width, height } = useWindowDimensions();
  const phone = isPhoneLayout(width, height);
  const header = usePhoneScreenHeaderInset();
  const status =
    phase === "runtime" ? "Starting your project…" : "Loading project...";

  return (
    <View className="flex-1 bg-background" testID="project-loading-surface">
      <ProjectSurfaceHeader
        projectId={projectId}
        title={title}
        onHeight={header.onLayout}
      />
      <View className="flex-1" style={{ paddingTop: phone ? header.height : 0 }}>
        {/* The phone header carries the name; everywhere else the surface does. */}
        {!phone && (
          <Text
            testID="project-loading-title"
            className="px-4 pb-2 pt-4 text-base font-semibold text-foreground"
            numberOfLines={1}
          >
            {title || "Project"}
          </Text>
        )}

        {/* The tab strip, at its real height so nothing jumps on the swap. */}
        <View className="h-11 flex-row items-center gap-2 border-b border-border px-3">
          <View className="h-7 w-24 rounded-full bg-muted" />
          <View className="h-7 w-20 rounded-full bg-muted" />
          <View className="ml-auto h-7 w-7 rounded-full bg-muted" />
        </View>

        <View className="flex-1 px-4 pt-5">
          {loadError ? (
            <View
              className="flex-1 items-center justify-center px-2"
              testID="project-load-error"
            >
              <Text className="text-center text-base font-semibold text-foreground">
                We couldn't open this project
              </Text>
              <Text className="mt-2 text-center text-sm leading-5 text-muted-foreground">
                {loadError}
              </Text>
              <View className="mt-4 flex-row flex-wrap justify-center gap-2">
                {onRetryLoad && (
                  <Pressable
                    onPress={onRetryLoad}
                    accessibilityRole="button"
                    accessibilityLabel="Try loading the project again"
                    className="flex-row items-center gap-2 rounded-md border border-border px-4 py-2 active:bg-muted"
                  >
                    <RefreshCw size={14} className="text-muted-foreground" />
                    <Text className="text-sm font-medium text-foreground">
                      Try again
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={onBack}
                  accessibilityRole="button"
                  accessibilityLabel="Go back to the projects list"
                  className="rounded-md border border-border px-4 py-2 active:bg-muted"
                >
                  <Text className="text-sm font-medium text-foreground">
                    Go back
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : children ? (
            <View className="flex-1">{children}</View>
          ) : (
            <View className="flex-1" testID="project-loading-status">
              <View className="flex-row items-center gap-2 pb-4">
                <Spinner size="small" />
                <Text className="text-sm text-muted-foreground">{status}</Text>
              </View>
              <PanelSkeleton />
            </View>
          )}
        </View>

        {/* The composer, drawn so the panel keeps its bottom edge while loading. */}
        <View className="border-t border-border px-3 py-3">
          <View className="h-11 rounded-2xl bg-muted" />
        </View>
      </View>
    </View>
  );
}
