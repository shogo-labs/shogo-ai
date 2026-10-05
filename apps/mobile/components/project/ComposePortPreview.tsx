// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { createHttpClient } from "../../lib/api";

interface ExposedPort {
  port: number;
  label?: string;
  protocol: "http" | "tcp";
  visibility: "tunnel" | "preview";
  previewUrl?: string;
}

/**
 * Preview for a docker-compose project. The runtime root serves Shogo's own
 * UI, so the iframe loads the public URL of an http port whose visibility
 * is preview. The user can switch ports and add one the stack didn't declare.
 */
export function ComposePortPreview({ projectId }: { projectId: string }) {
  const [ports, setPorts] = useState<ExposedPort[]>([]);
  const [listening, setListening] = useState<number[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftPort, setDraftPort] = useState("");
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    const http = createHttpClient();
    const res = await http.get<{ ports?: ExposedPort[] }>(`/api/projects/${projectId}/ports`);
    if (res.status >= 400) throw new Error("Could not load ports");
    const next = res.data?.ports ?? [];
    setPorts(next);
    setSelected((current) => {
      if (current && next.some((p) => p.port === current && p.previewUrl)) return current;
      return next.find((p) => p.visibility === "preview" && p.previewUrl)?.port ?? null;
    });
    try {
      const heard = await http.get<{ ports?: number[] }>(`/api/projects/${projectId}/ports/listening`);
      setListening(heard.status < 400 ? heard.data?.ports ?? [] : []);
    } catch {
      setListening([]);
    }
  }, [projectId]);

  useEffect(() => {
    void reload().catch((err) => setError(err?.message ?? "Could not load ports"));
    const timer = setInterval(() => void reload().catch(() => {}), 8000);
    return () => clearInterval(timer);
  }, [reload]);

  const preview = ports.find((p) => p.port === selected && p.previewUrl);
  const exposed = new Set(ports.map((p) => p.port));
  const hint = listening.find((port) => !exposed.has(port) && port !== 8080 && port !== 9900);

  async function setVisibility(port: number, visibility: "tunnel" | "preview") {
    setError(null);
    const http = createHttpClient();
    const res = await http.patch<{ error?: { message?: string } }>(`/api/projects/${projectId}/ports/${port}`, { visibility });
    if (res.status >= 400) {
      setError(res.data?.error?.message ?? "Could not update the port");
      return;
    }
    await reload();
  }

  async function addPort(port: number) {
    setAdding(true);
    setError(null);
    try {
      const http = createHttpClient();
      const res = await http.post<{ error?: { message?: string } }>(`/api/projects/${projectId}/ports`, {
        port,
        protocol: "http",
        label: "app",
      });
      if (res.status >= 400) {
        setError(res.data?.error?.message ?? "Could not add the port");
        return;
      }
      setDraftPort("");
      await reload();
      setSelected(port);
    } finally {
      setAdding(false);
    }
  }

  return (
    <View className="flex-1 bg-background">
      <View className="flex-row flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {ports.map((port) => (
          <Pressable
            key={port.port}
            onPress={() => port.previewUrl && setSelected(port.port)}
            className={`rounded-md px-2 py-1 ${port.port === selected ? "bg-primary" : "bg-muted"}`}
          >
            <Text className={port.port === selected ? "text-primary-foreground text-xs" : "text-foreground text-xs"}>
              {port.label ? `${port.label} ` : ""}
              {port.port}
              {port.visibility === "tunnel" ? " · private" : ""}
            </Text>
          </Pressable>
        ))}
        <TextInput
          value={draftPort}
          onChangeText={setDraftPort}
          placeholder="port"
          keyboardType="number-pad"
          className="w-16 rounded-md border border-border px-2 py-1 text-xs text-foreground"
        />
        <Pressable
          disabled={adding}
          onPress={() => {
            const port = Number(draftPort);
            if (Number.isInteger(port)) void addPort(port);
          }}
          className="rounded-md bg-muted px-2 py-1"
        >
          <Text className="text-xs text-foreground">Add port</Text>
        </Pressable>
      </View>
      {hint ? (
        <Pressable onPress={() => void addPort(hint)} className="bg-muted px-3 py-2">
          <Text className="text-xs text-foreground">
            Your app is listening on {hint}. Expose it?
          </Text>
        </Pressable>
      ) : null}
      {error ? <Text className="px-3 py-2 text-xs text-destructive">{error}</Text> : null}
      {preview?.previewUrl && preview.visibility === "preview" ? (
        Platform.OS === "web" ? (
          <iframe
            title={`Port ${preview.port}`}
            src={preview.previewUrl}
            style={{ flex: 1, width: "100%", height: "100%", border: 0 }}
          />
        ) : (
          <View className="flex-1 items-center justify-center px-6">
            <Text className="text-center text-sm text-foreground">{preview.previewUrl}</Text>
          </View>
        )
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-sm text-muted-foreground">
            {ports.some((p) => p.protocol === "http" && p.visibility === "tunnel")
              ? "This port is private. Make it a preview to show it here."
              : "Start the stack, then the preview appears on its port."}
          </Text>
          {ports
            .filter((p) => p.protocol === "http" && p.visibility === "tunnel")
            .slice(0, 1)
            .map((p) => (
              <Pressable key={p.port} onPress={() => void setVisibility(p.port, "preview")} className="mt-3 rounded-md bg-primary px-3 py-2">
                <Text className="text-xs text-primary-foreground">Show port {p.port} in the preview</Text>
              </Pressable>
            ))}
        </View>
      )}
    </View>
  );
}
