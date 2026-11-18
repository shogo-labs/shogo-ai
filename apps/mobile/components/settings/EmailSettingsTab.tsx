// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Mail: the workspace's Shogo Mail setup. Free shared-domain
 * addresses, the workspace's own domains (DNS records with a live check),
 * the daily send budget, mailboxes for people, shared addresses and agents,
 * and per-mailbox settings (signature, screener, SLA, rules, a connected
 * IMAP/SMTP account).
 *
 * Like the other Settings tabs it draws no page chrome, so it renders the same
 * in the Settings page and in the phone's Account sheet.
 */
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Globe, Inbox, Trash2 } from 'lucide-react-native'
import { Button, Card, CardContent, Switch, cn } from '@shogo/shared-ui/primitives'
import { Text, TextInput } from './account-sheet-chrome'
import { useResolvedTheme } from '../../contexts/theme'
import { SURFACE_COLORS } from '../../lib/surface-tokens'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useWorkspaceExperience } from '../../hooks/useWorkspaceExperience'
import { useMentionables, useMyUserId } from '../../hooks/useTeamChat'
import { invalidateMail, setMailOverview, useMailOverview } from '../../hooks/useMail'
import { agentRefFor } from '../../lib/work-boards-api'
import {
  MAIL_CATEGORY_LABELS,
  domainRecords,
  mailApi,
  type MailCategory,
  type MailDnsRecord,
  type MailDomain,
  type MailDomainMode,
  type Mailbox,
  type MailboxKind,
  type MailRule,
} from '../../lib/mail-api'

const api = mailApi()

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</Text>
  )
}

function Section({ title, description, children, testID }: { title: string; description?: string; children: React.ReactNode; testID?: string }) {
  return (
    <View testID={testID}>
      <SectionTitle>{title}</SectionTitle>
      <Card>
        <CardContent className="gap-2 p-4">
          {description ? <Text className="mb-1 text-xs text-muted-foreground">{description}</Text> : null}
          {children}
        </CardContent>
      </Card>
    </View>
  )
}

function ChoiceRow({ label, hint, checked, onPress, testID }: { label: string; hint?: string; checked: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityLabel={label}
      aria-checked={checked}
      onPress={onPress}
      className={cn('flex-row items-center gap-3 rounded-lg border px-3 py-2', checked ? 'border-primary bg-primary/5' : 'border-border active:bg-muted/50')}
    >
      <View className="flex-1">
        <Text className="text-sm text-foreground">{label}</Text>
        {hint ? <Text className="mt-0.5 text-xs text-muted-foreground">{hint}</Text> : null}
      </View>
      {checked ? <Check size={14} className="text-primary" /> : null}
    </Pressable>
  )
}

function Pill({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      aria-checked={active}
      testID={testID}
      className={cn('rounded-full border px-3 py-1', active ? 'border-primary bg-primary/10' : 'border-border active:bg-muted/50')}
    >
      <Text className={cn('text-xs', active ? 'font-medium text-primary' : 'text-foreground')}>{label}</Text>
    </Pressable>
  )
}

function Input(props: React.ComponentProps<typeof TextInput>) {
  const placeholderTextColor = SURFACE_COLORS[useResolvedTheme()].onSurfaceMuted
  return (
    <TextInput
      placeholderTextColor={placeholderTextColor}
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      className={cn('rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground', props.className)}
    />
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <Text className="mt-1 text-xs font-medium text-muted-foreground">{children}</Text>
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <Text className="text-xs text-destructive">{error}</Text> : null
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Pressable
      onPress={() => {
        void Clipboard.setStringAsync(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      accessibilityRole="button"
      accessibilityLabel={`Copy ${label}`}
      className="rounded-md p-1 active:bg-muted hover:bg-muted"
    >
      {copied ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} className="text-muted-foreground" />}
    </Pressable>
  )
}

function recordTone(status: MailDnsRecord['status']): { label: string; className: string } {
  if (status === 'ok') return { label: 'Found', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' }
  if (status === 'mismatch') return { label: 'Wrong value', className: 'bg-destructive/15 text-destructive' }
  if (status === 'missing') return { label: 'Missing', className: 'bg-amber-500/20 text-amber-700 dark:text-amber-400' }
  return { label: status ? String(status) : 'Not checked', className: 'bg-muted text-muted-foreground' }
}

function DnsRecordRow({ record }: { record: MailDnsRecord }) {
  const tone = recordTone(record.status)
  return (
    <View className="gap-1 rounded-lg border border-border p-2.5" testID="mail-dns-record">
      <View className="flex-row flex-wrap items-center gap-2">
        <Text className="rounded bg-muted px-1.5 py-px text-[11px] font-semibold text-foreground">{record.type}</Text>
        {record.priority != null ? <Text className="text-[11px] text-muted-foreground">priority {record.priority}</Text> : null}
        {record.purpose ? <Text className="text-[11px] text-muted-foreground">{record.purpose}</Text> : null}
        <View className="flex-1" />
        <Text className={cn('rounded px-1.5 py-px text-[10px] font-semibold', tone.className)}>{tone.label}</Text>
      </View>
      <View className="flex-row items-center gap-1">
        <Text className="w-12 text-[11px] text-muted-foreground">Name</Text>
        <Text selectable className="min-w-0 flex-1 font-mono text-xs text-foreground">{record.name}</Text>
        <CopyButton value={record.name} label="name" />
      </View>
      <View className="flex-row items-center gap-1">
        <Text className="w-12 text-[11px] text-muted-foreground">Value</Text>
        <Text selectable className="min-w-0 flex-1 font-mono text-xs text-foreground">{record.value}</Text>
        <CopyButton value={record.value} label="value" />
      </View>
      {record.status === 'mismatch' && record.found ? (
        <Text className="text-[11px] text-destructive">Found instead: {record.found}</Text>
      ) : null}
    </View>
  )
}

function DomainCard({ workspaceId, domain }: { workspaceId: string; domain: MailDomain }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(domain.lastError ?? null)
  const [open, setOpen] = useState(domain.status !== 'verified' && domain.status !== 'active')
  const records = domainRecords(domain)

  const run = async (label: string, fn: () => Promise<MailDomain | void>) => {
    setBusy(label)
    setError(null)
    try {
      const next = await fn()
      if (next) setMailOverview(workspaceId, (o) => ({ ...o, domains: o.domains.map((d) => (d.id === next.id ? next : d)) }))
      else await invalidateMail(workspaceId)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const verified = domain.status === 'verified' || domain.status === 'active'
  return (
    <View className="gap-2 rounded-lg border border-border p-3" testID="mail-domain">
      <Pressable onPress={() => setOpen((v) => !v)} className="flex-row items-center gap-2" accessibilityRole="button">
        {open ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
        <Globe size={14} className="text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-sm font-medium text-foreground" numberOfLines={1}>{domain.domain}</Text>
        <Text className="text-[11px] text-muted-foreground">{domain.mode === 'subdomain' ? 'Subdomain' : 'Full domain'}</Text>
        <Text
          className={cn(
            'rounded px-1.5 py-px text-[10px] font-semibold',
            verified ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/20 text-amber-700 dark:text-amber-400',
          )}
        >
          {verified ? 'Verified' : domain.status}
        </Text>
      </Pressable>
      {domain.sendingPaused ? (
        <View className="flex-row flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2" testID="mail-domain-paused">
          <AlertTriangle size={13} className="text-destructive" />
          <Text className="min-w-0 flex-1 text-xs text-destructive">
            Sending is paused{domain.pausedReason ? `: ${domain.pausedReason}` : ' because too many emails bounced or were marked as spam'}.
          </Text>
          <Button size="sm" variant="outline" disabled={!!busy} onPress={() => void run('resume', () => api.resumeDomain(workspaceId, domain.id))}>
            {busy === 'resume' ? 'Resuming…' : 'Resume sending'}
          </Button>
        </View>
      ) : null}
      {open ? (
        <>
          <Text className="text-xs text-muted-foreground">
            Add these records at your DNS provider, then press Verify. DNS changes can take a few minutes to show up.
          </Text>
          {records.map((r, i) => <DnsRecordRow key={`${r.type}-${r.name}-${i}`} record={r} />)}
          {!records.length ? <Text className="text-xs text-muted-foreground">No records yet.</Text> : null}
          <View className="flex-row flex-wrap items-center gap-2">
            <Button size="sm" disabled={!!busy} onPress={() => void run('verify', () => api.verifyDomain(workspaceId, domain.id))} testID="mail-domain-verify">
              {busy === 'verify' ? 'Checking…' : 'Verify'}
            </Button>
            <Button size="sm" variant="ghost" disabled={!!busy} onPress={() => void run('delete', () => api.deleteDomain(workspaceId, domain.id))}>
              {busy === 'delete' ? 'Removing…' : 'Remove domain'}
            </Button>
            {domain.lastCheckedAt ? (
              <Text className="text-[11px] text-muted-foreground">Last checked {new Date(domain.lastCheckedAt).toLocaleString()}</Text>
            ) : null}
          </View>
        </>
      ) : null}
      <ErrorLine error={error} />
    </View>
  )
}

function AddDomainForm({ workspaceId }: { workspaceId: string }) {
  const [domain, setDomain] = useState('')
  const [mode, setMode] = useState<MailDomainMode>('subdomain')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    if (!domain.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.addDomain(workspaceId, { domain: domain.trim().toLowerCase(), mode })
      setDomain('')
      await invalidateMail(workspaceId)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <View className="gap-2 border-t border-border pt-3" testID="mail-add-domain">
      <Label>Add a domain</Label>
      <Input value={domain} onChangeText={setDomain} placeholder={mode === 'subdomain' ? 'team.acme.com' : 'acme.com'} accessibilityLabel="Domain" />
      <ChoiceRow
        label="Subdomain (recommended)"
        hint="Use something like team.acme.com. Google Workspace or Microsoft 365 keeps handling acme.com, so nothing changes for your existing mail."
        checked={mode === 'subdomain'}
        onPress={() => setMode('subdomain')}
        testID="mail-domain-mode-subdomain"
      />
      <ChoiceRow
        label="Full domain"
        hint="Shogo receives all mail for acme.com. Only choose this if acme.com has no other mail provider."
        checked={mode === 'full'}
        onPress={() => setMode('full')}
        testID="mail-domain-mode-full"
      />
      <View className="flex-row">
        <Button size="sm" disabled={busy || !domain.trim()} onPress={() => void add()} testID="mail-add-domain-submit">
          {busy ? 'Adding…' : 'Add domain'}
        </Button>
      </View>
      <ErrorLine error={error} />
    </View>
  )
}

const KIND_OPTIONS: Array<{ id: MailboxKind; label: string; hint: string }> = [
  { id: 'person', label: 'Person', hint: 'One person’s own address.' },
  { id: 'shared', label: 'Shared', hint: 'A team address like support@ that several people read.' },
  { id: 'agent', label: 'Agent', hint: 'An agent’s address. Every email it writes waits for a person to approve.' },
]

function CreateMailboxForm({ workspaceId, domains, sharedDomain }: { workspaceId: string; domains: MailDomain[]; sharedDomain: string | null }) {
  const me = useMyUserId()
  const mentionables = useMentionables(workspaceId)
  const verified = domains.filter((d) => d.status === 'verified' || d.status === 'active')
  const [kind, setKind] = useState<MailboxKind>('shared')
  const [localPart, setLocalPart] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [domainId, setDomainId] = useState<string | null>(verified[0]?.id ?? null)
  const [agentKey, setAgentKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const agents = mentionables?.agents ?? []
  const domainName = domainId ? verified.find((d) => d.id === domainId)?.domain : sharedDomain

  const create = async () => {
    if (!localPart.trim() || busy) return
    const agent = kind === 'agent' ? agents.find((a) => a.key === agentKey) : null
    if (kind === 'agent' && !agent) return setError('Pick the agent this address belongs to.')
    setBusy(true)
    setError(null)
    try {
      await api.createMailbox(workspaceId, {
        localPart: localPart.trim().toLowerCase(),
        kind,
        domainId: domainId ?? undefined,
        displayName: displayName.trim() || undefined,
        ...(kind === 'person' && me ? { ownerUserId: me } : {}),
        ...(agent ? { agentRef: agentRefFor(agent.projectId) } : {}),
      })
      setLocalPart('')
      setDisplayName('')
      await invalidateMail(workspaceId)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="gap-2 border-t border-border pt-3" testID="mail-create-mailbox">
      <Label>New mailbox</Label>
      <View className="flex-row flex-wrap gap-1.5">
        {KIND_OPTIONS.map((k) => (
          <Pill key={k.id} label={k.label} active={kind === k.id} onPress={() => setKind(k.id)} testID={`mail-kind-${k.id}`} />
        ))}
      </View>
      <Text className="text-xs text-muted-foreground">{KIND_OPTIONS.find((k) => k.id === kind)?.hint}</Text>
      <View className="flex-row items-center gap-2">
        <Input className="min-w-0 flex-1" value={localPart} onChangeText={setLocalPart} placeholder="support" accessibilityLabel="Address name" />
        <Text className="text-sm text-muted-foreground" numberOfLines={1}>@{domainName ?? '…'}</Text>
      </View>
      {verified.length || sharedDomain ? (
        <View className="flex-row flex-wrap gap-1.5">
          {sharedDomain ? <Pill label={sharedDomain} active={!domainId} onPress={() => setDomainId(null)} /> : null}
          {verified.map((d) => (
            <Pill key={d.id} label={d.domain} active={domainId === d.id} onPress={() => setDomainId(d.id)} />
          ))}
        </View>
      ) : null}
      <Input value={displayName} onChangeText={setDisplayName} placeholder="Display name (e.g. Acme Support)" accessibilityLabel="Display name" autoCapitalize="words" />
      {kind === 'agent' ? (
        <View className="gap-1.5">
          <Label>Agent</Label>
          <View className="flex-row flex-wrap gap-1.5">
            {agents.map((a) => (
              <Pill key={a.key} label={a.name} active={agentKey === a.key} onPress={() => setAgentKey(a.key)} />
            ))}
            {!agents.length ? <Text className="text-xs text-muted-foreground">No agents in this workspace yet.</Text> : null}
          </View>
        </View>
      ) : null}
      <View className="flex-row">
        <Button size="sm" disabled={busy || !localPart.trim()} onPress={() => void create()} testID="mail-create-mailbox-submit">
          {busy ? 'Creating…' : 'Create mailbox'}
        </Button>
      </View>
      <ErrorLine error={error} />
    </View>
  )
}

function ConnectAccountForm({ workspaceId, mailbox }: { workspaceId: string; mailbox: Mailbox }) {
  const [address, setAddress] = useState('')
  const [imapHost, setImapHost] = useState('')
  const [imapPort, setImapPort] = useState('993')
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('465')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const preset = (p: 'gmail' | 'outlook') => {
    if (p === 'gmail') {
      setImapHost('imap.gmail.com')
      setSmtpHost('smtp.gmail.com')
    } else {
      setImapHost('outlook.office365.com')
      setSmtpHost('smtp.office365.com')
      setSmtpPort('587')
    }
    setImapPort('993')
    if (p === 'gmail') setSmtpPort('465')
  }

  const connect = async () => {
    setBusy('connect')
    setError(null)
    try {
      await api.connectAccount(workspaceId, mailbox.id, {
        address: address.trim(),
        imapHost: imapHost.trim(),
        imapPort: Number(imapPort) || 993,
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort) || 465,
        username: (username || address).trim(),
        password,
        tls: true,
      })
      setPassword('')
      setNotice('Connected. Mail will start syncing into this mailbox.')
      await invalidateMail(workspaceId)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const accounts = mailbox.accounts ?? []
  return (
    <View className="gap-2" testID="mail-connect-account">
      <Label>Connected mailbox</Label>
      {accounts.map((a) => (
        <View key={a.id} className="flex-row flex-wrap items-center gap-2 rounded-md border border-border p-2">
          <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
            {a.address}
            {a.lastSyncAt ? ` · synced ${new Date(a.lastSyncAt).toLocaleString()}` : ''}
          </Text>
          {a.lastError ? <Text className="w-full text-[11px] text-destructive">{a.lastError}</Text> : null}
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onPress={async () => {
              setBusy(`sync-${a.id}`)
              setError(null)
              try {
                const r = await api.syncAccount(workspaceId, a.id)
                setNotice(`Imported ${r.imported} email${r.imported === 1 ? '' : 's'}.`)
                await invalidateMail(workspaceId)
              } catch (err) {
                setError(errorText(err))
              } finally {
                setBusy(null)
              }
            }}
          >
            {busy === `sync-${a.id}` ? 'Syncing…' : 'Sync now'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onPress={async () => {
              setBusy(`rm-${a.id}`)
              try {
                await api.deleteAccount(workspaceId, a.id)
                await invalidateMail(workspaceId)
              } catch (err) {
                setError(errorText(err))
              } finally {
                setBusy(null)
              }
            }}
          >
            Disconnect
          </Button>
        </View>
      ))}
      <Text className="text-xs text-muted-foreground">
        Bring an existing inbox in over IMAP/SMTP. For Gmail or Outlook, create an app password in your account’s security settings and use it here.
      </Text>
      <View className="flex-row flex-wrap gap-1.5">
        <Pill label="Gmail" active={imapHost === 'imap.gmail.com'} onPress={() => preset('gmail')} />
        <Pill label="Outlook" active={imapHost === 'outlook.office365.com'} onPress={() => preset('outlook')} />
      </View>
      <Input value={address} onChangeText={setAddress} placeholder="you@gmail.com" accessibilityLabel="Email address" keyboardType="email-address" />
      <View className="flex-row gap-2">
        <Input className="min-w-0 flex-1" value={imapHost} onChangeText={setImapHost} placeholder="IMAP host" accessibilityLabel="IMAP host" />
        <Input className="w-20" value={imapPort} onChangeText={setImapPort} placeholder="993" accessibilityLabel="IMAP port" keyboardType="number-pad" />
      </View>
      <View className="flex-row gap-2">
        <Input className="min-w-0 flex-1" value={smtpHost} onChangeText={setSmtpHost} placeholder="SMTP host" accessibilityLabel="SMTP host" />
        <Input className="w-20" value={smtpPort} onChangeText={setSmtpPort} placeholder="465" accessibilityLabel="SMTP port" keyboardType="number-pad" />
      </View>
      <Input value={username} onChangeText={setUsername} placeholder="Username (defaults to the address)" accessibilityLabel="Username" />
      <Input value={password} onChangeText={setPassword} placeholder="App password" accessibilityLabel="App password" secureTextEntry />
      <View className="flex-row">
        <Button
          size="sm"
          disabled={!!busy || !address.trim() || !imapHost.trim() || !smtpHost.trim() || !password}
          onPress={() => void connect()}
        >
          {busy === 'connect' ? 'Connecting…' : 'Connect'}
        </Button>
      </View>
      {notice ? <Text className="text-xs text-emerald-700 dark:text-emerald-400">{notice}</Text> : null}
      <ErrorLine error={error} />
    </View>
  )
}

const RULE_CATEGORIES: MailCategory[] = ['important', 'feed', 'paper_trail', 'spam']

function RulesEditor({ workspaceId, mailbox }: { workspaceId: string; mailbox: Mailbox }) {
  const [rules, setRules] = useState<MailRule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [from, setFrom] = useState('')
  const [subject, setSubject] = useState('')
  const [category, setCategory] = useState<MailCategory | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .rules(workspaceId, mailbox.id)
      .then((r) => !cancelled && setRules(r))
      .catch((err) => !cancelled && setError(errorText(err)))
    return () => {
      cancelled = true
    }
  }, [workspaceId, mailbox.id])

  const create = async () => {
    if (busy || (!instruction.trim() && !from.trim() && !subject.trim())) return
    setBusy(true)
    setError(null)
    try {
      const rule = await api.createRule(workspaceId, mailbox.id, {
        instruction: instruction.trim() || undefined,
        match: from.trim() || subject.trim() ? { from: from.trim() || null, subject: subject.trim() || null } : undefined,
        action: category ? { category } : undefined,
      })
      setRules((r) => [...(r ?? []), rule])
      setInstruction('')
      setFrom('')
      setSubject('')
      setCategory(null)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View className="gap-2" testID="mail-rules">
      <Label>Rules</Label>
      {rules === null && !error ? <ActivityIndicator className="self-start" /> : null}
      {(rules ?? []).map((r) => (
        <View key={r.id} className="flex-row items-start gap-2 rounded-md border border-border p-2">
          <View className="min-w-0 flex-1 gap-0.5">
            {r.instruction ? <Text className="text-xs text-foreground">{r.instruction}</Text> : null}
            {r.match?.from || r.match?.subject ? (
              <Text className="text-[11px] text-muted-foreground">
                {[r.match.from ? `from ${r.match.from}` : null, r.match.subject ? `subject has “${r.match.subject}”` : null].filter(Boolean).join(', ')}
                {r.action?.category ? ` → ${MAIL_CATEGORY_LABELS[r.action.category]}` : ''}
              </Text>
            ) : r.action?.category ? (
              <Text className="text-[11px] text-muted-foreground">→ {MAIL_CATEGORY_LABELS[r.action.category]}</Text>
            ) : null}
          </View>
          <Switch
            checked={r.enabled !== false}
            onCheckedChange={async (on) => {
              setRules((list) => (list ?? []).map((x) => (x.id === r.id ? { ...x, enabled: on } : x)))
              try {
                await api.updateRule(workspaceId, r.id, { enabled: on })
              } catch (err) {
                setError(errorText(err))
              }
            }}
          />
          <Pressable
            onPress={async () => {
              try {
                await api.deleteRule(workspaceId, r.id)
                setRules((list) => (list ?? []).filter((x) => x.id !== r.id))
              } catch (err) {
                setError(errorText(err))
              }
            }}
            accessibilityLabel="Delete rule"
            className="rounded-md p-1 active:bg-muted"
          >
            <Trash2 size={13} className="text-muted-foreground" />
          </Pressable>
        </View>
      ))}
      <Input
        value={instruction}
        onChangeText={setInstruction}
        placeholder="In plain English, e.g. “Receipts and invoices go to Paper trail”"
        accessibilityLabel="Rule instruction"
        autoCapitalize="sentences"
        autoCorrect
      />
      <View className="flex-row gap-2">
        <Input className="min-w-0 flex-1" value={from} onChangeText={setFrom} placeholder="From contains (optional)" accessibilityLabel="From contains" />
        <Input className="min-w-0 flex-1" value={subject} onChangeText={setSubject} placeholder="Subject contains (optional)" accessibilityLabel="Subject contains" />
      </View>
      <View className="flex-row flex-wrap items-center gap-1.5">
        <Text className="text-xs text-muted-foreground">Move to:</Text>
        {RULE_CATEGORIES.map((c) => (
          <Pill key={c} label={MAIL_CATEGORY_LABELS[c]} active={category === c} onPress={() => setCategory(category === c ? null : c)} />
        ))}
      </View>
      <View className="flex-row">
        <Button size="sm" variant="outline" disabled={busy || (!instruction.trim() && !from.trim() && !subject.trim())} onPress={() => void create()}>
          {busy ? 'Adding…' : 'Add rule'}
        </Button>
      </View>
      <ErrorLine error={error} />
    </View>
  )
}

function MailboxSettings({ workspaceId, mailbox }: { workspaceId: string; mailbox: Mailbox }) {
  const [displayName, setDisplayName] = useState(mailbox.displayName ?? '')
  const [signature, setSignature] = useState(mailbox.signature ?? '')
  const [sla, setSla] = useState(mailbox.slaHours ? String(mailbox.slaHours) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const save = async (patch: Parameters<typeof api.updateMailbox>[2]) => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await api.updateMailbox(workspaceId, mailbox.id, patch)
      setMailOverview(workspaceId, (o) => ({ ...o, mailboxes: o.mailboxes.map((m) => (m.id === next.id ? { ...m, ...next } : m)) }))
      setSaved(true)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <View className="gap-3 border-t border-border pt-3">
      <View className="gap-1">
        <Label>Display name</Label>
        <Input value={displayName} onChangeText={setDisplayName} accessibilityLabel="Display name" autoCapitalize="words" />
      </View>
      <View className="gap-1">
        <Label>Signature</Label>
        <Input
          value={signature}
          onChangeText={setSignature}
          multiline
          accessibilityLabel="Signature"
          autoCapitalize="sentences"
          className="min-h-[72px]"
          style={{ textAlignVertical: 'top' }}
        />
      </View>
      <View className="gap-1">
        <Label>Reply within (hours)</Label>
        <Input value={sla} onChangeText={setSla} placeholder="No target" accessibilityLabel="SLA hours" keyboardType="number-pad" className="w-32" />
        <Text className="text-[11px] text-muted-foreground">Threads still open after this many hours are flagged as past SLA.</Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={saving}
          onPress={() =>
            void save({
              displayName: displayName.trim() || null,
              signature: signature || null,
              slaHours: sla.trim() ? Number(sla) || null : null,
            })
          }
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {saved ? <Text className="text-xs text-emerald-700 dark:text-emerald-400">Saved</Text> : null}
      </View>
      <View className="flex-row items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <View className="flex-1">
          <Text className="text-sm font-medium text-foreground">Screener</Text>
          <Text className="mt-0.5 text-xs text-muted-foreground">Mail from first-time senders waits in Screener until someone allows it.</Text>
        </View>
        <Switch checked={mailbox.screenerEnabled} onCheckedChange={(on) => void save({ screenerEnabled: on })} disabled={saving} />
      </View>
      <View className="gap-0.5 rounded-lg border border-border px-4 py-3">
        <Text className="text-sm font-medium text-foreground">Sending</Text>
        <Text className="text-xs text-muted-foreground">
          {mailbox.kind === 'agent'
            ? 'Every email this agent writes waits for a person to approve, edit or discard it.'
            : 'Emails go out after a 10-second undo window, or at the time you schedule.'}
        </Text>
      </View>
      <ErrorLine error={error} />
      <RulesEditor workspaceId={workspaceId} mailbox={mailbox} />
      <ConnectAccountForm workspaceId={workspaceId} mailbox={mailbox} />
    </View>
  )
}

function MailboxRow({ workspaceId, mailbox, agentName }: { workspaceId: string; mailbox: Mailbox; agentName: string | null }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)
  return (
    <View className="gap-2 rounded-lg border border-border p-3" testID="mail-mailbox">
      <Pressable onPress={() => setOpen((v) => !v)} className="flex-row items-center gap-2" accessibilityRole="button">
        {open ? <ChevronDown size={14} className="text-muted-foreground" /> : <ChevronRight size={14} className="text-muted-foreground" />}
        <Inbox size={14} className="text-muted-foreground" />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>{mailbox.address}</Text>
          <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
            {mailbox.kind === 'agent' ? `Agent${agentName ? ` · ${agentName}` : ''}` : mailbox.kind === 'shared' ? 'Shared' : 'Person'}
            {mailbox.displayName ? ` · ${mailbox.displayName}` : ''}
          </Text>
        </View>
      </Pressable>
      {open ? (
        <>
          <MailboxSettings workspaceId={workspaceId} mailbox={mailbox} />
          <View className="flex-row">
            <Button
              size="sm"
              variant="ghost"
              disabled={archiving}
              onPress={async () => {
                setArchiving(true)
                setError(null)
                try {
                  await api.archiveMailbox(workspaceId, mailbox.id)
                  await invalidateMail(workspaceId)
                } catch (err) {
                  setError(errorText(err))
                  setArchiving(false)
                }
              }}
            >
              {archiving ? 'Archiving…' : 'Archive mailbox'}
            </Button>
          </View>
          <ErrorLine error={error} />
        </>
      ) : null}
    </View>
  )
}

export function EmailSettingsTab() {
  const workspace = useActiveWorkspace()
  const experience = useWorkspaceExperience()
  const workspaceId: string | null = experience.kind === 'team' ? workspace?.id ?? null : null
  const { overview, error, loading, refresh } = useMailOverview(workspaceId)
  const mentionables = useMentionables(workspaceId)
  const agentNames = useMemo(
    () => new Map((mentionables?.agents ?? []).map((a) => [agentRefFor(a.projectId), a.name])),
    [mentionables],
  )

  if (experience.resolved && experience.kind !== 'team') {
    return (
      <View className="flex-1 items-center justify-center bg-background px-8 py-12">
        <Text className="text-center text-sm text-muted-foreground">Email is available in team workspaces.</Text>
      </View>
    )
  }
  if (!workspaceId || loading) {
    return (
      <View className="items-center py-12">
        <ActivityIndicator />
      </View>
    )
  }
  if (!overview) {
    return (
      <View className="items-center gap-3 py-12">
        <Text className="text-center text-sm text-destructive">{error ?? 'Could not load email settings.'}</Text>
        <Button size="sm" variant="outline" onPress={() => void refresh()}>
          Try again
        </Button>
      </View>
    )
  }

  const mailboxes = overview.mailboxes.filter((m) => !m.archivedAt)
  const paused = overview.domains.filter((d) => d.sendingPaused)
  const sent = overview.usage?.sent24h ?? 0
  const limit = overview.limits?.dailySend ?? null
  const slug = (workspace as { slug?: string } | null)?.slug ?? 'your-workspace'

  return (
    <View className="pb-8" testID="email-settings">
      {!overview.enabled ? (
        <View className="mt-3 flex-row items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <AlertTriangle size={14} className="text-amber-600" />
          <Text className="min-w-0 flex-1 text-xs text-amber-800 dark:text-amber-300">
            Email isn’t turned on for this server yet ({overview.provider || 'no provider'}). You can still set things up here.
          </Text>
        </View>
      ) : null}
      {overview.limits?.canSend === false ? (
        <View className="mt-3 flex-row items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3" testID="mail-receive-only-banner">
          <AlertTriangle size={14} className="text-amber-600" />
          <Text className="min-w-0 flex-1 text-xs text-amber-800 dark:text-amber-300">
            This workspace can receive email. Sending needs a paid plan and a verified email; upgrade in Settings → Billing.
          </Text>
        </View>
      ) : null}
      {paused.map((d) => (
        <View key={d.id} className="mt-3 flex-row items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3" testID="mail-paused-banner">
          <AlertTriangle size={14} className="text-destructive" />
          <Text className="min-w-0 flex-1 text-xs text-destructive">
            Sending from {d.domain} is paused{d.pausedReason ? `: ${d.pausedReason}` : ''}. Resume it under Domains once the cause is fixed.
          </Text>
        </View>
      ))}

      <Section title="Addresses" description="Every workspace gets free addresses on Shogo’s shared mail domain. No DNS needed.">
        {overview.sharedDomain ? (
          <View className="flex-row items-center gap-2 rounded-md bg-muted/40 p-2">
            <Text selectable className="min-w-0 flex-1 font-mono text-xs text-foreground">
              {slug}.name@{overview.sharedDomain}
            </Text>
            <CopyButton value={`${slug}.name@${overview.sharedDomain}`} label="address format" />
          </View>
        ) : (
          <Text className="text-xs text-muted-foreground">No shared domain is configured on this server.</Text>
        )}
      </Section>

      <Section title="Sending" description="Limits are per workspace over a rolling 24 hours.">
        <View className="gap-1.5">
          <Text className="text-sm text-foreground">
            {sent} sent{limit ? ` of ${limit}` : ''} in the last 24 hours
          </Text>
          {limit ? (
            <View className="h-1.5 overflow-hidden rounded-full bg-muted">
              <View
                className={cn('h-full rounded-full', sent / limit > 0.9 ? 'bg-destructive' : 'bg-primary')}
                style={{ width: `${Math.min(100, Math.round((sent / limit) * 100))}%` }}
              />
            </View>
          ) : null}
        </View>
      </Section>

      <Section title="Domains" description="Send and receive as your own domain.">
        {overview.domains.map((d) => <DomainCard key={d.id} workspaceId={workspaceId} domain={d} />)}
        {!overview.domains.length ? <Text className="text-xs text-muted-foreground">No domains yet.</Text> : null}
        <AddDomainForm workspaceId={workspaceId} />
      </Section>

      <Section title="Mailboxes" description="Each mailbox appears in team chat as a private conversation for the people who read it." testID="mail-mailboxes">
        {mailboxes.map((m) => (
          <MailboxRow key={m.id} workspaceId={workspaceId} mailbox={m} agentName={m.agentRef ? agentNames.get(m.agentRef) ?? null : null} />
        ))}
        {!mailboxes.length ? <Text className="text-xs text-muted-foreground">No mailboxes yet.</Text> : null}
        <CreateMailboxForm workspaceId={workspaceId} domains={overview.domains} sharedDomain={overview.sharedDomain} />
      </Section>
    </View>
  )
}
