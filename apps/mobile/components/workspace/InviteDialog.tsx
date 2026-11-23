// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one invite dialog (SHO-454).
 *
 * Every place a person would look for "invite someone" opens this: the sidebar
 * footer, the workspace menu, the + menu, the command palette, the team-chat
 * pickers, the Get Started checklist and Settings › People. It never navigates
 * to Settings first and never opens a browser — a desktop cloud workspace
 * routes its calls through `/api/cloud/<id>` like every other workspace call.
 *
 * It does three things:
 *   - email chips, with a per-address outcome (sent / already invited · Resend
 *     / already a member / failed) and `Promise.allSettled` so one bad address
 *     never stops the rest;
 *   - a copyable `/invite/<token>` link with a role and an expiry;
 *   - a footer that says how many invitations are pending and links to them.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { useRouter } from 'expo-router'
import { Check, ChevronDown, Copy, Link2, RefreshCw, UserPlus, X } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { formatApiError } from '@shogo/shared-app/chat'
import { useBillingData } from '@shogo/shared-app/hooks'
import { api, type WorkspaceInviteLink } from '../../lib/api'
import { formatUsd, PLAN_PRICING } from '../../lib/billing-config'
import { inviteLinkUrl } from '../../lib/workspace-route'
import { useDomainHttp, useWorkspaceCollection } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { usePermissions } from '../../hooks/usePermissions'
import {
  parseInviteChips,
  sendableEmails,
  summarizeInviteResults,
  describeExpiry,
  type InviteChip,
  type InviteOutcome,
  type InviteResultLine,
} from './invite-dialog-logic'
import {
  closeInviteDialog,
  useInviteDialogRequest,
} from './invite-dialog-context'
import { Spinner } from '@/components/ui/spinner'

// ─── Email parsing ────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = { admin: 'Admin', member: 'Editor', viewer: 'Viewer' }
const ROLE_HINTS: Record<string, string> = {
  admin: 'Manage members, settings and billing',
  member: 'Build projects and use agents',
  viewer: 'Read-only access',
}

// ─── Provider ─────────────────────────────────────────────

export {
  useInviteDialog,
  useInviteDialogOptional,
  type InviteDialogContextValue,
  type OpenInviteDialogOptions,
} from './invite-dialog-context'

export function InviteDialogProvider({ children }: { children: ReactNode }) {
  const request = useInviteDialogRequest()

  return (
    <>
      {children}
      <InviteDialog
        visible={!!request}
        workspaceId={request?.workspaceId ?? null}
        initialEmails={request?.emails ?? []}
        onClose={closeInviteDialog}
      />
    </>
  )
}

// ─── Dialog ───────────────────────────────────────────────

export interface InviteDialogProps {
  visible: boolean
  workspaceId: string | null
  initialEmails?: string[]
  onClose: () => void
}

export function InviteDialog({ visible, workspaceId, initialEmails = [], onClose }: InviteDialogProps) {
  const router = useRouter()
  const http = useDomainHttp()
  const workspaces = useWorkspaceCollection()
  const activeWorkspace = useActiveWorkspace()
  const { width } = useWindowDimensions()
  const compact = width < 640

  const resolvedId = workspaceId ?? activeWorkspace?.id ?? null
  const workspaceName =
    (Array.isArray(workspaces.all) ? workspaces.all : []).find((w: any) => w.id === resolvedId)?.name ??
    activeWorkspace?.name ??
    'this workspace'

  const { can, canInvite, workspaceRole } = usePermissions({ workspaceId: resolvedId })
  const canManage = can('workspace.members:manage')
  const { subscription } = useBillingData(resolvedId ?? undefined)

  const [chips, setChips] = useState<InviteChip[]>([])
  const [draft, setDraft] = useState('')
  const [role, setRole] = useState<'admin' | 'member' | 'viewer'>('member')
  const [showRolePicker, setShowRolePicker] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const [memberEmails, setMemberEmails] = useState<Set<string>>(new Set())
  const [pendingByEmail, setPendingByEmail] = useState<Map<string, string>>(new Map())
  const [resending, setResending] = useState<string | null>(null)

  const [links, setLinks] = useState<WorkspaceInviteLink[]>([])
  const [linkBusy, setLinkBusy] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const seeded = useRef(false)

  // Roles this caller may hand out. Owners and admins keep the no-escalation
  // rule; an Editor may only invite as Editor or Viewer (SHO-454).
  const roleOptions = useMemo(
    () => (canManage ? (['admin', 'member', 'viewer'] as const) : (['member', 'viewer'] as const)),
    [canManage],
  )

  // Reset on open, and seed any addresses the caller passed in.
  useEffect(() => {
    if (!visible) {
      seeded.current = false
      return
    }
    if (seeded.current) return
    seeded.current = true
    setChips(parseInviteChips(initialEmails.join(' ')))
    setDraft('')
    setRole('member')
    setShowRolePicker(false)
    setError(null)
    setSummary(null)
    setDone(false)
    setCopied(false)
    setLinkError(null)
  }, [visible, initialEmails])

  // Who is already here, and who is already invited.
  useEffect(() => {
    if (!visible || !resolvedId || !http) return
    let cancelled = false
    void (async () => {
      try {
        const [members, invitations] = await Promise.all([
          api.getWorkspaceMembers(http, resolvedId),
          http.get<{ ok?: boolean; items?: any[] }>(
            `/api/invitations?workspaceId=${encodeURIComponent(resolvedId)}`,
          ),
        ])
        if (cancelled) return
        const emails = new Set<string>()
        for (const m of members) {
          const email = m.user?.email?.toLowerCase()
          if (email) emails.add(email)
        }
        setMemberEmails(emails)
        const pending = new Map<string, string>()
        for (const inv of invitations.data?.items ?? []) {
          if (inv?.status !== 'pending' || !inv?.email) continue
          if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) continue
          pending.set(String(inv.email).toLowerCase(), String(inv.id))
        }
        setPendingByEmail(pending)
      } catch {
        // The dialog still works without the "already invited" hints.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [visible, resolvedId, http])

  const loadLinks = useCallback(async () => {
    if (!resolvedId || !http) return
    try {
      setLinks(await api.getWorkspaceInviteLinks(http, resolvedId))
    } catch {
      setLinks([])
    }
  }, [resolvedId, http])

  useEffect(() => {
    if (!visible) return
    void loadLinks()
  }, [visible, loadLinks])

  const activeLink = useMemo(
    () =>
      links.find(
        (l) => l.enabled && (!l.expiresAt || new Date(l.expiresAt).getTime() > Date.now()),
      ) ?? null,
    [links],
  )

  const pendingCount = pendingByEmail.size

  const seatHint = useMemo(() => {
    const planId = subscription?.planId?.toLowerCase?.() ?? ''
    const isPaidSeatPlan = planId.startsWith('pro') || planId.startsWith('business')
    if (!isPaidSeatPlan) return null
    const pricing = planId.startsWith('business') ? PLAN_PRICING.business : PLAN_PRICING.pro
    const interval = subscription?.billingInterval === 'annual' ? 'annual' : 'monthly'
    const perSeatMonthly = interval === 'annual' ? Math.round(pricing.annual / 12) : pricing.monthly
    return {
      perSeatMonthly,
      planLabel: planId.startsWith('business') ? 'Business' : 'Pro',
      incomingCount: sendableEmails(chips, memberEmails, pendingByEmail).length,
    }
  }, [subscription, chips, memberEmails, pendingByEmail])

  const commitDraft = useCallback((raw: string) => {
    const next = parseInviteChips(raw)
    if (next.length) {
      setChips((current) => {
        const seen = new Set(current.map((c) => c.value))
        return [...current, ...next.filter((c) => !seen.has(c.value))]
      })
    }
    setDraft('')
  }, [])

  const onChangeText = useCallback(
    (text: string) => {
      setError(null)
      if (/[,;\s]$/.test(text)) commitDraft(text)
      else setDraft(text)
    },
    [commitDraft],
  )

  const removeChip = useCallback((value: string) => {
    setChips((current) => current.filter((c) => c.value !== value))
  }, [])

  const resend = useCallback(
    async (email: string) => {
      const invitationId = pendingByEmail.get(email)
      if (!invitationId || !resolvedId || !http) return
      setResending(email)
      setError(null)
      try {
        await api.resendInvitation(http, resolvedId, invitationId)
        setSummary(`Invitation resent to ${email}`)
      } catch (err) {
        setError(formatApiError(err))
      } finally {
        setResending(null)
      }
    },
    [pendingByEmail, resolvedId, http],
  )

  const submit = useCallback(async () => {
    if (!resolvedId) return
    const pendingDraft = draft.trim() ? parseInviteChips(draft) : []
    const allChips = [...chips, ...pendingDraft.filter((c) => !chips.some((x) => x.value === c.value))]
    const targets = sendableEmails(allChips, memberEmails, pendingByEmail)
    const invalid = allChips.filter((c) => !c.valid)
    if (!targets.length) {
      setError(
        invalid.length
          ? 'Fix the highlighted addresses first.'
          : 'Everyone you listed is already a member or already invited.',
      )
      return
    }
    setSending(true)
    setError(null)
    setSummary(null)
    try {
      const settled = await Promise.allSettled(
        targets.map(async (email): Promise<InviteResultLine> => {
          try {
            await api.sendInvitation(http, { workspaceId: resolvedId, email, role })
            return { email, outcome: 'sent' }
          } catch (err) {
            return { email, outcome: 'failed', message: formatApiError(err) }
          }
        }),
      )
      const lines: InviteResultLine[] = settled.map((r, i) =>
        r.status === 'fulfilled'
          ? r.value
          : { email: targets[i]!, outcome: 'failed', message: formatApiError(r.reason) },
      )
      const alreadyInvited = allChips.filter((c) => c.valid && pendingByEmail.has(c.value)).length
      const alreadyMembers = allChips.filter((c) => c.valid && memberEmails.has(c.value)).length
      const text = summarizeInviteResults([
        ...lines,
        ...Array.from({ length: alreadyInvited }, () => ({ email: '', outcome: 'invited' as const })),
        ...Array.from({ length: alreadyMembers }, () => ({ email: '', outcome: 'member' as const })),
      ])
      setSummary(text)
      setChips([])
      setDraft('')
      if (lines.every((l) => l.outcome === 'sent')) setDone(true)
    } catch (err) {
      setError(formatApiError(err))
    } finally {
      setSending(false)
    }
  }, [resolvedId, draft, chips, memberEmails, pendingByEmail, http, role])

  const copyLink = useCallback(async () => {
    if (!activeLink || !resolvedId) return
    await Clipboard.setStringAsync(inviteLinkUrl(activeLink.token, resolvedId))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [activeLink, resolvedId])

  const createLink = useCallback(
    async (nextRole: 'admin' | 'member' | 'viewer' = role) => {
      if (!resolvedId || !http) return
      setLinkBusy(true)
      setLinkError(null)
      try {
        await api.createWorkspaceInviteLink(http, { workspaceId: resolvedId, role: nextRole, expiresInDays: 7 })
        await loadLinks()
      } catch (err) {
        setLinkError(formatApiError(err))
      } finally {
        setLinkBusy(false)
      }
    },
    [resolvedId, http, role, loadLinks],
  )

  const resetLink = useCallback(async () => {
    if (!resolvedId || !http) return
    setLinkBusy(true)
    setLinkError(null)
    try {
      for (const link of links) {
        await api.deleteWorkspaceInviteLink(http, resolvedId, link.id).catch(() => undefined)
      }
      await api.createWorkspaceInviteLink(http, { workspaceId: resolvedId, role, expiresInDays: 7 })
      await loadLinks()
    } catch (err) {
      setLinkError(formatApiError(err))
    } finally {
      setLinkBusy(false)
    }
  }, [resolvedId, http, links, role, loadLinks])

  const toggleLink = useCallback(async () => {
    if (!resolvedId || !http || !activeLink) return
    setLinkBusy(true)
    setLinkError(null)
    try {
      await api.setWorkspaceInviteLinkEnabled(http, resolvedId, activeLink.id, false)
      await loadLinks()
    } catch (err) {
      setLinkError(formatApiError(err))
    } finally {
      setLinkBusy(false)
    }
  }, [resolvedId, http, activeLink, loadLinks])

  const openPendingInvites = useCallback(() => {
    onClose()
    router.push('/(app)/settings?tab=people&sub=invitations' as any)
  }, [onClose, router])

  if (!visible) return null

  const canShow = canInvite || canManage
  const selectedRoleLabel = ROLE_LABELS[role] ?? 'Editor'

  const body = (
    <>
      <View className="mb-1 flex-row items-center justify-between">
        <Text className="text-lg font-semibold text-foreground">Invite people</Text>
        <Pressable onPress={onClose} accessibilityLabel="Close" className="-mr-1 p-1">
          <X size={20} className="text-muted-foreground" />
        </Pressable>
      </View>
      <Text className="mb-4 text-sm text-muted-foreground">
        Invite people to <Text className="font-medium text-foreground">{workspaceName}</Text>
      </Text>

      {!canShow ? (
        <View className="rounded-lg border border-border bg-muted/40 p-3">
          <Text className="text-sm text-foreground">
            {workspaceRole === 'viewer'
              ? 'Viewers cannot invite people. Ask an admin to invite them for you.'
              : 'An admin has limited inviting to admins only.'}
          </Text>
        </View>
      ) : done ? (
        <View className="gap-4">
          <View className="flex-row items-center gap-2 rounded-lg border border-emerald-600/30 bg-emerald-500/10 p-3">
            <Check size={16} className="text-emerald-600" />
            <Text className="flex-1 text-sm text-foreground">{summary ?? 'Invitations sent.'}</Text>
          </View>
          <View className="flex-row gap-3">
            <Pressable
              onPress={() => {
                setDone(false)
                setSummary(null)
              }}
              className="h-10 flex-1 items-center justify-center rounded-lg border border-border"
            >
              <Text className="text-sm font-medium text-foreground">Invite more</Text>
            </Pressable>
            <Pressable onPress={onClose} className="h-10 flex-1 items-center justify-center rounded-lg bg-primary">
              <Text className="text-sm font-medium text-primary-foreground">Done</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <>
          {error && (
            <View className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
              <Text className="text-sm text-destructive">{error}</Text>
            </View>
          )}
          {summary && !error && (
            <View className="mb-3 rounded-lg border border-border bg-muted/40 p-3">
              <Text className="text-sm text-foreground">{summary}</Text>
            </View>
          )}

          <Text className="mb-1.5 text-sm font-medium text-foreground">Email</Text>
          <View className="mb-3 min-h-11 flex-row flex-wrap items-center gap-1.5 rounded-lg border border-border px-2 py-1.5">
            {chips.map((chip) => {
              const isMember = chip.valid && memberEmails.has(chip.value)
              const isPending = chip.valid && pendingByEmail.has(chip.value)
              return (
                <View
                  key={chip.value}
                  testID={`invite-chip-${chip.value}`}
                  className={cn(
                    'flex-row items-center gap-1 rounded-full py-1 pl-2.5 pr-1.5',
                    !chip.valid
                      ? 'border border-destructive/40 bg-destructive/10'
                      : isMember || isPending
                        ? 'bg-muted'
                        : 'bg-primary/10',
                  )}
                >
                  <Text
                    className={cn(
                      'text-xs',
                      !chip.valid ? 'text-destructive' : 'text-foreground',
                    )}
                  >
                    {chip.value}
                  </Text>
                  {isMember && <Text className="text-[10px] text-muted-foreground">already a member</Text>}
                  {isPending && (
                    <Pressable
                      onPress={() => void resend(chip.value)}
                      accessibilityLabel={`Resend invitation to ${chip.value}`}
                      className="flex-row items-center gap-0.5 rounded-full px-1 active:bg-background"
                    >
                      {resending === chip.value ? (
                        <Spinner size="small" />
                      ) : (
                        <RefreshCw size={10} className="text-primary" />
                      )}
                      <Text className="text-[10px] text-primary">already invited · Resend</Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => removeChip(chip.value)}
                    accessibilityLabel={`Remove ${chip.value}`}
                    className="h-4 w-4 items-center justify-center rounded-full active:bg-background"
                  >
                    <X size={10} className="text-muted-foreground" />
                  </Pressable>
                </View>
              )
            })}
            <TextInput
              value={draft}
              onChangeText={onChangeText}
              onBlur={() => draft.trim() && commitDraft(draft)}
              onSubmitEditing={() => draft.trim() && commitDraft(draft)}
              blurOnSubmit={false}
              placeholder={chips.length ? '' : 'name@company.com, separated by commas'}
              placeholderTextColor="#71717a"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              accessibilityLabel="Email addresses to invite"
              className="min-w-[140px] flex-1 py-1 text-sm text-foreground web:outline-none"
            />
          </View>

          <Text className="mb-1.5 text-sm font-medium text-foreground">Role</Text>
          <View className={cn('relative z-50', compact ? 'mb-3' : 'mb-4')}>
            <Pressable
              onPress={() => setShowRolePicker((v) => !v)}
              accessibilityLabel={`Role: ${selectedRoleLabel}`}
              className="h-10 flex-row items-center justify-between rounded-lg border border-border px-3"
            >
              <Text className="text-sm text-foreground">{selectedRoleLabel}</Text>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Pressable>
            {showRolePicker && (
              <View
                className={cn(
                  'overflow-hidden rounded-lg border border-border bg-background shadow-lg',
                  Platform.OS === 'web' ? 'absolute left-0 right-0 top-11 z-50' : 'mt-1',
                )}
              >
                {roleOptions.map((value) => (
                  <Pressable
                    key={value}
                    onPress={() => {
                      setRole(value)
                      setShowRolePicker(false)
                    }}
                    className={cn('px-3 py-2.5', role === value && 'bg-accent')}
                  >
                    <Text className="text-sm text-foreground">{ROLE_LABELS[value]}</Text>
                    <Text className="text-xs text-muted-foreground">{ROLE_HINTS[value]}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </View>

          {seatHint && (
            <View className={cn('rounded-lg border border-border bg-muted/40 p-3', compact ? 'mb-3' : 'mb-4')}>
              <Text className="text-xs text-foreground">
                {seatHint.incomingCount > 0
                  ? `Each accepted invite adds a ${seatHint.planLabel} seat at ${formatUsd(
                      seatHint.perSeatMonthly,
                    )}/seat/mo (prorated immediately). Pending invites are not billed — ${
                      seatHint.incomingCount
                    } seat${seatHint.incomingCount === 1 ? '' : 's'} would be added if all accept.`
                  : `Each accepted invite adds a ${seatHint.planLabel} seat at ${formatUsd(
                      seatHint.perSeatMonthly,
                    )}/seat/mo (prorated immediately). Pending invites are not billed.`}
              </Text>
            </View>
          )}

          <View className="mb-4 rounded-lg border border-border p-3">
            <View className="mb-2 flex-row items-center gap-2">
              <Link2 size={14} className="text-muted-foreground" />
              <Text className="flex-1 text-sm font-medium text-foreground">Invite link</Text>
            </View>
            {activeLink ? (
              <>
                <Text className="mb-2 text-xs text-muted-foreground">
                  Anyone with the link can join as{' '}
                  <Text className="font-medium text-foreground">{ROLE_LABELS[activeLink.role] ?? 'Editor'}</Text> ·{' '}
                  {describeExpiry(activeLink.expiresAt)}
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  <Pressable
                    onPress={() => void copyLink()}
                    accessibilityLabel="Copy invite link"
                    className="h-9 flex-row items-center gap-1.5 rounded-md bg-primary px-3"
                  >
                    {copied ? <Check size={13} className="text-primary-foreground" /> : <Copy size={13} className="text-primary-foreground" />}
                    <Text className="text-xs font-medium text-primary-foreground">
                      {copied ? 'Copied' : 'Copy link'}
                    </Text>
                  </Pressable>
                  {canManage && (
                    <>
                      <Pressable
                        onPress={() => void resetLink()}
                        disabled={linkBusy}
                        accessibilityLabel="Reset invite link"
                        className="h-9 flex-row items-center gap-1.5 rounded-md border border-border px-3"
                      >
                        <RefreshCw size={13} className="text-muted-foreground" />
                        <Text className="text-xs text-foreground">Reset link</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => void toggleLink()}
                        disabled={linkBusy}
                        accessibilityLabel="Turn off invite link"
                        className="h-9 items-center justify-center rounded-md border border-border px-3"
                      >
                        <Text className="text-xs text-foreground">Turn off</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              </>
            ) : (
              <>
                <Text className="mb-2 text-xs text-muted-foreground">
                  Create a link anyone can use to join as {selectedRoleLabel} · expires in 7 days.
                </Text>
                <Pressable
                  onPress={() => void createLink()}
                  disabled={linkBusy}
                  accessibilityLabel="Create invite link"
                  className="h-9 flex-row items-center justify-center gap-1.5 rounded-md border border-border px-3"
                >
                  {linkBusy ? <Spinner size="small" /> : <Link2 size={13} className="text-muted-foreground" />}
                  <Text className="text-xs text-foreground">Create link</Text>
                </Pressable>
              </>
            )}
            {linkError && <Text className="mt-2 text-xs text-destructive">{linkError}</Text>}
          </View>

          <View className="flex-row gap-3">
            <Pressable
              onPress={onClose}
              disabled={sending}
              className="h-10 flex-1 items-center justify-center rounded-lg border border-border"
            >
              <Text className="text-sm font-medium text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => void submit()}
              disabled={sending}
              accessibilityLabel="Send invitations"
              className={cn(
                'h-10 flex-1 flex-row items-center justify-center gap-1.5 rounded-lg',
                sending ? 'bg-muted' : 'bg-primary',
              )}
            >
              {sending ? (
                <Spinner size="small" />
              ) : (
                <>
                  <UserPlus size={14} className="text-primary-foreground" />
                  <Text className="text-sm font-medium text-primary-foreground">Invite</Text>
                </>
              )}
            </Pressable>
          </View>
        </>
      )}

      {pendingCount > 0 && (
        <Pressable
          onPress={openPendingInvites}
          accessibilityLabel={`${pendingCount} pending invites, manage`}
          className="mt-4 flex-row items-center justify-center gap-1 rounded-md py-1.5 active:bg-muted"
        >
          <Text className="text-xs text-muted-foreground">
            {pendingCount} pending invite{pendingCount === 1 ? '' : 's'} ·{' '}
            <Text className="text-primary">Manage</Text>
          </Text>
        </Pressable>
      )}
    </>
  )

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        className={cn('flex-1 justify-center bg-black/50', compact ? 'px-4 py-6' : 'items-center px-6')}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          className={cn(
            'w-full rounded-xl bg-background shadow-xl',
            compact ? 'max-h-[92%] p-5' : 'max-w-md p-6',
          )}
        >
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {body}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
