// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect } from "react";
import {
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import { Motion } from "@legendapp/motion";
import {
  Activity,
  ArrowRight,
  Code2,
  Layers3,
  Rocket,
  Server,
  Sparkles,
  X,
} from "lucide-react-native";
import type { WhatsNewRelease } from "../../lib/whats-new/use-whats-new";

const ICONS = {
  activity: Activity,
  code: Code2,
  layers: Layers3,
  rocket: Rocket,
  server: Server,
  sparkles: Sparkles,
} as const;

function HighlightIcon({ name }: { name?: string }) {
  const Icon = ICONS[name as keyof typeof ICONS] ?? Sparkles;
  return <Icon size={18} color="#f97316" strokeWidth={2.2} />;
}

export function WhatsNewModal({
  release,
  visible,
  onDismiss,
}: {
  release: WhatsNewRelease | null;
  visible: boolean;
  onDismiss: () => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = width < 640;

  useEffect(() => {
    if (visible && Platform.OS !== "web") {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(
        () => {},
      );
    }
  }, [visible]);

  if (!release) return null;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <Motion.View
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 180 }}
          style={styles.backdrop}
        />
        <Motion.View
          initial={{ opacity: 0, scale: 0.92, y: compact ? 28 : 18 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ type: "spring", damping: 20, stiffness: 180 }}
          className={`bg-background ${compact ? "w-full" : "w-full max-w-[480px]"}`}
          style={[
            styles.card,
            compact ? styles.bottomCard : styles.centerCard,
            { paddingBottom: Math.max(insets.bottom, 20) },
          ]}
        >
          <View className="overflow-hidden rounded-t-3xl">
            <LinearGradient
              colors={["#fb923c", "#f97316", "#ea580c"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.header}
            >
              <Motion.View
                initial={{ opacity: 0, x: -80 }}
                animate={{ opacity: 0.2, x: 260 }}
                transition={{ duration: 1200, delay: 300 }}
                style={styles.shine}
              />
              {[0, 1, 2, 3].map((index) => (
                <Motion.View
                  key={index}
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 0.85, scale: 1 }}
                  transition={{ delay: 180 + index * 90, type: "spring" }}
                  style={[
                    styles.sparkle,
                    index % 2 === 0 ? styles.sparkleLarge : styles.sparkleSmall,
                    { left: 40 + index * 78, top: 18 + (index % 2) * 34 },
                  ]}
                >
                  <Sparkles size={index % 2 === 0 ? 16 : 11} color="#fff7ed" />
                </Motion.View>
              ))}
              <Pressable
                accessibilityLabel="Close What's New"
                accessibilityRole="button"
                onPress={onDismiss}
                className="absolute right-4 top-4 rounded-full bg-black/10 p-2"
              >
                <X size={18} color="#fff" />
              </Pressable>
              <View className="gap-1">
                <Text className="text-xs font-semibold uppercase tracking-[2px] text-orange-100">
                  What's new
                </Text>
                <Text className="text-3xl font-bold text-white">
                  {release.title}
                </Text>
                <Text className="max-w-[360px] text-sm leading-5 text-orange-50">
                  {release.intro}
                </Text>
              </View>
            </LinearGradient>
          </View>

          <ScrollView
            className="max-h-[380px]"
            contentContainerStyle={styles.highlights}
            showsVerticalScrollIndicator={false}
          >
            {release.highlights.map((highlight, index) => (
              <Motion.View
                key={`${highlight.title}-${index}`}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  delay: 260 + index * 75,
                  type: "spring",
                  damping: 18,
                }}
                className="flex-row gap-3"
              >
                <View className="mt-0.5 h-9 w-9 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-950">
                  <HighlightIcon name={highlight.icon} />
                </View>
                <View className="flex-1 gap-0.5">
                  <Text className="text-sm font-semibold text-foreground">
                    {highlight.title}
                  </Text>
                  <Text className="text-sm leading-5 text-muted-foreground">
                    {highlight.description}
                  </Text>
                </View>
              </Motion.View>
            ))}
          </ScrollView>

          <View className="gap-3 px-5 pt-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss What's New"
              onPress={onDismiss}
              className="h-11 items-center justify-center rounded-xl bg-primary active:bg-primary/80"
            >
              <Text className="text-sm font-semibold text-primary-foreground">
                Got it
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="link"
              onPress={() => {
                void Linking.openURL(release.url);
                onDismiss();
              }}
              className="flex-row items-center justify-center gap-1 py-1"
            >
              <Text className="text-sm font-medium text-primary">
                Read the full changelog
              </Text>
              <ArrowRight size={15} color="#ea580c" />
            </Pressable>
          </View>
        </Motion.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(15, 23, 42, 0.62)",
  },
  card: {
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.24,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 20,
  },
  bottomCard: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    marginTop: "auto",
  },
  centerCard: {
    borderRadius: 24,
    marginHorizontal: 20,
  },
  header: {
    minHeight: 178,
    justifyContent: "flex-end",
    paddingHorizontal: 24,
    paddingBottom: 22,
    position: "relative",
  },
  shine: {
    position: "absolute",
    width: 42,
    height: 240,
    top: -30,
    transform: [{ rotate: "22deg" }],
    backgroundColor: "#fff",
  },
  sparkle: {
    position: "absolute",
  },
  sparkleLarge: {
    transform: [{ rotate: "12deg" }],
  },
  sparkleSmall: {
    transform: [{ rotate: "-18deg" }],
  },
  highlights: {
    gap: 16,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
});
