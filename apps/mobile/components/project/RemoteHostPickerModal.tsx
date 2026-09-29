// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Folder,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
} from "lucide-react-native";
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContent,
  ModalFooter,
} from "@/components/ui/modal";
import { Text } from "@/components/ui/text";
import {
  Button,
  ButtonIcon,
  ButtonSpinner,
  ButtonText,
} from "@/components/ui/button";
import { Input, InputField } from "@/components/ui/input";
import { cn } from "@shogo/shared-ui/primitives";
import { useDomainHttp } from "../../contexts/domain";
import { api, type RemoteDirectoryEntry, type RemoteHost } from "../../lib/api";
import { openInWorkspace } from "../../lib/switch-workspace";
import { TransferModalHeader } from "./transfer-modal-parts";
import { getRemoteParentPath } from "./remote-host-picker-utils";

export { getRemoteParentPath } from "./remote-host-picker-utils";

type RemotePickerStep = "hosts" | "add" | "browse";

interface RemoteHostPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId?: string;
  onOpenProject: (project: { id: string; name: string }) => void;
}

/**
 * The API deliberately returns SSH-config aliases without database ids. An
 * alias is saved as a normal host the first time it is used, which lets the
 * same connect/browse/create flow handle both sources without exposing an
 * alternate route contract to the renderer.
 */
function isSavedHost(host: RemoteHost): host is RemoteHost & { id: string } {
  return typeof host.id === "string" && host.id.length > 0;
}

function remoteHostTitle(host: RemoteHost): string {
  return host.label.trim() || host.alias?.trim() || host.sshTarget;
}

function remoteHostSubtitle(host: RemoteHost): string {
  const target = host.sshTarget;
  const details = [
    host.source === "ssh-config" ? "SSH config alias" : "Saved host",
    target,
    host.port ? `port ${host.port}` : null,
  ].filter(Boolean);
  return details.join(" · ");
}

function authenticationErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return `${raw || "SSH connection failed"}\n\nCheck the host, SSH agent, identity path, and known-hosts configuration, then try again.`;
}

export function RemoteHostPickerModal({
  open,
  onOpenChange,
  workspaceId,
  onOpenProject,
}: RemoteHostPickerModalProps) {
  const router = useRouter();
  const http = useDomainHttp();
  const [step, setStep] = useState<RemotePickerStep>("hosts");
  const [hosts, setHosts] = useState<RemoteHost[] | null>(null);
  const [selectedHost, setSelectedHost] = useState<RemoteHost | null>(null);
  const [currentPath, setCurrentPath] = useState("~");
  const [entries, setEntries] = useState<RemoteDirectoryEntry[]>([]);
  const [projectName, setProjectName] = useState("");
  const [label, setLabel] = useState("");
  const [sshTarget, setSshTarget] = useState("");
  const [port, setPort] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askpassHostId, setAskpassHostId] = useState<string | null>(null);
  const [askpassPrompt, setAskpassPrompt] = useState<{
    prompt: string;
    createdAt?: number;
  } | null>(null);
  const [askpassAnswer, setAskpassAnswer] = useState("");

  const loadHosts = useCallback(async () => {
    setHosts(null);
    setError(null);
    try {
      setHosts(await api.listRemoteHosts(http));
    } catch (cause) {
      setHosts([]);
      setError("Remote hosts are unavailable in this desktop session.");
    }
  }, [http]);

  useEffect(() => {
    if (!open) return;
    setStep("hosts");
    setSelectedHost(null);
    setCurrentPath("~");
    setEntries([]);
    setProjectName("");
    setLabel("");
    setSshTarget("");
    setPort("");
    setIdentityFile("");
    setBusy(false);
    setAskpassHostId(null);
    setAskpassPrompt(null);
    setAskpassAnswer("");
    void loadHosts();
  }, [loadHosts, open]);

  useEffect(() => {
    if (!open || !busy || !askpassHostId) {
      setAskpassPrompt(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await api.getRemoteAskpassPrompt(http, askpassHostId);
        if (cancelled) return;
        setAskpassPrompt(
          result.pending && result.prompt
            ? { prompt: result.prompt, createdAt: result.createdAt }
            : null,
        );
      } catch {
        // The connection request remains authoritative; polling is best effort.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 350);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [askpassHostId, busy, http, open]);

  const close = useCallback(() => {
    if (!busy) onOpenChange(false);
  }, [busy, onOpenChange]);

  const finishWithProject = useCallback(
    (result: {
      project?: { id?: string; name?: string; workspaceId?: string };
      redirectedFromWorkspaceId?: string;
    }) => {
      const project = result.project;
      if (!project?.id)
        throw new Error("Remote project was not returned by the server");

      onOpenChange(false);
      const name = project.name?.trim() || "Untitled";
      if (result.redirectedFromWorkspaceId && project.workspaceId) {
        openInWorkspace(
          router,
          project.workspaceId,
          `/(app)/projects/${project.id}`,
          workspaceId,
        );
      } else {
        onOpenProject({ id: project.id, name });
      }
    },
    [onOpenChange, onOpenProject, router, workspaceId],
  );

  const browse = useCallback(
    async (host: RemoteHost, path?: string) => {
      if (!isSavedHost(host)) throw new Error("Remote host has not been saved");
      setBusy(true);
      setError(null);
      setAskpassHostId(host.id);
      setAskpassAnswer("");
      try {
        const result = await api.browseRemoteHost(http, host.id, path);
        setSelectedHost(host);
        setCurrentPath(result.path);
        setEntries(result.entries);
        setStep("browse");
      } catch (cause) {
        setError(authenticationErrorMessage(cause));
      } finally {
        setBusy(false);
        setAskpassHostId(null);
      }
    },
    [http],
  );

  const connectHost = useCallback(
    async (host: RemoteHost) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        let savedHost: RemoteHost & { id: string };
        const wasSshConfigAlias = !isSavedHost(host);
        if (!wasSshConfigAlias) {
          savedHost = host;
        } else {
          const createdHost = await api.createRemoteHost(http, {
            label: remoteHostTitle(host),
            sshTarget: host.sshTarget,
            ...(host.port ? { port: host.port } : {}),
            ...(host.identityFile ? { identityFile: host.identityFile } : {}),
          });
          if (!isSavedHost(createdHost)) {
            throw new Error("Remote host was not saved by the server");
          }
          savedHost = createdHost;
        }
        setAskpassHostId(savedHost.id);
        setAskpassAnswer("");
        const result = await api.connectRemoteHost(http, savedHost.id);
        const connectedHost = {
          ...savedHost,
          ...result.host,
          id: savedHost.id,
          source: "saved" as const,
        };
        if (wasSshConfigAlias) {
          setHosts((current) =>
            current ? [connectedHost, ...current] : current,
          );
        }
        const directory = await api.browseRemoteHost(http, savedHost.id);
        setSelectedHost(connectedHost);
        setCurrentPath(directory.path);
        setEntries(directory.entries);
        setStep("browse");
      } catch (cause) {
        setError(authenticationErrorMessage(cause));
      } finally {
        setBusy(false);
        setAskpassHostId(null);
      }
    },
    [busy, http],
  );

  const handleAddHost = useCallback(async () => {
    const cleanLabel = label.trim();
    const cleanTarget = sshTarget.trim();
    const numericPort = port.trim() ? Number(port.trim()) : undefined;
    if (!cleanLabel || !cleanTarget) {
      setError("Enter a label and a user@host or SSH alias.");
      return;
    }
    if (
      numericPort !== undefined &&
      (!Number.isInteger(numericPort) ||
        numericPort < 1 ||
        numericPort > 65_535)
    ) {
      setError("Port must be a number between 1 and 65535.");
      return;
    }
    await connectHost({
      label: cleanLabel,
      sshTarget: cleanTarget,
      ...(numericPort === undefined ? {} : { port: numericPort }),
      ...(identityFile.trim() ? { identityFile: identityFile.trim() } : {}),
    });
  }, [connectHost, identityFile, label, port, sshTarget]);

  const handleCreateProject = useCallback(async () => {
    if (
      !selectedHost ||
      !isSavedHost(selectedHost) ||
      !currentPath.trim() ||
      busy
    )
      return;
    setBusy(true);
    setError(null);
    setAskpassHostId(selectedHost.id);
    setAskpassAnswer("");
    try {
      const result = await api.createRemoteFolderProject(http, {
        workspaceId,
        remoteHostId: selectedHost.id,
        path: currentPath,
        ...(projectName.trim() ? { name: projectName.trim() } : {}),
      });
      finishWithProject(result);
    } catch (cause) {
      setError(authenticationErrorMessage(cause));
    } finally {
      setBusy(false);
      setAskpassHostId(null);
    }
  }, [
    busy,
    currentPath,
    finishWithProject,
    http,
    projectName,
    selectedHost,
    workspaceId,
  ]);

  const parentPath = useMemo(
    () => getRemoteParentPath(currentPath),
    [currentPath],
  );
  const title =
    step === "add"
      ? "Add remote host"
      : step === "browse"
        ? "Choose remote folder"
        : "Connect to Remote Host";

  return (
    <Modal isOpen={open} onClose={close} size="md">
      <ModalBackdrop />
      <ModalContent className="bg-background-0 p-0">
        <TransferModalHeader icon={Server} title={title} showClose={!busy} />

        <ModalBody className="px-6 py-5" contentContainerClassName="gap-4">
          {askpassPrompt && askpassHostId && (
            <AskpassPromptState
              prompt={askpassPrompt.prompt}
              answer={askpassAnswer}
              onAnswer={setAskpassAnswer}
              onSubmit={async () => {
                try {
                  await api.respondRemoteAskpass(
                    http,
                    askpassHostId,
                    askpassAnswer,
                  );
                  setAskpassAnswer("");
                  setAskpassPrompt(null);
                } catch (cause) {
                  setError(authenticationErrorMessage(cause));
                }
              }}
              disabled={!busy}
            />
          )}
          {step === "hosts" && (
            <>
              <Text className="text-sm text-typography-600 leading-relaxed">
                Connect to a Linux host over SSH and choose a remote folder for
                this project.
              </Text>
              {hosts === null ? (
                <LoadingState label="Loading saved hosts…" />
              ) : (
                <>
                  {error && <ErrorState message={error} />}
                  {hosts.length > 0 ? (
                    <View className="rounded-xl border border-outline-100 bg-background-50 overflow-hidden">
                      {hosts.map((host, index) => (
                        <HostRow
                          key={`${host.id ?? host.alias ?? host.sshTarget}-${index}`}
                          host={host}
                          disabled={busy}
                          onPress={() => void connectHost(host)}
                        />
                      ))}
                    </View>
                  ) : (
                    <EmptyHostsState />
                  )}
                  <Pressable
                    onPress={() => {
                      setError(null);
                      setStep("add");
                    }}
                    disabled={busy}
                    className="flex-row items-center justify-center gap-2 rounded-lg border border-dashed border-outline-200 px-4 py-3 active:bg-background-100"
                  >
                    <Plus size={15} className="text-primary-500" />
                    <Text className="text-sm font-medium text-primary-600">
                      Add a host
                    </Text>
                  </Pressable>
                </>
              )}
            </>
          )}

          {step === "add" && (
            <>
              <Text className="text-sm text-typography-600 leading-relaxed">
                Use a full SSH target such as{" "}
                <Text className="font-mono text-xs">deploy@example.com</Text> or
                an alias from{" "}
                <Text className="font-mono text-xs">~/.ssh/config</Text>.
              </Text>
              <View className="gap-2">
                <FieldLabel text="Label" required />
                <Input>
                  <InputField
                    placeholder="Production server"
                    value={label}
                    onChangeText={setLabel}
                    editable={!busy}
                    autoCorrect={false}
                  />
                </Input>
                <FieldLabel text="user@host or SSH alias" required />
                <Input>
                  <InputField
                    placeholder="deploy@example.com"
                    value={sshTarget}
                    onChangeText={setSshTarget}
                    editable={!busy}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </Input>
                <View className="flex-row gap-2">
                  <View className="flex-1 gap-2">
                    <FieldLabel text="Port (optional)" />
                    <Input>
                      <InputField
                        placeholder="22"
                        value={port}
                        onChangeText={setPort}
                        editable={!busy}
                        keyboardType="number-pad"
                      />
                    </Input>
                  </View>
                  <View className="flex-[2] gap-2">
                    <FieldLabel text="Identity path (optional)" />
                    <Input>
                      <InputField
                        placeholder="~/.ssh/id_ed25519"
                        value={identityFile}
                        onChangeText={setIdentityFile}
                        editable={!busy}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    </Input>
                  </View>
                </View>
              </View>
              {error && <ErrorState message={error} />}
            </>
          )}

          {step === "browse" && selectedHost && (
            <>
              <View className="flex-row items-center gap-2">
                <View className="h-8 w-8 items-center justify-center rounded-md bg-primary-500/10">
                  <KeyRound size={15} className="text-primary-500" />
                </View>
                <View className="flex-1 min-w-0">
                  <Text
                    className="text-sm font-medium text-typography-900"
                    numberOfLines={1}
                  >
                    {remoteHostTitle(selectedHost)}
                  </Text>
                  <Text
                    className="text-[11px] text-typography-500"
                    numberOfLines={1}
                  >
                    {selectedHost.sshTarget}
                  </Text>
                </View>
              </View>
              <View className="flex-row items-center gap-2">
                <Pressable
                  onPress={() => setStep("hosts")}
                  disabled={busy}
                  className="h-8 w-8 items-center justify-center rounded-md active:bg-background-100"
                  accessibilityLabel="Choose another remote host"
                >
                  <ArrowLeft size={15} className="text-typography-500" />
                </Pressable>
                <View className="flex-1 rounded-md border border-outline-100 bg-background-50 px-3 py-2">
                  <Text
                    className="font-mono text-xs text-typography-800"
                    numberOfLines={1}
                  >
                    {currentPath}
                  </Text>
                </View>
                {parentPath && (
                  <Pressable
                    onPress={() => void browse(selectedHost, parentPath)}
                    disabled={busy}
                    className="h-8 w-8 items-center justify-center rounded-md active:bg-background-100"
                    accessibilityLabel="Go to parent directory"
                  >
                    <ArrowUp size={15} className="text-typography-500" />
                  </Pressable>
                )}
              </View>
              <View className="rounded-xl border border-outline-100 bg-background-50 overflow-hidden">
                {busy && entries.length === 0 ? (
                  <LoadingState label="Connecting to host…" />
                ) : entries.length === 0 ? (
                  <Text className="px-4 py-8 text-center text-xs text-typography-500">
                    No child directories found. You can still use this folder.
                  </Text>
                ) : (
                  <ScrollView
                    className="max-h-[250px]"
                    showsVerticalScrollIndicator={false}
                  >
                    {entries.map((entry) => (
                      <Pressable
                        key={entry.path}
                        onPress={() => void browse(selectedHost, entry.path)}
                        disabled={busy}
                        className="flex-row items-center gap-3 border-b border-outline-100 px-4 py-3 active:bg-background-100"
                      >
                        <Folder size={15} className="text-primary-500" />
                        <Text
                          className="flex-1 text-sm text-typography-800"
                          numberOfLines={1}
                        >
                          {entry.name}
                        </Text>
                        <ChevronRight
                          size={15}
                          className="text-typography-400"
                        />
                      </Pressable>
                    ))}
                  </ScrollView>
                )}
              </View>
              <View className="gap-2">
                <FieldLabel text="Project name (optional)" />
                <Input>
                  <InputField
                    placeholder={
                      currentPath === "~"
                        ? "Remote project"
                        : currentPath.split("/").pop() || "Remote project"
                    }
                    value={projectName}
                    onChangeText={setProjectName}
                    editable={!busy}
                  />
                </Input>
              </View>
              {error && <ErrorState message={error} />}
            </>
          )}
        </ModalBody>

        <ModalFooter className="px-6 py-4 border-t border-outline-100 gap-2">
          {step === "hosts" && (
            <>
              <Button variant="outline" onPress={close} disabled={busy}>
                <ButtonText>Cancel</ButtonText>
              </Button>
              <Button
                variant="outline"
                onPress={() => void loadHosts()}
                disabled={busy || hosts === null}
              >
                <ButtonIcon as={RefreshCw} />
                <ButtonText>Refresh</ButtonText>
              </Button>
            </>
          )}
          {step === "add" && (
            <>
              <Button
                variant="outline"
                onPress={() => setStep("hosts")}
                disabled={busy}
              >
                <ButtonText>Back</ButtonText>
              </Button>
              <Button
                onPress={() => void handleAddHost()}
                disabled={busy || !label.trim() || !sshTarget.trim()}
              >
                {busy ? (
                  <ButtonSpinner className="text-typography-0" />
                ) : (
                  <ButtonIcon as={Plus} className="text-typography-0" />
                )}
                <ButtonText>
                  {busy ? "Connecting…" : "Add and connect"}
                </ButtonText>
              </Button>
            </>
          )}
          {step === "browse" && (
            <>
              <Button variant="outline" onPress={close} disabled={busy}>
                <ButtonText>Cancel</ButtonText>
              </Button>
              <Button
                onPress={() => void handleCreateProject()}
                disabled={busy || !selectedHost}
              >
                {busy ? (
                  <ButtonSpinner className="text-typography-0" />
                ) : (
                  <ButtonIcon as={Folder} className="text-typography-0" />
                )}
                <ButtonText>
                  {busy ? "Creating…" : "Use this folder"}
                </ButtonText>
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function FieldLabel({
  text,
  required = false,
}: {
  text: string;
  required?: boolean;
}) {
  return (
    <Text className="text-xs font-medium text-typography-700">
      {text}
      {required ? <Text className="text-error-500"> *</Text> : null}
    </Text>
  );
}

function HostRow({
  host,
  disabled,
  onPress,
}: {
  host: RemoteHost;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={cn(
        "flex-row items-center gap-3 px-4 py-3 active:bg-background-100",
        disabled && "opacity-50",
      )}
    >
      <View className="h-8 w-8 items-center justify-center rounded-md bg-primary-500/10">
        <Server size={15} className="text-primary-500" />
      </View>
      <View className="flex-1 min-w-0">
        <Text
          className="text-sm font-medium text-typography-900"
          numberOfLines={1}
        >
          {remoteHostTitle(host)}
        </Text>
        <Text className="text-[11px] text-typography-500" numberOfLines={1}>
          {remoteHostSubtitle(host)}
        </Text>
      </View>
      {disabled ? (
        <ActivityIndicator size="small" />
      ) : (
        <ChevronRight size={15} className="text-typography-400" />
      )}
    </Pressable>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <View className="items-center justify-center gap-3 py-10">
      <ActivityIndicator size="small" />
      <Text className="text-xs text-typography-500">{label}</Text>
    </View>
  );
}

function EmptyHostsState() {
  return (
    <View className="items-center gap-2 py-8">
      <View className="h-12 w-12 items-center justify-center rounded-full bg-background-100">
        <Server size={22} className="text-typography-500" />
      </View>
      <Text className="text-sm font-medium text-typography-900">
        No saved hosts yet
      </Text>
      <Text className="px-4 text-center text-xs leading-relaxed text-typography-500">
        Add a host here or define an alias in your SSH config.
      </Text>
    </View>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <View className="flex-row items-start gap-2 rounded-lg bg-error-500/10 px-3 py-2.5">
      <AlertTriangle size={15} className="mt-0.5 text-error-500" />
      <Text className="flex-1 text-xs leading-relaxed text-error-600">
        {message}
      </Text>
    </View>
  );
}

function AskpassPromptState({
  prompt,
  answer,
  onAnswer,
  onSubmit,
  disabled,
}: {
  prompt: string;
  answer: string;
  onAnswer: (answer: string) => void;
  onSubmit: () => void | Promise<void>;
  disabled: boolean;
}) {
  return (
    <View className="gap-2 rounded-lg border border-primary-200 bg-primary-500/5 px-3 py-3">
      <View className="flex-row items-start gap-2">
        <KeyRound size={15} className="mt-0.5 text-primary-500" />
        <Text className="flex-1 text-xs leading-relaxed text-typography-800">
          {prompt.trim() || "SSH authentication is required."}
        </Text>
      </View>
      <View className="flex-row items-center gap-2">
        <Input className="flex-1">
          <InputField
            value={answer}
            onChangeText={onAnswer}
            editable={!disabled}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!/yes|no|fingerprint|continue/i.test(prompt)}
            onSubmitEditing={() => void onSubmit()}
          />
        </Input>
        <Button onPress={() => void onSubmit()} disabled={disabled || !answer}>
          <ButtonText>Send</ButtonText>
        </Button>
      </View>
    </View>
  );
}
