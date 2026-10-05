// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { API_URL } from "../../lib/api";
import { Text } from "./account-sheet-chrome";

type ChainStep = "requester" | "ask" | "approve" | "delegate" | "shared" | "deny";
type Unconnected = "ask" | "shared" | "deny";
type Nobody = "approve" | "delegate" | "shared" | "deny";

interface Policy {
  provider: string;
  writeChain: ChainStep[];
  readChain: ChainStep[];
  label: string;
  delegateName?: string | null;
  delegateIsMe?: boolean;
}

interface Choices {
  asRequester: boolean;
  unconnected: Unconnected;
  nobody: Nobody;
  readToo: boolean;
}

/** The settings below, read off the stored lists of steps the agent tries in order. */
export function choicesFromChains(writeChain: ChainStep[], readChain: ChainStep[]): Choices {
  const asRequester = writeChain[0] !== "shared";
  const second = writeChain[1];
  const unconnected: Unconnected = second === "ask" || second === "shared" ? second : "deny";
  const third = writeChain[2];
  const nobody: Nobody =
    unconnected === "ask" && (third === "approve" || third === "delegate" || third === "shared") ? third : "deny";
  return { asRequester, unconnected, nobody, readToo: asRequester && readChain[0] === "requester" };
}

export function chainsFromChoices(c: Choices): Pick<Policy, "writeChain" | "readChain"> {
  if (!c.asRequester) return { writeChain: ["shared"], readChain: ["shared"] };
  const nobody: ChainStep[] = c.nobody === "approve" || c.nobody === "delegate" ? [c.nobody, "deny"] : [c.nobody];
  const writeChain: ChainStep[] =
    c.unconnected === "ask" ? ["requester", "ask", ...nobody] : ["requester", c.unconnected];
  // Reads never stop to ask; they fall back to the project account unless writes are refused outright.
  const readChain: ChainStep[] = !c.readToo
    ? ["shared"]
    : c.unconnected === "deny" ? ["requester", "deny"] : ["requester", "shared"];
  return { writeChain, readChain };
}

interface AuditEntry {
  id: string;
  op: "read" | "write";
  source: "shared" | "personal" | "delegate" | "approved";
  actingAs: string;
  requesterName: string | null;
  origin: string | null;
  createdAt: string;
}

/** One line of recent activity: whose account, for whom, how long ago. */
export function auditLine(entry: AuditEntry, now = Date.now()): string {
  const account =
    entry.source === "shared"
      ? "Project account"
      : `${entry.actingAs}${entry.source === "approved" ? " (approved)" : entry.source === "delegate" ? " (delegate)" : ""}`;
  const forWhom = entry.requesterName ? ` for ${entry.requesterName}` : entry.origin === "event" ? " for a trigger" : " · unattended";
  return `${account}${forWhom} · ${entry.op} · ${timeAgo(entry.createdAt, now)}`;
}

function timeAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

interface MyConnection {
  provider: string;
  externalLogin: string | null;
}

const UNCONNECTED: Array<{ value: Unconnected; label: string }> = [
  { value: "ask", label: "Ask them to connect" },
  { value: "shared", label: "Use the project account" },
  { value: "deny", label: "Don't do it" },
];

const NOBODY: Array<{ value: Nobody; label: string }> = [
  { value: "approve", label: "Ask someone in the conversation to approve" },
  { value: "delegate", label: "Act as a teammate who opted in" },
  { value: "shared", label: "Use the project account" },
  { value: "deny", label: "Don't do it" },
];

function Choice({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`rounded-lg border px-3 py-1.5 disabled:opacity-50 ${selected ? "border-primary bg-primary" : "border-border"}`}
    >
      <Text className={`text-xs ${selected ? "font-medium text-primary-foreground" : "text-foreground"}`}>{label}</Text>
    </Pressable>
  );
}

/**
 * Whose account the project's agent uses on an integration: the project's
 * shared account, or the account of whoever asked it to do something.
 * Hidden where the server has no such setting.
 */
export function IntegrationActsAsSection({ projectId, provider = "github" }: { projectId: string; provider?: string }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [mine, setMine] = useState<MyConnection | null>(null);
  const [activity, setActivity] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `${API_URL}/api/projects/${projectId}/integrations`;

  const load = useCallback(async () => {
    if (!API_URL) return;
    try {
      const res = await fetch(`${base}/policies`, { credentials: "include" });
      if (!res.ok) return;
      const body = await res.json();
      setPolicy((body?.policies ?? []).find((p: Policy) => p.provider === provider) ?? null);
      setCanEdit(body?.canEdit === true);
      setMine((body?.me?.connections ?? []).find((c: MyConnection) => c.provider === provider) ?? null);
      if (body?.canEdit === true) {
        const audit = await fetch(`${base}/audit?provider=${encodeURIComponent(provider)}&limit=8`, { credentials: "include" });
        const entries = audit.ok ? (await audit.json())?.entries : null;
        setActivity(Array.isArray(entries) ? entries : []);
      } else {
        setActivity([]);
      }
    } catch {
      // No setting to show.
    }
  }, [base, provider]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (change: Partial<Choices>) => {
    if (!policy) return;
    const previous = policy;
    const patch = chainsFromChoices({ ...choicesFromChains(policy.writeChain, policy.readChain), ...change });
    setPolicy({ ...policy, ...patch });
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/policies/${encodeURIComponent(provider)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? "Could not save");
      }
    } catch (err: any) {
      setPolicy(previous);
      setError(err?.message ?? "Could not save");
    } finally {
      setBusy(false);
    }
  };

  const disconnectMine = async () => {
    if (!API_URL) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/me/integrations/${encodeURIComponent(provider)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Could not disconnect");
      setMine(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not disconnect");
    } finally {
      setBusy(false);
    }
  };

  const setDelegate = async (on: boolean) => {
    if (!policy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/policies/${encodeURIComponent(provider)}/delegate`, {
        method: on ? "POST" : "DELETE",
        credentials: "include",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        if (body?.error?.connectUrl) void Linking.openURL(body.error.connectUrl);
        throw new Error(body?.error?.message ?? "Could not save");
      }
      await load();
    } catch (err: any) {
      setError(err?.message ?? "Could not save");
    } finally {
      setBusy(false);
    }
  };

  if (!policy) return null;
  const label = policy.label || provider;
  const { asRequester, unconnected, nobody, readToo } = choicesFromChains(policy.writeChain, policy.readChain);
  const locked = busy || !canEdit;

  return (
    <View className="mt-3 border-t border-border pt-3">
      <Text className="text-xs font-medium text-foreground">Agent acts as</Text>
      <View className="mt-2 flex-row flex-wrap gap-2">
        <Choice
          label="Project account"
          selected={!asRequester}
          disabled={locked}
          onPress={() => void save({ asRequester: false })}
        />
        <Choice
          label="Person who asked"
          selected={asRequester}
          disabled={locked}
          onPress={() => {
            if (!asRequester) void save({ asRequester: true, unconnected: "ask", nobody: "deny", readToo: false });
          }}
        />
      </View>
      <Text className="mt-2 text-xs text-muted-foreground">
        {asRequester
          ? `Issues, comments, and pull requests are created with the ${label} account of whoever asked the agent, so they show up as the author.`
          : `Everything the agent does on ${label} uses this project's connection.`}
      </Text>
      {!canEdit ? (
        <Text className="mt-1 text-xs text-muted-foreground">Only the project owner and workspace admins can change this.</Text>
      ) : null}

      {asRequester ? (
        <>
          <Text className="mt-3 text-xs text-muted-foreground">{`If they haven't connected ${label}:`}</Text>
          <View className="mt-1 flex-row flex-wrap gap-2">
            {UNCONNECTED.map((f) => (
              <Choice
                key={f.value}
                label={f.label}
                selected={unconnected === f.value}
                disabled={locked}
                onPress={() => void save({ unconnected: f.value })}
              />
            ))}
          </View>
          {unconnected === "ask" ? (
            <>
              <Text className="mt-3 text-xs text-muted-foreground">When no one asked (schedules, webhooks, other automations):</Text>
              <View className="mt-1 flex-row flex-wrap gap-2">
                {NOBODY.map((f) => (
                  <Choice
                    key={f.value}
                    label={f.label}
                    selected={nobody === f.value}
                    disabled={locked}
                    onPress={() => void save({ nobody: f.value })}
                  />
                ))}
              </View>
              {nobody === "approve" ? (
                <Text className="mt-2 text-xs text-muted-foreground">
                  {`The agent posts a card where it's working. Whoever approves lends their own ${label} account for that one action.`}
                </Text>
              ) : null}
              {nobody === "delegate" ? (
                <View className="mt-2 flex-row flex-wrap items-center gap-2">
                  <Text className="text-xs text-muted-foreground">
                    {policy.delegateName
                      ? `Unattended runs act as ${policy.delegateIsMe ? "you" : policy.delegateName}.`
                      : "No one has opted in yet, so unattended runs are refused."}
                  </Text>
                  {policy.delegateIsMe || (canEdit && policy.delegateName) ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={policy.delegateIsMe ? "Stop acting as me" : `Stop acting as ${policy.delegateName}`}
                      disabled={busy}
                      onPress={() => void setDelegate(false)}
                      className="rounded-md px-2 py-1 disabled:opacity-50"
                    >
                      <Text className="text-xs text-muted-foreground underline">Stop</Text>
                    </Pressable>
                  ) : null}
                  {!policy.delegateIsMe ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Act as me when no one asked"
                      disabled={busy}
                      onPress={() => void setDelegate(true)}
                      className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-50"
                    >
                      <Text className="text-xs text-foreground">{`Use my ${label} account`}</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </>
          ) : null}
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel="Use their account for reading too"
            accessibilityState={{ checked: readToo, disabled: locked }}
            disabled={locked}
            onPress={() => void save({ readToo: !readToo })}
            className="mt-3 flex-row items-center gap-2 disabled:opacity-50"
          >
            <View className={`h-4 w-4 rounded border ${readToo ? "border-primary bg-primary" : "border-border"}`} />
            <Text className="text-xs text-foreground">Use their account for reading too (private repos they can see)</Text>
          </Pressable>

          <View className="mt-3 flex-row items-center gap-2">
            {mine ? (
              <>
                <Text className="text-xs text-muted-foreground">
                  {`You: connected${mine.externalLogin ? ` as @${mine.externalLogin}` : ""}`}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Disconnect my ${label} account`}
                  disabled={busy}
                  onPress={() => void disconnectMine()}
                  className="rounded-md px-2 py-1 disabled:opacity-50"
                >
                  <Text className="text-xs text-muted-foreground underline">Disconnect</Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Connect my ${label} account`}
                disabled={busy}
                onPress={() => void Linking.openURL(`${base}/${encodeURIComponent(provider)}/connect`)}
                className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-50"
              >
                <Text className="text-xs text-foreground">{`Connect my ${label} account`}</Text>
              </Pressable>
            )}
          </View>
        </>
      ) : null}

      {activity.length > 0 ? (
        <View className="mt-3">
          <Text className="text-xs font-medium text-foreground">Recent activity</Text>
          {activity.map((entry) => (
            <Text key={entry.id} className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
              {auditLine(entry)}
            </Text>
          ))}
        </View>
      ) : null}

      {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}
