// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AuthDatabasePanel — manages the per-project sign-in allowlist for
 * users authenticating against this project via the Shogo SDK
 * (`shogo.auth` -> platform `/api/auth/*`). Lives under the project
 * Settings tab (`DATA` group -> `Auth & Database`).
 *
 * Two cards:
 *   1. Sign-in allowlist (mode + emails + domains)
 *   2. Users who have signed in (paginated, with revoke)
 *
 * Backed by `apps/api/src/routes/project-auth-config.ts`. The same
 * config is what the Better Auth before-hook in apps/api/src/auth.ts
 * consults on every project-scoped sign-in / sign-up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native'
import {
  AlertCircle,
  Check,
  Globe2,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserMinus,
  Users,
  X,
} from 'lucide-react-native'
import { Switch } from '@/components/ui/switch'
import { API_URL } from '../../../lib/api'

type AuthMode = 'anyone' | 'workspace' | 'custom'

interface AuthConfig {
  mode: AuthMode
  allowedEmails: string[]
  allowedDomains: string[]
  requireEmailVerification: boolean
}

interface AuthUserRow {
  userId: string
  email: string
  name: string | null
  emailVerified: boolean
  firstSignInAt: string
  lastSignInAt: string
  signInCount: number
  isWorkspaceMember: boolean
  isAllowlisted: boolean
}

const DEFAULT_CONFIG: AuthConfig = {
  mode: 'anyone',
  allowedEmails: [],
  allowedDomains: [],
  requireEmailVerification: false,
}

const MODE_OPTIONS: { id: AuthMode; label: string; description: string; icon: typeof ShieldCheck }[] = [
  {
    id: 'anyone',
    label: 'Anyone',
    description: 'No sign-in restrictions — anyone with a valid email can sign up.',
    icon: ShieldOff,
  },
  {
    id: 'workspace',
    label: 'Workspace members only',
    description: 'Only users who already belong to your workspace (or have a pending invite) can sign in.',
    icon: Users,
  },
  {
    id: 'custom',
    label: 'Custom allowlist',
    description: 'Allow specific emails and/or whole email domains.',
    icon: ShieldCheck,
  },
]

// Shared with apps/api/src/services/project-auth-config.service.ts.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/

interface AuthDatabasePanelProps {
  projectId: string
  visible?: boolean
}

export function AuthDatabasePanel({ projectId, visible = true }: AuthDatabasePanelProps) {
  if (!visible) return null
  return (
    <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 32 }}>
      <View className="px-4 pt-4 gap-4">
        <AllowlistCard projectId={projectId} />
        <UsersCard projectId={projectId} />
      </View>
    </ScrollView>
  )
}

// =============================================================================
// Allowlist card
// =============================================================================

function AllowlistCard({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<AuthConfig>(DEFAULT_CONFIG)
  const [original, setOriginal] = useState<AuthConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const dirty = useMemo(() => !configEquals(config, original), [config, original])

  const load = useCallback(async () => {
    if (!API_URL) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_URL}/api/projects/${projectId}/auth-config`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      const next = normalizeConfig(body?.config)
      setConfig(next)
      setOriginal(next)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load auth config')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  const save = useCallback(async () => {
    if (!API_URL) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`${API_URL}/api/projects/${projectId}/auth-config`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: config.mode,
          allowedEmails: config.allowedEmails,
          allowedDomains: config.allowedDomains,
          requireEmailVerification: config.requireEmailVerification,
        }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        throw new Error(payload?.error?.message ?? `HTTP ${res.status}`)
      }
      const payload = await res.json()
      const next = normalizeConfig(payload?.config)
      setConfig(next)
      setOriginal(next)
      setSavedAt(Date.now())
    } catch (err: any) {
      setError(err?.message ?? 'Failed to save auth config')
    } finally {
      setSaving(false)
    }
  }, [projectId, config])

  return (
    <View className="border border-border rounded-lg bg-card overflow-hidden">
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <ShieldCheck size={16} className="text-primary" />
        <Text className="text-sm font-semibold text-foreground flex-1">Sign-in allowlist</Text>
        {savedAt && Date.now() - savedAt < 3000 ? (
          <View className="flex-row items-center gap-1">
            <Check size={12} className="text-emerald-500" />
            <Text className="text-[11px] text-emerald-500">Saved</Text>
          </View>
        ) : null}
      </View>

      {loading ? (
        <View className="px-4 py-6 items-center">
          <ActivityIndicator size="small" />
        </View>
      ) : (
        <View className="p-4 gap-4">
          <Text className="text-xs text-muted-foreground">
            Controls who can sign in to this project via the Shogo SDK
            (<Text className="font-mono">shogo.auth.signIn</Text>). Does not affect sign-ins to studio.shogo.ai.
          </Text>

          <View className="gap-2">
            {MODE_OPTIONS.map(({ id, label, description, icon: Icon }) => {
              const active = config.mode === id
              return (
                <Pressable
                  key={id}
                  onPress={() => setConfig((c) => ({ ...c, mode: id }))}
                  className={`flex-row items-start gap-3 rounded-lg border px-3 py-2.5 ${
                    active
                      ? 'border-primary bg-primary/5'
                      : 'border-border active:bg-muted'
                  }`}
                >
                  <View
                    className={`w-8 h-8 rounded-md items-center justify-center ${
                      active ? 'bg-primary/15' : 'bg-muted'
                    }`}
                  >
                    <Icon size={15} className={active ? 'text-primary' : 'text-muted-foreground'} />
                  </View>
                  <View className="flex-1">
                    <Text
                      className={`text-xs font-semibold ${
                        active ? 'text-primary' : 'text-foreground'
                      }`}
                    >
                      {label}
                    </Text>
                    <Text className="text-[11px] text-muted-foreground mt-0.5">{description}</Text>
                  </View>
                  <View
                    className={`w-4 h-4 rounded-full border ${
                      active ? 'border-primary bg-primary' : 'border-border'
                    } items-center justify-center mt-0.5`}
                  >
                    {active ? <Check size={10} className="text-primary-foreground" /> : null}
                  </View>
                </Pressable>
              )
            })}
          </View>

          {config.mode === 'custom' ? (
            <View className="gap-3">
              <TagInput
                icon={Mail}
                label="Allowed emails"
                placeholder="alice@acme.com"
                values={config.allowedEmails}
                validate={(raw) => {
                  const v = raw.trim().toLowerCase()
                  if (!EMAIL_RE.test(v)) return null
                  return v
                }}
                onChange={(allowedEmails) => setConfig((c) => ({ ...c, allowedEmails }))}
                emptyHint="Add individual addresses to whitelist."
                invalidMessage="Not a valid email address."
              />
              <TagInput
                icon={Globe2}
                label="Allowed domains"
                placeholder="acme.com"
                values={config.allowedDomains}
                validate={(raw) => {
                  const v = raw.trim().toLowerCase().replace(/^@/, '')
                  if (!DOMAIN_RE.test(v)) return null
                  return v
                }}
                onChange={(allowedDomains) => setConfig((c) => ({ ...c, allowedDomains }))}
                emptyHint="Add a domain (e.g. acme.com) to whitelist everyone with that email."
                invalidMessage="Not a valid domain."
              />
            </View>
          ) : null}

          <View className="flex-row items-center justify-between border-t border-border pt-3">
            <View className="flex-1 pr-3">
              <Text className="text-xs font-semibold text-foreground">
                Require email verification
              </Text>
              <Text className="text-[11px] text-muted-foreground mt-0.5">
                Only users with a verified email can sign in (regardless of mode).
              </Text>
            </View>
            <Switch
              value={config.requireEmailVerification}
              onValueChange={(v) =>
                setConfig((c) => ({ ...c, requireEmailVerification: v }))
              }
            />
          </View>

          {error ? (
            <View className="flex-row items-center gap-2 bg-destructive/10 border border-destructive/40 rounded-md px-3 py-2">
              <AlertCircle size={14} className="text-destructive" />
              <Text className="text-[11px] text-destructive flex-1">{error}</Text>
            </View>
          ) : null}

          <View className="flex-row items-center justify-end gap-2">
            {dirty ? (
              <Pressable
                onPress={() => setConfig(original)}
                disabled={saving}
                className="px-3 py-2 rounded-md border border-border active:bg-muted"
              >
                <Text className="text-xs text-foreground">Discard</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={save}
              disabled={saving || !dirty}
              className={`px-4 py-2 rounded-md ${
                saving || !dirty ? 'bg-muted' : 'bg-primary active:opacity-90'
              }`}
            >
              {saving ? (
                <ActivityIndicator size="small" />
              ) : (
                <Text
                  className={`text-xs font-semibold ${
                    dirty ? 'text-primary-foreground' : 'text-muted-foreground'
                  }`}
                >
                  Save
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      )}
    </View>
  )
}

// =============================================================================
// Users card
// =============================================================================

interface UsersState {
  items: AuthUserRow[]
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  query: string
}

function UsersCard({ projectId }: { projectId: string }) {
  const [state, setState] = useState<UsersState>({
    items: [],
    nextCursor: null,
    loading: true,
    loadingMore: false,
    error: null,
    query: '',
  })
  const queryRef = useRef('')

  const load = useCallback(
    async (opts?: { cursor?: string | null; query?: string; reset?: boolean }) => {
      if (!API_URL) return
      const cursor = opts?.cursor ?? null
      const queryStr = opts?.query ?? queryRef.current
      const reset = opts?.reset ?? !cursor

      setState((s) => ({
        ...s,
        loading: reset,
        loadingMore: !reset,
        error: null,
      }))

      try {
        const params = new URLSearchParams()
        if (cursor) params.set('cursor', cursor)
        if (queryStr) params.set('q', queryStr)
        const url =
          `${API_URL}/api/projects/${projectId}/auth-users` +
          (params.toString() ? `?${params}` : '')
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = (await res.json()) as { items?: AuthUserRow[]; nextCursor?: string | null }
        setState((s) => ({
          ...s,
          items: reset ? body.items ?? [] : [...s.items, ...(body.items ?? [])],
          nextCursor: body.nextCursor ?? null,
          loading: false,
          loadingMore: false,
        }))
      } catch (err: any) {
        setState((s) => ({
          ...s,
          loading: false,
          loadingMore: false,
          error: err?.message ?? 'Failed to load users',
        }))
      }
    },
    [projectId],
  )

  useEffect(() => {
    load({ reset: true })
  }, [load])

  const onSearchSubmit = useCallback(() => {
    queryRef.current = state.query
    load({ reset: true, query: state.query })
  }, [load, state.query])

  const revoke = useCallback(
    async (userId: string) => {
      if (!API_URL) return
      try {
        const res = await fetch(
          `${API_URL}/api/projects/${projectId}/auth-users/${encodeURIComponent(userId)}`,
          { method: 'DELETE', credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setState((s) => ({ ...s, items: s.items.filter((r) => r.userId !== userId) }))
      } catch (err: any) {
        setState((s) => ({ ...s, error: err?.message ?? 'Failed to revoke user' }))
      }
    },
    [projectId],
  )

  return (
    <View className="border border-border rounded-lg bg-card overflow-hidden">
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <Users size={16} className="text-primary" />
        <Text className="text-sm font-semibold text-foreground flex-1">Users</Text>
        <Pressable
          onPress={() => load({ reset: true })}
          disabled={state.loading}
          className="w-7 h-7 items-center justify-center rounded-md active:bg-muted"
          accessibilityLabel="Refresh users"
        >
          <RefreshCw size={13} className="text-muted-foreground" />
        </Pressable>
      </View>

      <View className="p-4 gap-3">
        <Text className="text-[11px] text-muted-foreground">
          Users who have signed in to this project via the Shogo SDK.
        </Text>
        <View className="flex-row items-center gap-2">
          <TextInput
            value={state.query}
            onChangeText={(query) => setState((s) => ({ ...s, query }))}
            onSubmitEditing={onSearchSubmit}
            placeholder="Search by name or email..."
            placeholderTextColor="rgba(120,120,120,0.6)"
            className="flex-1 border border-border rounded-md px-3 py-2 text-xs text-foreground"
          />
          <Pressable
            onPress={onSearchSubmit}
            className="px-3 py-2 rounded-md border border-border active:bg-muted"
          >
            <Text className="text-xs text-foreground">Search</Text>
          </Pressable>
        </View>

        {state.error ? (
          <View className="flex-row items-center gap-2 bg-destructive/10 border border-destructive/40 rounded-md px-3 py-2">
            <AlertCircle size={14} className="text-destructive" />
            <Text className="text-[11px] text-destructive flex-1">{state.error}</Text>
          </View>
        ) : null}

        {state.loading ? (
          <View className="py-6 items-center">
            <ActivityIndicator size="small" />
          </View>
        ) : state.items.length === 0 ? (
          <View className="py-6 items-center">
            <Text className="text-[11px] text-muted-foreground">
              No users have signed in to this project yet.
            </Text>
          </View>
        ) : (
          <View className="border border-border rounded-md overflow-hidden">
            {state.items.map((row, idx) => (
              <UserRow
                key={row.userId}
                row={row}
                isLast={idx === state.items.length - 1}
                onRevoke={() => revoke(row.userId)}
              />
            ))}
          </View>
        )}

        {state.nextCursor ? (
          <Pressable
            onPress={() => load({ cursor: state.nextCursor })}
            disabled={state.loadingMore}
            className="self-center px-4 py-2 rounded-md border border-border active:bg-muted"
          >
            {state.loadingMore ? (
              <ActivityIndicator size="small" />
            ) : (
              <Text className="text-xs text-foreground">Load more</Text>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

function UserRow({
  row,
  isLast,
  onRevoke,
}: {
  row: AuthUserRow
  isLast: boolean
  onRevoke: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const lastSignIn = formatRelative(row.lastSignInAt)
  return (
    <View
      className={`flex-row items-center gap-3 px-3 py-2.5 ${
        isLast ? '' : 'border-b border-border'
      }`}
    >
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-xs font-semibold text-foreground" numberOfLines={1}>
            {row.name || row.email}
          </Text>
          {row.isWorkspaceMember ? (
            <Text className="text-[10px] text-emerald-500 font-semibold uppercase">Member</Text>
          ) : null}
          {row.isAllowlisted ? (
            <Text className="text-[10px] text-primary font-semibold uppercase">Allowlisted</Text>
          ) : null}
          {!row.emailVerified ? (
            <Text className="text-[10px] text-amber-500 font-semibold uppercase">
              Unverified
            </Text>
          ) : null}
        </View>
        <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
          {row.email} · {row.signInCount} sign-in{row.signInCount === 1 ? '' : 's'} · {lastSignIn}
        </Text>
      </View>

      {confirm ? (
        <View className="flex-row items-center gap-1">
          <Pressable
            onPress={() => {
              setConfirm(false)
              onRevoke()
            }}
            className="px-2 py-1.5 rounded-md bg-destructive active:opacity-90"
          >
            <Text className="text-[11px] font-semibold text-white">Confirm</Text>
          </Pressable>
          <Pressable
            onPress={() => setConfirm(false)}
            className="w-7 h-7 items-center justify-center rounded-md active:bg-muted"
          >
            <X size={13} className="text-muted-foreground" />
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={() => setConfirm(true)}
          className="w-8 h-8 items-center justify-center rounded-md active:bg-muted"
          accessibilityLabel="Revoke user access"
        >
          <UserMinus size={14} className="text-muted-foreground" />
        </Pressable>
      )}
    </View>
  )
}

// =============================================================================
// TagInput — chip-style entry for emails / domains
// =============================================================================

interface TagInputProps {
  label: string
  placeholder: string
  icon: typeof Mail
  values: string[]
  onChange: (next: string[]) => void
  /** Returns the normalized value, or `null` if invalid. */
  validate: (raw: string) => string | null
  emptyHint?: string
  invalidMessage?: string
}

function TagInput({
  label,
  placeholder,
  icon: Icon,
  values,
  onChange,
  validate,
  emptyHint,
  invalidMessage,
}: TagInputProps) {
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)

  const commit = useCallback(() => {
    const trimmed = draft.trim()
    if (!trimmed) return
    const v = validate(trimmed)
    if (!v) {
      setInvalid(true)
      return
    }
    if (values.includes(v)) {
      setDraft('')
      setInvalid(false)
      return
    }
    onChange([...values, v])
    setDraft('')
    setInvalid(false)
  }, [draft, validate, values, onChange])

  const remove = useCallback(
    (value: string) => onChange(values.filter((v) => v !== value)),
    [values, onChange],
  )

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Icon size={13} className="text-muted-foreground" />
        <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </Text>
      </View>

      {values.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5">
          {values.map((v) => (
            <View
              key={v}
              className="flex-row items-center gap-1 bg-muted rounded-full pl-2.5 pr-1 py-1"
            >
              <Text className="text-[11px] text-foreground">{v}</Text>
              <Pressable
                onPress={() => remove(v)}
                className="w-4 h-4 items-center justify-center rounded-full active:bg-border"
                accessibilityLabel={`Remove ${v}`}
              >
                <X size={9} className="text-muted-foreground" />
              </Pressable>
            </View>
          ))}
        </View>
      ) : emptyHint ? (
        <Text className="text-[11px] text-muted-foreground">{emptyHint}</Text>
      ) : null}

      <View className="flex-row items-center gap-2">
        <TextInput
          value={draft}
          onChangeText={(s) => {
            setDraft(s)
            if (invalid) setInvalid(false)
          }}
          onSubmitEditing={commit}
          placeholder={placeholder}
          placeholderTextColor="rgba(120,120,120,0.6)"
          autoCapitalize="none"
          autoCorrect={false}
          className={`flex-1 border rounded-md px-3 py-2 text-xs text-foreground ${
            invalid ? 'border-destructive' : 'border-border'
          }`}
        />
        <Pressable
          onPress={commit}
          className="w-9 h-9 items-center justify-center rounded-md border border-border active:bg-muted"
          accessibilityLabel={`Add to ${label.toLowerCase()}`}
        >
          <Plus size={14} className="text-foreground" />
        </Pressable>
      </View>

      {invalid && invalidMessage ? (
        <Text className="text-[11px] text-destructive">{invalidMessage}</Text>
      ) : null}
    </View>
  )
}

// =============================================================================
// Helpers
// =============================================================================

function configEquals(a: AuthConfig, b: AuthConfig): boolean {
  if (a.mode !== b.mode) return false
  if (a.requireEmailVerification !== b.requireEmailVerification) return false
  if (!arraysEqual(a.allowedEmails, b.allowedEmails)) return false
  if (!arraysEqual(a.allowedDomains, b.allowedDomains)) return false
  return true
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function normalizeConfig(raw: unknown): AuthConfig {
  const o = (raw ?? {}) as Partial<AuthConfig>
  return {
    mode: o.mode === 'workspace' || o.mode === 'custom' ? o.mode : 'anyone',
    allowedEmails: Array.isArray(o.allowedEmails) ? [...o.allowedEmails] : [],
    allowedDomains: Array.isArray(o.allowedDomains) ? [...o.allowedDomains] : [],
    requireEmailVerification: !!o.requireEmailVerification,
  }
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}
