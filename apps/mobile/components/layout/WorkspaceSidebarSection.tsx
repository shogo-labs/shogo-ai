// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { useReducedMotion } from "../../hooks/useReducedMotion";

interface WorkspaceSidebarSectionProps {
  label: string;
  count?: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  action?: ReactNode;
  actionVisibility?: "always" | "hover";
  collapseOnHover?: boolean;
  headerClassName?: string;
  children: ReactNode;
}

/**
 * Compact, accessible disclosure used by the desktop context pane and the
 * narrow conversation drawer. The action sits beside—not inside—the toggle,
 * so creating a chat or project never changes disclosure state.
 */
export function WorkspaceSidebarSection({
  label,
  count,
  expanded,
  onExpandedChange,
  action,
  actionVisibility = "always",
  collapseOnHover = false,
  headerClassName,
  children,
}: WorkspaceSidebarSectionProps) {
  const prefersReducedMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    Animated.timing(progress, {
      toValue: expanded ? 1 : 0,
      duration: prefersReducedMotion ? 0 : 180,
      useNativeDriver: false,
    }).start();
  }, [expanded, prefersReducedMotion, progress]);

  return (
    <View className="pt-2">
      <View
        className="flex-row items-center"
        {...(collapseOnHover
          ? ({
              onMouseEnter: () => setHovered(true),
              onMouseLeave: () => setHovered(false),
            } as any)
          : {})}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${expanded ? "Collapse" : "Expand"} ${label}`}
          accessibilityState={{ expanded }}
          onPress={() => onExpandedChange(!expanded)}
          className={cn(
            "min-h-11 flex-1 flex-row items-center rounded-lg px-2 active:bg-muted",
            headerClassName
          )}
        >
          <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </Text>
          {typeof count === "number" ? (
            <Text className="ml-1 text-xs text-muted-foreground">
              ({count})
            </Text>
          ) : null}
          <Animated.View
            className={cn(
              "ml-auto",
              collapseOnHover && !hovered && "opacity-0 pointer-events-none"
            )}
            style={{
              transform: [
                {
                  rotate: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: ["0deg", "90deg"],
                  }),
                },
              ],
            }}
          >
            <ChevronRight size={15} className="text-muted-foreground" />
          </Animated.View>
        </Pressable>
        {action ? (
          <View
            className={cn(
              "ml-1",
              actionVisibility === "hover" &&
                !hovered &&
                "opacity-0 pointer-events-none"
            )}
          >
            {action}
          </View>
        ) : null}
      </View>
      <Animated.View
        accessible
        accessibilityLabel={label}
        pointerEvents={expanded ? "auto" : "none"}
        style={{
          maxHeight: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [0, 2000],
          }),
          opacity: progress,
          overflow: "hidden",
        }}
      >
        <View className={cn("pb-2", expanded ? "pt-1" : "pt-0")}>
          {children}
        </View>
      </Animated.View>
    </View>
  );
}
