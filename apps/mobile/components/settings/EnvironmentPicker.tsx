// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hidden picker for the native API backend (Production / Staging / Custom).
 * Opened by tapping the version label 7 times; switching reloads the app.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, View } from "react-native";
import { X as XIcon } from "lucide-react-native";
import { cn } from "@shogo/shared-ui/primitives";
import { Text, TextInput, accountSheetIcon } from "./account-sheet-chrome";
import { API_URL } from "../../lib/api-url";
import { getAppVersion } from "../../lib/app-version";
import {
  ENV_PRESETS,
  getActiveEnvLabel,
  getEnvOverride,
  normalizeOverrideUrl,
  type EnvOverride,
  type EnvOverrideKind,
} from "../../lib/env-override";
import { switchEnvironment } from "../../lib/env-switch";

const X = accountSheetIcon(XIcon);

const TAPS_TO_OPEN = 7;
const TAP_WINDOW_MS = 3000;

const OPTIONS: { id: EnvOverrideKind; label: string; detail?: string }[] = [
  { id: "production", label: ENV_PRESETS.production.label, detail: ENV_PRESETS.production.url },
  { id: "staging", label: ENV_PRESETS.staging.label, detail: ENV_PRESETS.staging.url },
  { id: "custom", label: "Custom URL" },
];

export function EnvironmentPicker({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const current = getEnvOverride();
  const [selected, setSelected] = useState<EnvOverrideKind>(current?.env ?? "production");
  const [customUrl, setCustomUrl] = useState(current?.env === "custom" ? current.url : "");
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const apply = useCallback(
    async (override: EnvOverride | null) => {
      setSwitching(true);
      try {
        await switchEnvironment(override);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not switch environment.");
        setSwitching(false);
      }
    },
    []
  );

  const handleSwitch = useCallback(() => {
    if (switching) return;
    if (selected === "custom") {
      const url = normalizeOverrideUrl(customUrl);
      if (!url) {
        setError("Enter a full http:// or https:// URL.");
        return;
      }
      void apply({ env: "custom", url });
      return;
    }
    void apply({ env: selected, url: ENV_PRESETS[selected].url });
  }, [apply, customUrl, selected, switching]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-black/50 items-center justify-center" onPress={onClose}>
        <Pressable
          className="bg-card rounded-xl p-6 w-80 border border-border"
          onPress={(e) => e.stopPropagation()}
        >
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-base font-semibold text-foreground">Environment</Text>
            <Pressable onPress={onClose} className="p-1" accessibilityLabel="Close">
              <X size={20} className="text-muted-foreground" />
            </Pressable>
          </View>
          <Text className="text-xs text-muted-foreground mb-4" selectable>
            Connected to {API_URL}
          </Text>

          <View className="gap-1 mb-3">
            {OPTIONS.map((option) => {
              const isSelected = selected === option.id;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => {
                    setSelected(option.id);
                    setError(null);
                  }}
                  className={cn(
                    "rounded-lg px-3 py-2.5 border",
                    isSelected ? "border-primary/40 bg-primary/5" : "border-transparent active:bg-muted"
                  )}
                >
                  <Text className="text-sm font-medium text-foreground">{option.label}</Text>
                  {option.detail ? (
                    <Text className="text-xs text-muted-foreground">{option.detail}</Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>

          {selected === "custom" ? (
            <TextInput
              value={customUrl}
              onChangeText={(t) => {
                setCustomUrl(t);
                if (error) setError(null);
              }}
              placeholder="http://192.168.1.10:8002"
              placeholderTextColor="#9ca3af"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              className="border border-border rounded-md px-3 py-2 text-sm text-foreground bg-background mb-3"
              onSubmitEditing={handleSwitch}
            />
          ) : null}

          <Text className="text-xs text-muted-foreground mb-3">
            The app reloads after switching. Each environment keeps its own sign-in.
          </Text>
          {error ? <Text className="text-xs text-destructive mb-3">{error}</Text> : null}

          <View className="flex-row gap-2 justify-end">
            {current ? (
              <Pressable
                onPress={() => void apply(null)}
                disabled={switching}
                className="px-3 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-sm text-foreground">Reset</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={handleSwitch}
              disabled={switching}
              className={cn("px-4 py-2 rounded-md bg-primary active:bg-primary/80", switching && "opacity-60")}
            >
              <Text className="text-sm text-primary-foreground">
                {switching ? "Switching..." : "Switch & reload"}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Version label that opens `EnvironmentPicker` after 7 quick taps.
 * Native only; renders the plain version on web.
 */
export function EnvironmentVersionTrigger({ className }: { className?: string }) {
  const version = getAppVersion();
  const envLabel = getActiveEnvLabel();
  const [open, setOpen] = useState(false);
  const taps = useRef<number[]>([]);
  const native = Platform.OS !== "web";

  useEffect(() => {
    if (!open) taps.current = [];
  }, [open]);

  const onPress = useCallback(() => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < TAP_WINDOW_MS), now];
    if (taps.current.length >= TAPS_TO_OPEN) setOpen(true);
  }, []);

  if (!version && !native) return null;

  return (
    <>
      <Pressable
        onPress={native ? onPress : undefined}
        accessibilityRole="text"
        className={className}
      >
        <Text className="text-xs text-muted-foreground">
          {version ? `Version ${version}` : "Version"}
          {envLabel ? ` · ${envLabel}` : ""}
        </Text>
      </Pressable>
      {native ? <EnvironmentPicker visible={open} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
