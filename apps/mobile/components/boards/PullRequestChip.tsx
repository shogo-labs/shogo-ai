// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A card's pull request, on the card (a one-line chip) and in the pane (state,
 * checks, armed/queued, last synced). The chip is what stops a red or
 * pre-QA PR from sitting unnoticed: it is the board's own view of GitHub
 * rather than an agent's claim in a comment.
 */
import { useState } from 'react'
import { Linking, Pressable, Text, TextInput, View } from 'react-native'
import { CircleAlert, CircleCheck, GitMerge, GitPullRequest, Link2, TriangleAlert } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import type { CardPullRequest } from '../../lib/work-boards-api'

/** `red` is a failing *required* check; any red check is still shown failing. */
function hasFailingChecks(pr: CardPullRequest): boolean {
  return pr.red || pr.checks.failing > 0
}

/** `#1519 · 3/4 checks · armed`, `#1519 · merged`, `#1519 · 2/4 checks · failing`. */
export function prChipText(pr: CardPullRequest): string {
  const head = `#${pr.number}`
  if (pr.merged) return `${head} · merged`
  if (pr.state === 'closed') return `${head} · closed`
  const parts = [head]
  if (pr.checks.total) parts.push(`${pr.checks.passing}/${pr.checks.total} checks`)
  if (hasFailingChecks(pr)) parts.push('failing')
  else if (pr.checks.pending) parts.push(`${pr.checks.pending} running`)
  if (pr.armed) parts.push('armed')
  if (pr.queued) parts.push('queued')
  if (pr.draft) parts.push('draft')
  return parts.join(' · ')
}

type Tone = 'red' | 'warning' | 'green' | 'muted'

export function prTone(pr: CardPullRequest): Tone {
  if (hasFailingChecks(pr)) return 'red'
  // Armed where the board does not allow arming: left alone, but flagged.
  if (pr.armed && pr.armingWarning) return 'warning'
  if (pr.merged) return 'green'
  if (pr.state === 'open' && pr.checks.total > 0 && pr.checks.passing === pr.checks.total) return 'green'
  return 'muted'
}

const TONE_STYLE: Record<Tone, { box: string; text: string }> = {
  red: { box: 'bg-destructive/10', text: 'text-destructive' },
  warning: { box: 'bg-amber-500/15', text: 'text-amber-700 dark:text-amber-400' },
  green: { box: 'bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-400' },
  muted: { box: 'bg-muted', text: 'text-muted-foreground' },
}

function PrIcon({ pr, size = 10, className }: { pr: CardPullRequest; size?: number; className?: string }) {
  if (hasFailingChecks(pr)) return <CircleAlert size={size} className={className} />
  if (pr.armed && pr.armingWarning) return <TriangleAlert size={size} className={className} />
  if (pr.merged) return <GitMerge size={size} className={className} />
  if (pr.state === 'open' && pr.checks.total > 0 && pr.checks.passing === pr.checks.total) return <CircleCheck size={size} className={className} />
  return <GitPullRequest size={size} className={className} />
}

/** The chip on a board tile. Tapping it opens the PR, not the card. */
export function PullRequestChip({ pr }: { pr: CardPullRequest }) {
  const tone = TONE_STYLE[prTone(pr)]
  const label = prChipText(pr)
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Pull request ${label}. Opens on GitHub.`}
      testID={`board-card-pr-${pr.number}`}
      disabled={!pr.url}
      onPress={() => pr.url && void Linking.openURL(pr.url)}
      className={cn('flex-row items-center gap-1 rounded px-1.5 py-0.5', tone.box)}
    >
      <PrIcon pr={pr} className={tone.text} />
      <Text className={cn('text-[10px] font-medium', tone.text)} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

function when(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function describe(pr: CardPullRequest): string {
  if (pr.merged) return 'Merged'
  if (pr.state === 'closed') return 'Closed without merging'
  if (pr.red) return 'A required check is failing'
  if (pr.checks.failing > 0) return `${pr.checks.failing} check${pr.checks.failing === 1 ? '' : 's'} failing, none required — the card stays put`
  if (pr.queued) return 'In the merge queue'
  if (pr.armed && pr.armingWarning) return 'Armed outside the guard — this column may not arm'
  if (pr.armed) return 'Armed — merges when the required checks pass'
  if (pr.draft) return 'Draft'
  if (pr.checks.total && pr.checks.passing === pr.checks.total && !pr.checks.pending) return 'All checks passing'
  if (pr.checks.pending) return `${pr.checks.pending} check${pr.checks.pending === 1 ? '' : 's'} running`
  return 'No checks reported yet'
}

/** The pane's PR section: state, failing checks with their run, last read. */
export function PullRequestSection({ pr, onLink }: { pr: CardPullRequest | undefined; onLink?: (url: string) => Promise<void> | void }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!pr) {
    if (!onLink) return null
    const submit = async () => {
      const value = url.trim()
      if (!value || busy) return
      setBusy(true)
      setError(null)
      try {
        await onLink(value)
        setUrl('')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not link the pull request')
      } finally {
        setBusy(false)
      }
    }
    return (
      <View className="gap-1.5 rounded-md border border-border p-2.5" testID="card-pr-link">
        <View className="flex-row items-center gap-1.5">
          <Link2 size={12} className="text-muted-foreground" />
          <Text className="text-[11px] font-medium uppercase text-muted-foreground">Pull request</Text>
        </View>
        <Text className="text-xs text-muted-foreground">Paste a GitHub pull request URL to track its checks and merge state here.</Text>
        <TextInput
          value={url}
          onChangeText={setUrl}
          onSubmitEditing={() => void submit()}
          placeholder="https://github.com/owner/repo/pull/1519"
          placeholderTextColor="#8a8a8a"
          accessibilityLabel="Pull request URL"
          autoCapitalize="none"
          className="rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-foreground"
        />
        {error ? <Text className="text-xs text-destructive">{error}</Text> : null}
        <Pressable
          accessibilityRole="button"
          onPress={() => void submit()}
          disabled={busy || !url.trim()}
          className={cn('self-start rounded-md bg-primary px-3 py-1', (busy || !url.trim()) && 'opacity-50')}
        >
          <Text className="text-sm text-primary-foreground">Link</Text>
        </Pressable>
      </View>
    )
  }

  const tone = TONE_STYLE[prTone(pr)]
  return (
    <View className="gap-2 rounded-md border border-border p-2.5" testID="card-pr">
      <View className="flex-row items-center gap-1.5">
        <PrIcon pr={pr} size={13} className={tone.text} />
        <Pressable
          accessibilityRole="link"
          className="min-w-0 flex-1"
          disabled={!pr.url}
          onPress={() => pr.url && void Linking.openURL(pr.url)}
        >
          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
            #{pr.number} · {pr.repo}
          </Text>
        </Pressable>
        <View className={cn('rounded px-1.5 py-0.5', tone.box)}>
          <Text className={cn('text-[10px] font-medium', tone.text)}>{pr.merged ? 'merged' : pr.state}</Text>
        </View>
      </View>
      <Text className="text-xs text-foreground">{describe(pr)}</Text>
      {pr.checks.total ? (
        <Text className="text-[11px] text-muted-foreground">
          {pr.checks.passing} passing · {pr.checks.failing} failing · {pr.checks.pending} running of {pr.checks.total}
        </Text>
      ) : null}
      {pr.failing.map((check) => (
        <Pressable
          key={check.name}
          accessibilityRole={check.url ? 'link' : 'text'}
          disabled={!check.url}
          onPress={() => check.url && void Linking.openURL(check.url)}
          className="flex-row items-center gap-1.5 rounded bg-destructive/5 px-1.5 py-0.5"
        >
          <CircleAlert size={10} className="text-destructive" />
          <Text className="text-[11px] text-destructive" numberOfLines={1}>{check.name}</Text>
        </Pressable>
      ))}
      <Text className="text-[10px] text-muted-foreground">
        {pr.armed && !pr.queued ? 'Auto-merge armed · ' : pr.queued ? 'In the merge queue · ' : ''}
        Synced {when(pr.syncedAt)}
      </Text>
    </View>
  )
}
