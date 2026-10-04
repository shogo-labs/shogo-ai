// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, TextInput, View } from "react-native";
import { API_URL } from "../../lib/api";
import { Text } from "./account-sheet-chrome";

interface GitHubConnectionInfo {
  repoFullName: string;
  defaultBranch: string;
  authType: "app" | "token";
  tokenLogin: string | null;
  lastSyncError: string | null;
}

const inputStyle = { outlineWidth: 0, outlineStyle: "none", boxShadow: "none" } as any;
const inputClass =
  "rounded-xl border border-border bg-card px-3 py-3 text-sm text-foreground web:outline-none";

export function parseRepoInput(value: string): { owner: string; name: string } | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  const match =
    trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i) ??
    trimmed.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? fallback;
}

/**
 * Connect the project to a GitHub repository. The user picks how: authorize
 * the Shogo GitHub App (opens GitHub, returns to the project) or paste an
 * access token, which the API stores encrypted on the connection.
 */
export function ProjectGitHubSection({ projectId }: { projectId: string }) {
  const [connection, setConnection] = useState<GitHubConnectionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"authorize" | "token" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!API_URL) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/projects/${projectId}/github`, { credentials: "include" });
      if (!res.ok) throw new Error(await errorMessage(res, `HTTP ${res.status}`));
      const body = await res.json();
      setConnection(body?.connected ? (body.connection as GitHubConnectionInfo) : null);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load the GitHub connection");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsed = parseRepoInput(repo);

  const authorize = async () => {
    if (!API_URL || !parsed) return;
    setBusy("authorize");
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/projects/${projectId}/github/authorize`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_owner: parsed.owner, repo_name: parsed.name }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not start GitHub authorization"));
      const body = await res.json();
      await Linking.openURL(body.url);
      setNotice("Finish authorizing in GitHub. You'll come back to this project when it's done.");
    } catch (err: any) {
      setError(err?.message ?? "Could not start GitHub authorization");
    } finally {
      setBusy(null);
    }
  };

  const connectWithToken = async () => {
    if (!API_URL || !parsed || !token.trim()) return;
    setBusy("token");
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/projects/${projectId}/github/connect`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_owner: parsed.owner, repo_name: parsed.name, token: token.trim() }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not connect the repository"));
      const body = await res.json();
      setToken("");
      setNotice(
        body?.workspace?.ok === false
          ? `Connected, but the project files weren't updated yet: ${body.workspace.error}`
          : null,
      );
      await load();
    } catch (err: any) {
      setError(err?.message ?? "Could not connect the repository");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!API_URL) return;
    setBusy("disconnect");
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/projects/${projectId}/github`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await errorMessage(res, "Could not disconnect"));
      setConnection(null);
      setNotice(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not disconnect");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View className="mt-8">
      <Text className="mb-2 text-xs font-medium text-muted-foreground">GITHUB</Text>

      {loading ? (
        <Text className="text-sm text-muted-foreground">Loading…</Text>
      ) : connection ? (
        <View className="rounded-xl border border-border bg-card px-3 py-3">
          <Text className="text-sm font-medium text-foreground">{connection.repoFullName}</Text>
          <Text className="mt-1 text-xs text-muted-foreground">
            {connection.authType === "token"
              ? `Connected with ${connection.tokenLogin ?? "a user"}'s access token`
              : "Connected through the Shogo GitHub App"}
            {` · ${connection.defaultBranch}`}
          </Text>
          {connection.lastSyncError ? (
            <Text className="mt-2 text-xs text-destructive">{connection.lastSyncError}</Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Disconnect GitHub"
            disabled={busy !== null}
            onPress={() => void disconnect()}
            className="mt-3 self-start rounded-lg border border-border px-3 py-2 disabled:opacity-50"
          >
            <Text className="text-sm text-foreground">{busy === "disconnect" ? "Disconnecting…" : "Disconnect"}</Text>
          </Pressable>
        </View>
      ) : (
        <View>
          <TextInput
            value={repo}
            onChangeText={setRepo}
            placeholder="owner/repository or GitHub URL"
            placeholderTextColor="#8a8a8f"
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="GitHub repository"
            className={inputClass}
            style={inputStyle}
          />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Authorize the Shogo GitHub App"
            disabled={!parsed || busy !== null}
            onPress={() => void authorize()}
            className="mt-3 self-start rounded-lg bg-primary px-4 py-2.5 disabled:opacity-50"
          >
            <Text className="text-sm font-medium text-primary-foreground">
              {busy === "authorize" ? "Opening GitHub…" : "Authorize the Shogo GitHub App"}
            </Text>
          </Pressable>

          <Text className="mt-4 text-xs text-muted-foreground">
            Or share an access token (fine-grained: Contents and Pull requests read/write; classic: repo scope).
            It's stored encrypted.
          </Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="github_pat_… or ghp_…"
            placeholderTextColor="#8a8a8f"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="GitHub access token"
            className={`mt-2 ${inputClass}`}
            style={inputStyle}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Connect with token"
            disabled={!parsed || !token.trim() || busy !== null}
            onPress={() => void connectWithToken()}
            className="mt-3 self-start rounded-lg border border-border px-4 py-2.5 disabled:opacity-50"
          >
            <Text className="text-sm font-medium text-foreground">
              {busy === "token" ? "Connecting…" : "Connect with token"}
            </Text>
          </Pressable>
        </View>
      )}

      {notice ? <Text className="mt-3 text-xs text-muted-foreground">{notice}</Text> : null}
      {error ? <Text className="mt-3 text-xs text-destructive">{error}</Text> : null}
    </View>
  );
}
