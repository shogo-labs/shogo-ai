// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React, { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Bot, Check, ChevronLeft, Search } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import type { ProjectSwitcherItem } from "../types";

export function ProjectSwitcherView({
  projects,
  currentProjectId,
  onSelect,
  onGoToDashboard,
  onBack,
}: {
  projects: ProjectSwitcherItem[];
  currentProjectId: string;
  onSelect: (projectId: string) => void;
  onGoToDashboard: () => void;
  onBack: () => void;
}) {
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? projects.filter((p) =>
        p.name.toLowerCase().includes(search.toLowerCase()),
      )
    : projects;

  return (
    <>
      {/* Back to menu + Go to Dashboard */}
      <View className="flex-row items-center justify-between px-3 py-2.5 border-b border-border">
        <Pressable
          onPress={onBack}
          className="flex-row items-center gap-1 active:bg-muted rounded-md px-1 py-0.5"
        >
          <ChevronLeft size={16} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-foreground">Back</Text>
        </Pressable>
        <Pressable
          onPress={onGoToDashboard}
          className="flex-row items-center gap-1 active:bg-muted rounded-md px-1 py-0.5"
        >
          <Text className="text-sm text-muted-foreground">Dashboard</Text>
        </Pressable>
      </View>

      {/* Search */}
      <View className="flex-row items-center gap-2 px-3 py-2 border-b border-border">
        <Search size={14} className="text-muted-foreground" />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search projects..."
          placeholderTextColor="#9ca3af"
          className="flex-1 text-sm text-foreground py-1 web:outline-none"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {/* Switch project heading */}
      <View className="px-3 pt-3 pb-1.5">
        <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Switch project
        </Text>
      </View>

      {/* Project list */}
      <View>
        {filtered.length === 0 ? (
          <View className="px-4 py-6 items-center">
            <Text className="text-sm text-muted-foreground">
              {search.trim()
                ? "No projects match your search"
                : "No projects available"}
            </Text>
          </View>
        ) : (
          <View className="py-1">
            {filtered.map((project) => {
              const isCurrent = project.id === currentProjectId;
              return (
                <Pressable
                  key={project.id}
                  onPress={() => onSelect(project.id)}
                  testID={`project-switcher-item-${project.id}`}
                  className={cn(
                    "flex-row items-center gap-2.5 px-3 py-2.5 active:bg-muted",
                    isCurrent && "bg-accent/50",
                  )}
                >
                  <View
                    className={cn(
                      "h-8 w-8 rounded-md items-center justify-center",
                      "bg-primary/10",
                    )}
                  >
                    <Bot size={15} className="text-primary" />
                  </View>
                  <View className="flex-1 min-w-0">
                    <Text className="text-sm text-foreground" numberOfLines={1}>
                      {project.name}
                    </Text>
                  </View>
                  {isCurrent && <Check size={16} className="text-primary" />}
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </>
  );
}
