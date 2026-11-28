// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The right panel while a project's runtime boots (SHO-605).
 *
 * The project screen used to wait for `/sandbox/url` to say `ready:true`
 * before drawing anything, so a cold runtime blanked the whole page — chat
 * history included, even though the chat reads its history from the API and
 * never needs the runtime. The page now draws immediately and this pane takes
 * the place of every panel that *does* need `agentUrl` (canvas, preview, IDE,
 * files, capabilities, channels) until the runtime answers, so none of them
 * mount against a URL that would refuse the connection.
 *
 * A runtime that stalls or errors keeps this pane and hands it the recovery
 * UI it always had: the capacity card when the workspace is over budget, or
 * "This is taking longer than expected" with retry / back / open-on-web.
 */
import { Pressable, Text, View } from "react-native";
import { RefreshCw } from "lucide-react-native";
import type { WorkspaceBudgetMessage } from "@shogo/shared-app/hooks";
import { Spinner } from "@/components/ui/spinner";
import { WorkspaceCapacityCard } from "./WorkspaceBudgetNotice";

/**
 * Whether the right panel should show this pane instead of its real panels.
 *
 * Only the local-runtime path can be booting: a remote instance
 * (`remoteAgentBaseUrl`) talks to a runtime that was already running when it
 * was adopted, so it keeps rendering exactly as before. Exported so the
 * remote path stays a tested guarantee rather than a comment.
 */
export function isRuntimeBooting(args: {
  remoteAgentBaseUrl: string | null | undefined;
  runtimeReady: boolean;
}): boolean {
  return !args.remoteAgentBaseUrl && !args.runtimeReady;
}

export interface RuntimeStartingPaneProps {
  /** Over-budget capacity notice; renders the upgrade card instead of a spinner. */
  capacity?: WorkspaceBudgetMessage | null;
  /** The boot has run past its stall threshold. */
  stalled?: boolean;
  /** The runtime answered with an error. */
  error?: string | null;
  /** The last status the runtime reported, shown next to the error. */
  lastStatus?: string | null;
  onRetry: () => void;
  onBack: () => void;
  onOpenWeb: () => void;
}

export function RuntimeStartingPane({
  capacity,
  stalled,
  error,
  lastStatus,
  onRetry,
  onBack,
  onOpenWeb,
}: RuntimeStartingPaneProps) {
  const showRecovery = !!stalled || !!error;

  if (showRecovery) {
    return (
      <View
        className="flex-1 items-center justify-center bg-background px-6"
        testID="runtime-starting-pane"
      >
        {capacity ? (
          <WorkspaceCapacityCard
            capacity={capacity}
            onRetry={onRetry}
            onBack={onBack}
          />
        ) : (
          <View className="w-full gap-3 items-center px-2 py-6">
            <Spinner size="small" />
            <Text className="text-foreground text-base font-semibold text-center">
              This is taking longer than expected
            </Text>
            <Text className="text-muted-foreground text-sm text-center">
              {error
                ? `We couldn't reach your project's runtime${
                    lastStatus ? ` (${lastStatus})` : ""
                  }. Check your connection or try again.`
                : "Your project runtime is still warming up. You can keep waiting, retry, or open it on the web."}
            </Text>
            <View className="flex-row flex-wrap gap-2 mt-2 justify-center">
              <Pressable
                onPress={onRetry}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
                accessibilityRole="button"
                accessibilityLabel="Retry connecting to your project"
              >
                <View className="flex-row items-center gap-2">
                  <RefreshCw size={14} className="text-muted-foreground" />
                  <Text className="text-foreground text-sm font-medium">
                    Try again
                  </Text>
                </View>
              </Pressable>
              <Pressable
                onPress={onBack}
                className="px-4 py-2 rounded-md border border-border active:bg-muted"
                accessibilityRole="button"
                accessibilityLabel="Go back to projects list"
              >
                <Text className="text-foreground text-sm font-medium">
                  Go back
                </Text>
              </Pressable>
              <Pressable
                onPress={onOpenWeb}
                className="px-4 py-2 rounded-md bg-primary active:bg-primary/80"
                accessibilityRole="button"
                accessibilityLabel="Open this project on the web"
              >
                <Text className="text-primary-foreground text-sm font-medium">
                  Open on web
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    );
  }

  return (
    <View
      className="flex-1 items-center justify-center gap-3 bg-background px-6"
      testID="runtime-starting-pane"
    >
      <Spinner size="large" />
      <Text className="text-sm text-muted-foreground text-center">
        Starting your project…
      </Text>
    </View>
  );
}
