// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { API_URL } from "../../lib/api";
import { Text } from "./account-sheet-chrome";

export type AccessScope = "own" | "all" | "selected";

interface AgentAccess {
  projectId: string;
  name: string;
  createdByMe: boolean;
  allowed: boolean;
  override: "allow" | "deny" | null;
}

interface MyAccess {
  label: string;
  connected: boolean;
  login: string | null;
  scope: AccessScope | null;
  agents: AgentAccess[];
}

const SCOPES: Array<{ value: AccessScope; label: string }> = [
  { value: "own", label: "Agents I create" },
  { value: "all", label: "Every agent" },
  { value: "selected", label: "Only ones I pick" },
];

/** Whether an agent acts as me under the workspace choice alone, before any per-agent switch. */
export function coveredByScope(scope: AccessScope | null, createdByMe: boolean): boolean {
  return scope === "all" || (scope === "own" && createdByMe);
}

/** The per-agent value to store so the agent ends up `allowed`: none when the workspace choice already gives that. */
export function overrideFor(scope: AccessScope | null, createdByMe: boolean, allowed: boolean): boolean | null {
  return coveredByScope(scope, createdByMe) === allowed ? null : allowed;
}

function Choice({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      aria-checked={selected} aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      className={`rounded-lg border px-3 py-1.5 disabled:opacity-50 ${selected ? "border-primary bg-primary" : "border-border"}`}
    >
      <Text className={`text-xs ${selected ? "font-medium text-primary-foreground" : "text-foreground"}`}>{label}</Text>
    </Pressable>
  );
}

/**
 * The signed-in person's own account on an integration (GitHub) and which
 * agents in this workspace may act as them when they ask. One choice for
 * the workspace, then a switch per agent for exceptions.
 */
export function MyAccountAccessCard({ workspaceId, provider = "github" }: { workspaceId: string; provider?: string }) {
  const [access, setAccess] = useState<MyAccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(provider)}/my-access`;

  const load = useCallback(async () => {
    if (!API_URL) return;
    try {
      const res = await fetch(base, { credentials: "include" });
      setAccess(res.ok ? await res.json() : null);
    } catch {
      setAccess(null);
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (url: string, method: "PUT" | "DELETE", body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        credentials: "include",
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error?.message ?? "Could not save");
      }
      await load();
    } catch (err: any) {
      setError(err?.message ?? "Could not save");
    } finally {
      setBusy(false);
    }
  };

  if (!access) return null;
  const label = access.label || provider;
  const via = access.agents.find((a) => a.createdByMe) ?? access.agents[0];
  const connect = via
    ? () => void Linking.openURL(`${API_URL}/api/projects/${encodeURIComponent(via.projectId)}/integrations/${encodeURIComponent(provider)}/connect`)
    : null;
  const allowedCount = access.agents.filter((a) => a.allowed).length;

  return (
    <View className="rounded-lg border border-border p-3">
      <Text className="text-sm font-medium text-foreground">{`Your ${label} account`}</Text>

      {!access.connected ? (
        <>
          <Text className="mt-1 text-xs text-muted-foreground">
            {`Connect it once and the agents you choose here push, open pull requests, and comment as you when you ask them to.`}
          </Text>
          {connect ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Connect my ${label} account`}
              disabled={busy}
              onPress={connect}
              className="mt-2 self-start rounded-lg bg-primary px-3 py-1.5 disabled:opacity-50"
            >
              <Text className="text-xs font-medium text-primary-foreground">{`Connect ${label}`}</Text>
            </Pressable>
          ) : (
            <Text className="mt-2 text-xs text-muted-foreground">
              {`There are no agents in this workspace yet. Create one, and connect ${label} from it or from here.`}
            </Text>
          )}
        </>
      ) : (
        <>
          <Text className="mt-1 text-xs text-muted-foreground">
            {`Connected${access.login ? ` as @${access.login}` : ""}. ${
              allowedCount === 0
                ? "No agents here act as you yet."
                : `${allowedCount} of ${access.agents.length} agent${access.agents.length === 1 ? "" : "s"} act as you when you ask.`
            }`}
          </Text>

          <Text className="mt-3 text-xs text-muted-foreground">Which agents may act as you?</Text>
          <View className="mt-1 flex-row flex-wrap gap-2">
            {SCOPES.map((s) => (
              <Choice
                key={s.value}
                label={s.label}
                selected={access.scope === s.value}
                disabled={busy}
                onPress={() => {
                  if (access.scope !== s.value) void send(base, "PUT", { scope: s.value });
                }}
              />
            ))}
          </View>
          <Text className="mt-2 text-xs text-muted-foreground">
            {`Only when you're the one asking. Teammates talking to the same agent never use your account.`}
          </Text>

          {access.agents.length > 0 ? (
            <View className="mt-3 gap-1">
              {access.agents.map((agent) => (
                <Pressable
                  key={agent.projectId}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`${agent.name} acts as me`}
                  aria-checked={agent.allowed} aria-disabled={busy}
                  disabled={busy}
                  onPress={() =>
                    void send(`${base}/agents/${encodeURIComponent(agent.projectId)}`, "PUT", {
                      allowed: overrideFor(access.scope, agent.createdByMe, !agent.allowed),
                    })
                  }
                  className="flex-row items-center gap-2 py-1 disabled:opacity-50"
                >
                  <View className={`h-4 w-4 rounded border ${agent.allowed ? "border-primary bg-primary" : "border-border"}`} />
                  <Text className="flex-1 text-xs text-foreground" numberOfLines={1}>
                    {agent.name}
                  </Text>
                  {agent.createdByMe ? <Text className="text-[10px] text-muted-foreground">yours</Text> : null}
                </Pressable>
              ))}
            </View>
          ) : null}

          <View className="mt-3 flex-row flex-wrap items-center gap-3">
            {access.scope || allowedCount > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Stop every agent here acting as me"
                disabled={busy}
                onPress={() => void send(base, "DELETE")}
                className="rounded-md py-1 disabled:opacity-50"
              >
                <Text className="text-xs text-muted-foreground underline">Stop in this workspace</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Disconnect my ${label} account`}
              disabled={busy}
              onPress={() => void send(`${API_URL}/api/me/integrations/${encodeURIComponent(provider)}`, "DELETE")}
              className="rounded-md py-1 disabled:opacity-50"
            >
              <Text className="text-xs text-muted-foreground underline">{`Disconnect ${label} everywhere`}</Text>
            </Pressable>
          </View>
        </>
      )}

      {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}
