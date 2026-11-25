// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The four "go to that project's surface" buttons above an agent's chat list
 * (SHO-571): Files, Canvas, Plans, Settings. They are the project tab bar's
 * tabs for a project whose chats you are looking at, so you can open the
 * project itself without picking a chat first.
 */
import { Pressable, Text, View } from "react-native";
import {
  ClipboardList,
  FileText,
  LayoutGrid,
  Settings,
  type LucideIcon,
} from "lucide-react-native";
import { LiquidGlassBackdrop } from "../ui/LiquidGlassBackdrop";
import type { ProjectSurface } from "../../lib/project-surface-route";

const SURFACES: { surface: ProjectSurface; label: string; Icon: LucideIcon }[] = [
  { surface: "files", label: "Files", Icon: FileText },
  { surface: "canvas", label: "Canvas", Icon: LayoutGrid },
  { surface: "plans", label: "Plans", Icon: ClipboardList },
  { surface: "settings", label: "Settings", Icon: Settings },
];

export function ProjectSurfaceQuickButtons({
  projectName,
  onOpen,
}: {
  /** Named in each button's accessibility label ("Files in <project>"). */
  projectName: string;
  onOpen: (surface: ProjectSurface) => void;
}) {
  return (
    <View className="mt-2 flex-row gap-1.5" testID="project-chats-quick-buttons">
      {SURFACES.map(({ surface, label, Icon }) => (
        <Pressable
          key={surface}
          onPress={() => onOpen(surface)}
          accessibilityRole="button"
          accessibilityLabel={`${label} in ${projectName}`}
          testID={`project-chats-quick-${surface}`}
          className="min-h-10 flex-1 flex-row items-center justify-center gap-1 overflow-hidden rounded-full bg-transparent px-1 shadow-sm active:opacity-70"
        >
          <LiquidGlassBackdrop style={{ borderRadius: 999 }} />
          <Icon size={15} className="text-foreground" />
          <Text className="text-[11px] font-medium text-foreground" numberOfLines={1}>
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
