// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AppStoresSection - ship an Expo project to the App Store / Google Play.
 *
 * Rendered as Settings → Publishing → App stores. It does NOT build anything:
 * the agent does that through the `publish` tool (`target: "ios" | "android"`),
 * because a store build is a 20-minute job the user starts by asking for it.
 * This page is where the two things a build needs are set up:
 *
 *  - the **app identifiers** (bundle id, Android package, optional ASC app id),
 *    which we cannot guess and which lock once a build has been sent to Expo;
 *  - the **store credentials** (Apple App Store Connect key, Google Play
 *    service account, and — only in `byok` — an Expo token).
 *
 * Every credential read returns a mask; the plaintext never comes back here.
 */

import { useCallback, useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, ActivityIndicator, Alert, Linking } from 'react-native'
import {
  CheckCircle,
  KeyRound,
  AlertTriangle,
  Trash2,
  Smartphone,
  Send,
  ChevronRight,
  XCircle,
  Clock,
} from 'lucide-react-native'
import type { HttpClient } from '@shogo-ai/sdk'
import { cn } from '@shogo/shared-ui/primitives'
import {
  api,
  type NativeApp,
  type NativeCredential,
  type NativeCredentialKind,
  type NativeReleaseMode,
  type NativeReleaseRow,
} from '../../lib/api'

/** Store-setup walkthrough (docs.shogo.ai). */
const SETUP_GUIDE_URL = 'https://docs.shogo.ai/features/native-release'

/** How often to refresh while a release is still running. */
const POLL_MS = 15_000

interface AppStoresSectionProps {
  projectId: string
  /** Store credentials belong to the workspace, not the project. */
  workspaceId?: string
  http: HttpClient
  embedded?: boolean
}

/** Human label + a yes/no for each credential kind. */
const CREDENTIAL_COPY: Record<
  NativeCredentialKind,
  { title: string; why: string; fields: { name: string; label: string; multiline?: boolean; secret?: boolean }[] }
> = {
  asc_api_key: {
    title: 'Apple App Store Connect key',
    why: 'Uploads your build and submits it for review. Create it in App Store Connect → Users and Access → Integrations.',
    fields: [
      { name: 'keyP8', label: '.p8 key file', multiline: true, secret: true },
      { name: 'keyId', label: 'Key ID' },
      { name: 'issuerId', label: 'Issuer ID' },
      { name: 'teamId', label: 'Apple team ID' },
    ],
  },
  play_service_account: {
    title: 'Google Play service account',
    why: 'Uploads your Android app bundle and creates the release. Create it in Google Cloud, then grant it release access in Play Console → Setup → API access.',
    fields: [{ name: 'json', label: 'Service-account JSON', multiline: true, secret: true }],
  },
  expo_token: {
    title: 'Expo access token',
    why: 'Only needed on deployments that build with your own Expo account instead of Shogo’s.',
    fields: [{ name: 'token', label: 'EXPO_TOKEN', secret: true }],
  },
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  building: 'Building',
  testing: 'Running tests',
  submitting: 'Submitting',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function formatWhen(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 60_000) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function AppStoresSection({ projectId, workspaceId, http, embedded = false }: AppStoresSectionProps) {
  const [mode, setMode] = useState<NativeReleaseMode>('cloud')
  const [app, setApp] = useState<NativeApp | null>(null)
  const [credentials, setCredentials] = useState<NativeCredential[]>([])
  const [releases, setReleases] = useState<NativeReleaseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [bundleIdentifier, setBundleIdentifier] = useState('')
  const [androidPackage, setAndroidPackage] = useState('')
  const [savingIds, setSavingIds] = useState(false)

  // One draft per credential kind, so switching cards never loses a paste.
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({})
  const [savingKind, setSavingKind] = useState<NativeCredentialKind | null>(null)

  const load = useCallback(async () => {
    try {
      const [appRes, releaseRows] = await Promise.all([
        api.getNativeApp(http, projectId),
        api.listNativeReleases(http, projectId).catch(() => [] as NativeReleaseRow[]),
      ])
      setMode(appRes.mode)
      setApp(appRes.app)
      setBundleIdentifier(appRes.app?.bundleIdentifier ?? '')
      setAndroidPackage(appRes.app?.androidPackage ?? '')
      setReleases(releaseRows)
      if (workspaceId) {
        const creds = await api.getNativeCredentials(http, workspaceId).catch(() => null)
        if (creds) setCredentials(creds.credentials)
      }
      setError(null)
    } catch (err: any) {
      setError(err?.message || 'Could not load the app store settings.')
    } finally {
      setLoading(false)
    }
  }, [http, projectId, workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  // A release is asynchronous; refresh while one is still moving so the user
  // sees the step change without pulling to refresh.
  const inFlight = releases.some((r) => r.status !== 'done' && r.status !== 'failed' && r.status !== 'cancelled')
  useEffect(() => {
    if (!inFlight) return
    const timer = setInterval(() => {
      api.listNativeReleases(http, projectId).then(setReleases).catch(() => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [inFlight, http, projectId])

  const saveIds = async () => {
    setSavingIds(true)
    setError(null)
    try {
      const next = await api.saveNativeApp(http, projectId, {
        bundleIdentifier: bundleIdentifier.trim(),
        androidPackage: androidPackage.trim(),
      })
      setApp(next)
    } catch (err: any) {
      setError(err?.message || 'Could not save those identifiers.')
    } finally {
      setSavingIds(false)
    }
  }

  const saveCredential = async (kind: NativeCredentialKind) => {
    if (!workspaceId) return
    setSavingKind(kind)
    setError(null)
    try {
      const draft = drafts[kind] ?? {}
      const credential = await api.saveNativeCredential(http, workspaceId, kind, draft)
      setCredentials((prev) => [...prev.filter((c) => c.kind !== kind), credential])
      setDrafts((prev) => ({ ...prev, [kind]: {} }))
    } catch (err: any) {
      // The API validates against Apple/Google on save, so this message is the
      // provider's own reason — show it verbatim rather than replacing it.
      setError(err?.message || 'That key was refused.')
    } finally {
      setSavingKind(null)
    }
  }

  const removeCredential = (kind: NativeCredentialKind) => {
    if (!workspaceId) return
    Alert.alert('Remove this key?', `${CREDENTIAL_COPY[kind].title} will be deleted. Existing releases keep running.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteNativeCredential(http, workspaceId, kind)
            setCredentials((prev) => prev.filter((c) => c.kind !== kind))
          } catch (err: any) {
            setError(err?.message || 'Could not remove that key.')
          }
        },
      },
    ])
  }

  const idsLocked = Boolean(app?.idsLockedAt)
  const hasAsc = credentials.some((c) => c.kind === 'asc_api_key')
  const hasPlay = credentials.some((c) => c.kind === 'play_service_account')
  const kinds: NativeCredentialKind[] =
    mode === 'byok' ? ['asc_api_key', 'play_service_account', 'expo_token'] : ['asc_api_key', 'play_service_account']

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center py-16">
        <ActivityIndicator />
      </View>
    )
  }

  return (
    <View className={cn('gap-5', embedded ? 'p-0' : 'p-4 sm:p-6')}>
      <View>
        <Text className="text-lg font-semibold text-foreground">App stores</Text>
        <Text className="mt-1 text-[13px] leading-5 text-muted-foreground">
          Ask Shogo to ship your app — “publish to the App Store” — and it builds a test version, runs your
          Maestro flows, and only submits to the store if they pass. Set up the two things below first.
        </Text>
        <Pressable onPress={() => Linking.openURL(SETUP_GUIDE_URL)} className="mt-2 flex-row items-center gap-1">
          <Text className="text-xs text-primary">How shipping works</Text>
          <ChevronRight size={12} className="text-primary" />
        </Pressable>
      </View>

      {error && (
        <View className="rounded-lg border border-destructive/20 bg-destructive/10 p-3">
          <Text className="text-xs text-destructive">{error}</Text>
        </View>
      )}

      {/* App identifiers */}
      <View className="rounded-xl border border-border p-4">
        <View className="mb-1 flex-row items-center gap-2">
          <Smartphone size={15} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-foreground">App identifiers</Text>
        </View>
        <Text className="mb-3 text-[11px] leading-4 text-muted-foreground">
          The reverse-domain ids your app is published under. We cannot invent them — pick the same ones you
          use in App Store Connect and the Play Console.
        </Text>

        <Text className="mb-1 text-xs font-medium text-foreground">iOS bundle identifier</Text>
        <TextInput
          value={bundleIdentifier}
          onChangeText={setBundleIdentifier}
          editable={!idsLocked}
          placeholder="ai.shogo.myapp"
          placeholderTextColor="#9ca3af"
          autoCapitalize="none"
          autoCorrect={false}
          className={cn(
            'mb-3 h-10 rounded-lg border border-border px-3 text-sm text-foreground web:outline-none',
            idsLocked && 'opacity-60',
          )}
        />

        <Text className="mb-1 text-xs font-medium text-foreground">Android package name</Text>
        <TextInput
          value={androidPackage}
          onChangeText={setAndroidPackage}
          editable={!idsLocked}
          placeholder="ai.shogo.myapp"
          placeholderTextColor="#9ca3af"
          autoCapitalize="none"
          autoCorrect={false}
          className={cn(
            'h-10 rounded-lg border border-border px-3 text-sm text-foreground web:outline-none',
            idsLocked && 'opacity-60',
          )}
        />

        {idsLocked ? (
          <View className="mt-3 flex-row items-start gap-2 rounded-lg bg-muted p-3">
            <AlertTriangle size={13} className="mt-0.5 text-muted-foreground" />
            <Text className="flex-1 text-[11px] leading-4 text-muted-foreground">
              These are locked because a build has already been sent to Expo. Renaming them now would ship a
              different app; start a new project to change them.
            </Text>
          </View>
        ) : (
          <Pressable
            onPress={saveIds}
            disabled={savingIds || (!bundleIdentifier.trim() && !androidPackage.trim())}
            className={cn(
              'mt-3 h-9 flex-row items-center justify-center gap-1.5 rounded-lg',
              savingIds || (!bundleIdentifier.trim() && !androidPackage.trim()) ? 'bg-muted' : 'bg-primary',
            )}
          >
            {savingIds ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text
                className={cn(
                  'text-xs font-medium',
                  savingIds || (!bundleIdentifier.trim() && !androidPackage.trim())
                    ? 'text-muted-foreground'
                    : 'text-primary-foreground',
                )}
              >
                Save identifiers
              </Text>
            )}
          </Pressable>
        )}
      </View>

      {/* Credentials */}
      <View className="gap-3">
        <View className="flex-row items-center gap-2">
          <KeyRound size={15} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-foreground">Store access</Text>
        </View>
        {mode === 'cloud' && (
          <Text className="-mt-1 text-[11px] leading-4 text-muted-foreground">
            Keys are encrypted at rest and used only by the release that needs them. They are never included in
            your project or your app.
          </Text>
        )}
        {!workspaceId && (
          <Text className="-mt-1 text-[11px] text-muted-foreground">
            Sign in to a workspace to store store-access keys.
          </Text>
        )}

        {kinds.map((kind) => {
          const copy = CREDENTIAL_COPY[kind]
          const stored = credentials.find((c) => c.kind === kind)
          const draft = drafts[kind] ?? {}
          const ready = copy.fields.every((f) => (draft[f.name] ?? '').trim().length > 0)
          return (
            <View key={kind} className="rounded-xl border border-border p-4">
              <View className="mb-1 flex-row items-center justify-between">
                <Text className="text-sm font-medium text-foreground">{copy.title}</Text>
                {stored ? (
                  <View className="flex-row items-center gap-1">
                    <CheckCircle size={12} color="#10b981" />
                    <Text className="text-[11px] text-emerald-600 dark:text-emerald-400">Connected</Text>
                  </View>
                ) : (
                  <View className="flex-row items-center gap-1">
                    <Clock size={12} className="text-muted-foreground" />
                    <Text className="text-[11px] text-muted-foreground">Not set</Text>
                  </View>
                )}
              </View>
              <Text className="mb-2 text-[11px] leading-4 text-muted-foreground">{copy.why}</Text>

              {stored ? (
                <View className="flex-row items-center justify-between">
                  <Text className="font-mono text-[11px] text-muted-foreground">{stored.maskedHint}</Text>
                  <Pressable
                    onPress={() => removeCredential(kind)}
                    className="flex-row items-center gap-1 rounded-md px-2 py-1 active:bg-muted"
                  >
                    <Trash2 size={12} className="text-destructive" />
                    <Text className="text-[11px] text-destructive">Remove</Text>
                  </Pressable>
                </View>
              ) : (
                <View className="gap-2">
                  {copy.fields.map((field) => (
                    <View key={field.name}>
                      <Text className="mb-1 text-[11px] text-muted-foreground">{field.label}</Text>
                      <TextInput
                        value={draft[field.name] ?? ''}
                        onChangeText={(text) =>
                          setDrafts((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? {}), [field.name]: text } }))
                        }
                        multiline={field.multiline}
                        secureTextEntry={field.secret && !field.multiline}
                        autoCapitalize="none"
                        autoCorrect={false}
                        placeholder={field.multiline ? 'Paste it here' : ''}
                        placeholderTextColor="#9ca3af"
                        className={cn(
                          'rounded-lg border border-border px-3 text-xs text-foreground web:outline-none',
                          field.multiline ? 'min-h-[76px] py-2' : 'h-9',
                        )}
                      />
                    </View>
                  ))}
                  <Pressable
                    onPress={() => saveCredential(kind)}
                    disabled={!ready || savingKind === kind || !workspaceId}
                    className={cn(
                      'h-9 flex-row items-center justify-center rounded-lg',
                      ready && workspaceId && savingKind !== kind ? 'bg-primary' : 'bg-muted',
                    )}
                  >
                    {savingKind === kind ? (
                      <ActivityIndicator size="small" />
                    ) : (
                      <Text
                        className={cn(
                          'text-xs font-medium',
                          ready && workspaceId ? 'text-primary-foreground' : 'text-muted-foreground',
                        )}
                      >
                        Save key
                      </Text>
                    )}
                  </Pressable>
                </View>
              )}
            </View>
          )
        })}
      </View>

      {/* Readiness + release history */}
      <View className="rounded-xl border border-border p-4">
        <View className="mb-2 flex-row items-center gap-2">
          <Send size={15} className="text-muted-foreground" />
          <Text className="text-sm font-medium text-foreground">Releases</Text>
        </View>

        <View className="mb-3 gap-1">
          <ReadyRow ok={Boolean(app?.bundleIdentifier || app?.androidPackage)} label="App identifiers set" />
          <ReadyRow ok={hasAsc} label="Apple key added" />
          <ReadyRow ok={hasPlay} label="Google Play key added" />
        </View>

        {releases.length === 0 ? (
          <Text className="text-[11px] leading-4 text-muted-foreground">
            No releases yet. Ask Shogo in the chat to publish to the App Store or Google Play when you are
            ready.
          </Text>
        ) : (
          <View className="gap-2">
            {releases.slice(0, 5).map((release) => (
              <View key={release.id} className="rounded-lg border border-border/60 px-3 py-2">
                <View className="flex-row items-center justify-between">
                  <Text className="text-xs font-medium text-foreground">
                    {release.kind === 'update' ? 'Update' : 'Build'} · {release.track}
                  </Text>
                  <Text className="text-[11px] text-muted-foreground">{formatWhen(release.createdAt)}</Text>
                </View>
                <Text
                  className={cn(
                    'mt-0.5 text-[11px]',
                    release.status === 'failed'
                      ? 'text-destructive'
                      : release.status === 'done'
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-muted-foreground',
                  )}
                >
                  {STATUS_LABEL[release.status] ?? release.status}
                  {release.step ? ` · ${release.step}` : ''}
                  {release.testOutcome === 'failed' ? ' · tests failed, not submitted' : ''}
                </Text>
                {release.error && (
                  <Text numberOfLines={2} className="mt-1 text-[11px] text-destructive">
                    {release.error}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  )
}

/** A one-line ✓ / ✗ readiness check. Not a button — nothing to tap. */
function ReadyRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <View className="flex-row items-center gap-2">
      {ok ? (
        <CheckCircle size={12} color="#10b981" />
      ) : (
        <XCircle size={12} className="text-muted-foreground" />
      )}
      <Text className={cn('text-[11px]', ok ? 'text-foreground' : 'text-muted-foreground')}>{label}</Text>
    </View>
  )
}
