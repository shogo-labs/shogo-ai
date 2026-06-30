// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PublishDropdown - React Native port of the web PublishDropdown.
 *
 * Renders as a Popover anchored to a "Publish" trigger button.
 * Features:
 * - Subdomain input with availability checking
 * - Access level selector (Anyone / Authenticated / Private)
 * - Publish / Unpublish actions
 * - Live URL display when published
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  Linking,
} from 'react-native'
import {
  Globe,
  Lock,
  Users,
  KeyRound,
  ExternalLink,
  CheckCircle,
  XCircle,
  ChevronDown,
  History,
  UploadCloud,
} from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import { api } from '../../lib/api'
import { useDomainHttp } from '../../contexts/domain'
import { CustomDomainsSection } from './CustomDomainsSection'
import { AlwaysOnSection } from './AlwaysOnSection'

export type AccessLevel = 'anyone' | 'authenticated' | 'private' | 'password'

const PUBLISH_DOMAIN = 'shogo.one'

const SITE_PASSWORD_MIN_LENGTH = 4

const ACCESS_OPTIONS: { value: AccessLevel; label: string; Icon: any }[] = [
  { value: 'anyone', label: 'Anyone', Icon: Globe },
  { value: 'authenticated', label: 'Authenticated users', Icon: Users },
  { value: 'private', label: 'Private', Icon: Lock },
  { value: 'password', label: 'Password protected', Icon: KeyRound },
]

// Map a publish error to user-facing copy. The thrown ShogoError carries the
// raw response body in `details`, so we can switch on the structured server
// code (e.g. the cloud-proxy codes returned by the local/desktop API) and fall
// back to the server message otherwise.
function publishErrorMessage(err: any): string {
  const code: string | undefined = err?.details?.error?.code ?? err?.details?.code
  switch (code) {
    case 'cloud_signin_required':
      return 'Sign in to Shogo Cloud to publish from the desktop app.'
    case 'project_not_synced':
      return 'Sync this project to Shogo Cloud before publishing.'
    case 'cloud_unreachable':
      return "Couldn't reach Shogo Cloud. Check your connection and try again."
    default:
      return err?.message || 'Failed to publish'
  }
}

interface PublishDropdownProps {
  projectId: string
  projectName: string
  /** Cross-link to the commit graph / checkpoints (IDE Checkpoint activity). */
  onViewHistory?: () => void
}

export function PublishDropdown({ projectId, projectName, onViewHistory }: PublishDropdownProps) {
  const http = useDomainHttp()
  const router = useRouter()
  const [isOpen, setIsOpen] = useState(false)
  const [subdomain, setSubdomain] = useState(
    () => projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  )
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('anyone')
  // Shared site password (only for accessLevel === 'password'). Never
  // pre-filled from the server (the raw value is never returned); `hasPassword`
  // tells us whether a gate is already configured so we can show the right copy.
  const [password, setPassword] = useState('')
  const [hasPassword, setHasPassword] = useState(false)
  const [isSavingPassword, setIsSavingPassword] = useState(false)
  const [isPublished, setIsPublished] = useState(false)
  const [publishedAt, setPublishedAt] = useState<number | null>(null)
  const [publishedSubdomain, setPublishedSubdomain] = useState<string | null>(null)
  const [publishedCommitSha, setPublishedCommitSha] = useState<string | null>(null)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isUnpublishing, setIsUnpublishing] = useState(false)
  const [isRepublishing, setIsRepublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAccessPicker, setShowAccessPicker] = useState(false)

  // Bumped after publish/republish/unpublish so the embedded AlwaysOnSection
  // (which self-loads publish state) re-fetches its slot meter + toggle state.
  const [publishStateNonce, setPublishStateNonce] = useState(0)
  const bumpPublishState = () => setPublishStateNonce((n) => n + 1)

  // Whether the workspace plan (Pro+) may publish to a new/changed subdomain.
  // Defaults to true so the controls aren't gated before state loads.
  const [planAllowsPublish, setPlanAllowsPublish] = useState(true)

  const [subdomainStatus, setSubdomainStatus] = useState<{
    checking: boolean
    available: boolean | null
    reason?: string
  }>({ checking: false, available: null })

  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isOpen) return
    loadPublishState()
  }, [isOpen, projectId])

  const loadPublishState = useCallback(async () => {
    try {
      const data = await api.getPublishState(http, projectId)
      if (data.subdomain) {
        setIsPublished(true)
        setPublishedSubdomain(data.subdomain)
        setSubdomain(data.subdomain)
        setPublishedAt(data.publishedAt ?? null)
        setPublishedCommitSha(data.publishedCommitSha ?? null)
        if (data.accessLevel) setAccessLevel(data.accessLevel as AccessLevel)
        setHasPassword(data.hasPassword === true)
      }
      setPlanAllowsPublish(data.canPublish !== false)
    } catch {}
  }, [http, projectId])

  useEffect(() => {
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
    if (!subdomain || subdomain.length < 3 || subdomain === publishedSubdomain) {
      setSubdomainStatus({ checking: false, available: subdomain === publishedSubdomain ? true : null })
      return
    }

    setSubdomainStatus({ checking: true, available: null })
    checkTimerRef.current = setTimeout(async () => {
      try {
        const data = await api.checkSubdomain(http, subdomain)
        setSubdomainStatus({ checking: false, available: data.available, reason: data.reason })
      } catch {
        setSubdomainStatus({ checking: false, available: null, reason: 'Check failed' })
      }
    }, 500)

    return () => { if (checkTimerRef.current) clearTimeout(checkTimerRef.current) }
  }, [http, subdomain, publishedSubdomain])

  const handlePublish = async () => {
    if (!subdomain || subdomain.length < 3) return
    setIsPublishing(true)
    setError(null)
    try {
      const data = await api.publishProject(
        http,
        projectId,
        subdomain,
        accessLevel,
        accessLevel === 'password' && password ? password : undefined,
      )
      setIsPublished(true)
      setPublishedSubdomain(data.subdomain)
      setPublishedAt(data.publishedAt)
      if (typeof data.hasPassword === 'boolean') setHasPassword(data.hasPassword)
      // The plaintext lives only in this submit; drop it from memory.
      setPassword('')
      // A fresh publish may flip the app to server-backed / consume a slot.
      bumpPublishState()
    } catch (err: any) {
      setError(publishErrorMessage(err))
    } finally {
      setIsPublishing(false)
    }
  }

  // Change the visitor access level. For an already-published app we persist
  // immediately via PATCH (mirrors the always-on toggle). Switching TO
  // `password` defers the PATCH until a password is entered + saved below;
  // switching to any other level persists right away (clearing any gate).
  const handleSelectAccess = async (value: AccessLevel) => {
    setShowAccessPicker(false)
    if (value === accessLevel) return
    const prev = accessLevel
    setAccessLevel(value)
    setError(null)
    if (!isPublished || value === 'password') return
    try {
      const data = await api.updatePublishSettings(http, projectId, { accessLevel: value })
      setHasPassword(data.hasPassword === true)
    } catch (err: any) {
      setAccessLevel(prev)
      setError(err?.message || 'Failed to update access')
    }
  }

  // Persist a new shared password for an already-published app.
  const handleSavePassword = async () => {
    if (!isPublished || password.length < SITE_PASSWORD_MIN_LENGTH) return
    setIsSavingPassword(true)
    setError(null)
    try {
      const data = await api.updatePublishSettings(http, projectId, {
        accessLevel: 'password',
        password,
      })
      setHasPassword(data.hasPassword === true)
      setPassword('')
    } catch (err: any) {
      setError(err?.message || 'Failed to set password')
    } finally {
      setIsSavingPassword(false)
    }
  }

  const handleUnpublish = async () => {
    setIsUnpublishing(true)
    setError(null)
    try {
      await api.unpublishProject(http, projectId)
      setIsPublished(false)
      setPublishedSubdomain(null)
      setPublishedAt(null)
      // Server resets access to `anyone` and clears the gate on unpublish.
      setHasPassword(false)
      setPassword('')
      // Unpublishing frees the always-on slot; refresh the AlwaysOnSection.
      bumpPublishState()
    } catch (err: any) {
      setError(err.message || 'Failed to unpublish')
    } finally {
      setIsUnpublishing(false)
    }
  }

  const goToBilling = () => {
    setIsOpen(false)
    router.push('/(app)/billing' as any)
  }

  // Re-deploy the current HEAD to the SAME subdomain (rebuild + re-tag). Unlike
  // "Update URL" (which re-publishes to a changed subdomain), this is the
  // affordance for shipping new changes once the subdomain is settled.
  const handleRepublish = async () => {
    setIsRepublishing(true)
    setError(null)
    try {
      const data = await api.republishProject(http, projectId)
      setPublishedAt(data.publishedAt)
      // HEAD moved — refresh the recorded live commit sha + always-on state.
      await loadPublishState()
      bumpPublishState()
    } catch (err: any) {
      setError(publishErrorMessage(err))
    } finally {
      setIsRepublishing(false)
    }
  }

  const handleViewPublished = () => {
    if (publishedSubdomain) {
      Linking.openURL(`https://${publishedSubdomain}.${PUBLISH_DOMAIN}`)
    }
  }

  // Publishing as password-protected requires a password unless one is already
  // configured for this (unchanged) subdomain — the server reuses the stored
  // hash in that case.
  const passwordSatisfied =
    accessLevel !== 'password' ||
    password.length >= SITE_PASSWORD_MIN_LENGTH ||
    (hasPassword && subdomain === publishedSubdomain)

  // Publishing to a new/changed subdomain requires a Pro+ plan; republishing
  // the same subdomain is always allowed (matches the server-side gate).
  const planSatisfiesPublish = planAllowsPublish || subdomain === publishedSubdomain

  const canPublish =
    subdomain.length >= 3 &&
    !subdomainStatus.checking &&
    (subdomainStatus.available === true || subdomain === publishedSubdomain) &&
    passwordSatisfied &&
    planSatisfiesPublish &&
    !isPublishing

  const currentAccess = ACCESS_OPTIONS.find(o => o.value === accessLevel) || ACCESS_OPTIONS[0]

  return (
    <Popover
      placement="bottom"
      size="lg"
      isOpen={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          className="h-8 flex-row items-center px-3 rounded-md bg-primary active:bg-primary/80"
        >
          <Text className="text-xs font-medium text-primary-foreground">Publish</Text>
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="max-w-[360px] p-0">
        <PopoverBody>
          <View className="p-5">
          {/* Header */}
          <View className="flex-row items-center justify-between mb-4">
            <Text className="text-lg font-semibold text-foreground">
              {isPublished ? 'Your app is live' : 'Publish your app'}
            </Text>
            {isPublished && publishedSubdomain && (
              <Pressable
                onPress={handleViewPublished}
                className="flex-row items-center gap-1 px-2 py-1 rounded-md active:bg-muted"
              >
                <ExternalLink size={12} className="text-primary" />
                <Text className="text-xs text-primary">View</Text>
              </Pressable>
            )}
          </View>

          {/* Published URL banner */}
          {isPublished && publishedSubdomain && (
            <View className="gap-1 p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20 mb-4">
              <View className="flex-row items-center gap-2">
                <CheckCircle size={16} color="#10b981" />
                <Text className="text-sm text-emerald-600 dark:text-emerald-400">
                  {publishedSubdomain}.{PUBLISH_DOMAIN}
                </Text>
              </View>
              {publishedCommitSha && (
                <Text className="text-[11px] text-muted-foreground ml-6 font-mono">
                  commit {publishedCommitSha.slice(0, 8)}
                </Text>
              )}
            </View>
          )}

          {/* Cross-link into the commit graph (history + checkpoints + live) */}
          {isPublished && onViewHistory && (
            <Pressable
              onPress={() => { setIsOpen(false); onViewHistory() }}
              className="flex-row items-center gap-1.5 mb-4 -mt-1"
            >
              <History size={13} className="text-primary" />
              <Text className="text-xs text-primary">View deploy history & checkpoints</Text>
            </Pressable>
          )}

          {/* Subdomain input */}
          <View className="mb-4">
            <Text className="text-xs font-medium text-foreground mb-1">
              {isPublished ? 'Change URL' : 'Published URL'}
            </Text>
            <Text className="text-[11px] text-muted-foreground mb-2">
              Enter your URL, or leave the default.
            </Text>
            <View className="flex-row items-center border border-border rounded-lg overflow-hidden">
              <TextInput
                value={subdomain}
                onChangeText={(t) => setSubdomain(t.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="my-project"
                placeholderTextColor="#9ca3af"
                autoCapitalize="none"
                autoCorrect={false}
                className="flex-1 h-10 px-3 text-sm text-foreground web:outline-none"
              />
              <View className="pr-3">
                {subdomainStatus.checking && <ActivityIndicator size="small" />}
                {!subdomainStatus.checking && subdomainStatus.available === true && subdomain !== publishedSubdomain && (
                  <CheckCircle size={16} color="#10b981" />
                )}
                {!subdomainStatus.checking && subdomainStatus.available === false && (
                  <XCircle size={16} color="#ef4444" />
                )}
              </View>
            </View>
            <View className="flex-row items-center justify-between mt-1">
              <Text className="text-[11px] text-muted-foreground">
                {subdomain || 'your-subdomain'}.{PUBLISH_DOMAIN}
              </Text>
              {subdomainStatus.available === false && subdomainStatus.reason && (
                <Text className="text-[11px] text-destructive">{subdomainStatus.reason}</Text>
              )}
            </View>
          </View>

          {/* Access level */}
          <View className="mb-4">
            <Text className="text-xs font-medium text-foreground mb-1.5">
              Who can visit the URL?
            </Text>
            <Pressable
              onPress={() => setShowAccessPicker(!showAccessPicker)}
              className="flex-row items-center justify-between h-10 px-3 rounded-lg border border-border"
            >
              <View className="flex-row items-center gap-2">
                <currentAccess.Icon size={14} className="text-muted-foreground" />
                <Text className="text-sm text-foreground">{currentAccess.label}</Text>
              </View>
              <ChevronDown size={14} className="text-muted-foreground" />
            </Pressable>
            {showAccessPicker && (
              <View className="mt-1 border border-border rounded-lg overflow-hidden">
                {ACCESS_OPTIONS.map(({ value, label, Icon }) => (
                  <Pressable
                    key={value}
                    onPress={() => handleSelectAccess(value)}
                    className={cn('flex-row items-center gap-2 px-3 py-2.5', accessLevel === value && 'bg-accent')}
                  >
                    <Icon size={14} className="text-muted-foreground" />
                    <Text className={cn('text-sm', accessLevel === value ? 'text-foreground font-medium' : 'text-foreground')}>
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            {/* Shared site password (accessLevel === 'password'). The password
                is enforced at the edge; visitors are prompted before the site
                loads. For an already-published app, "Save" persists the new
                password immediately; on first publish it's sent with Publish. */}
            {accessLevel === 'password' && (
              <View className="mt-2">
                <View className="flex-row items-center gap-2">
                  <TextInput
                    value={password}
                    onChangeText={setPassword}
                    placeholder={hasPassword ? 'Password set — enter new to change' : 'Enter a password'}
                    placeholderTextColor="#9ca3af"
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="flex-1 h-10 px-3 text-sm text-foreground border border-border rounded-lg web:outline-none"
                  />
                  {isPublished && (
                    <Pressable
                      onPress={handleSavePassword}
                      disabled={password.length < SITE_PASSWORD_MIN_LENGTH || isSavingPassword}
                      className={cn(
                        'h-10 px-3 rounded-lg items-center justify-center',
                        password.length >= SITE_PASSWORD_MIN_LENGTH && !isSavingPassword ? 'bg-primary' : 'bg-muted',
                      )}
                    >
                      {isSavingPassword ? (
                        <ActivityIndicator size="small" />
                      ) : (
                        <Text
                          className={cn(
                            'text-xs font-medium',
                            password.length >= SITE_PASSWORD_MIN_LENGTH ? 'text-primary-foreground' : 'text-muted-foreground',
                          )}
                        >
                          Save
                        </Text>
                      )}
                    </Pressable>
                  )}
                </View>
                <Text className="text-[11px] text-muted-foreground mt-1">
                  {hasPassword
                    ? 'Visitors must enter this password. Leave blank to keep the current one.'
                    : `Visitors must enter this password to view the site (min ${SITE_PASSWORD_MIN_LENGTH} characters).`}
                </Text>
              </View>
            )}
          </View>

          {/* Always on — only for server-backed published apps (a static app
              served from the edge gains nothing from a warm pod). Shared with
              the project Settings pane via AlwaysOnSection. */}
          {isPublished && (
            <AlwaysOnSection
              projectId={projectId}
              http={http}
              embedded
              reloadNonce={publishStateNonce}
              onBeforeNavigate={() => setIsOpen(false)}
            />
          )}

          {/* Custom domains — only meaningful once the app is published.
              `http` is passed down because this dropdown renders inside a
              gluestack Popover whose overlay is teleported outside the
              SDKDomainProvider, so the section can't resolve useDomainHttp()
              on its own. */}
          {isPublished && <CustomDomainsSection projectId={projectId} http={http} />}

          {/* Pro gate — publishing to a subdomain requires Pro+. Republishing
              an already-live site is still allowed, so only show this when the
              plan can't publish a new/changed subdomain. */}
          {!planAllowsPublish && (
            <Pressable
              onPress={goToBilling}
              className="mb-4 flex-row items-center gap-3 rounded-lg border border-border p-3"
            >
              <Globe size={16} className="text-muted-foreground" />
              <View className="flex-1">
                <View className="flex-row items-center gap-2">
                  <Text className="text-sm font-medium text-foreground">Publish to a subdomain</Text>
                  <View className="rounded px-1.5 bg-primary/10">
                    <Text className="text-[10px] text-primary font-medium">Pro</Text>
                  </View>
                </View>
                <Text className="text-[11px] text-muted-foreground mt-0.5">
                  {isPublished
                    ? 'Changing your URL requires Pro. You can still publish updates to your current URL.'
                    : 'Get a public link at {subdomain}.shogo.one. Available on Pro & Business.'}
                </Text>
              </View>
              <ExternalLink size={14} className="text-primary" />
            </Pressable>
          )}

          {/* Error */}
          {error && (
            <View className="p-3 bg-destructive/10 rounded-lg border border-destructive/20 mb-4">
              <Text className="text-xs text-destructive">{error}</Text>
            </View>
          )}

          {/* Actions */}
          <View className="flex-row gap-3">
            {isPublished ? (
              <>
                <Pressable
                  onPress={handleUnpublish}
                  disabled={isUnpublishing}
                  className="flex-1 h-10 rounded-lg border border-destructive/30 items-center justify-center"
                >
                  <Text className="text-sm font-medium text-destructive">
                    {isUnpublishing ? 'Unpublishing...' : 'Unpublish'}
                  </Text>
                </Pressable>
                {subdomain !== publishedSubdomain ? (
                  <Pressable
                    onPress={handlePublish}
                    disabled={!canPublish}
                    className={cn('flex-1 h-10 rounded-lg items-center justify-center', canPublish ? 'bg-primary' : 'bg-muted')}
                  >
                    <Text className={cn('text-sm font-medium', canPublish ? 'text-primary-foreground' : 'text-muted-foreground')}>
                      {isPublishing ? 'Updating...' : 'Update URL'}
                    </Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={handleRepublish}
                    disabled={isRepublishing}
                    className={cn('flex-1 h-10 rounded-lg items-center justify-center flex-row gap-1.5', isRepublishing ? 'bg-muted' : 'bg-primary')}
                  >
                    {isRepublishing ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <UploadCloud size={14} className="text-primary-foreground" />
                    )}
                    <Text
                      numberOfLines={1}
                      className={cn('text-sm font-medium', isRepublishing ? 'text-muted-foreground' : 'text-primary-foreground')}
                    >
                      {isRepublishing ? 'Publishing...' : 'Publish latest'}
                    </Text>
                  </Pressable>
                )}
              </>
            ) : (
              <>
                <Pressable
                  onPress={() => setIsOpen(false)}
                  className="flex-1 h-10 rounded-lg border border-border items-center justify-center"
                >
                  <Text className="text-sm font-medium text-foreground">Cancel</Text>
                </Pressable>
                {!planAllowsPublish ? (
                  <Pressable
                    onPress={goToBilling}
                    className="flex-1 h-10 rounded-lg items-center justify-center bg-primary"
                  >
                    <Text className="text-sm font-medium text-primary-foreground">Upgrade to Pro</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={handlePublish}
                    disabled={!canPublish}
                    className={cn('flex-1 h-10 rounded-lg items-center justify-center', canPublish ? 'bg-primary' : 'bg-muted')}
                  >
                    {isPublishing ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text className={cn('text-sm font-medium', canPublish ? 'text-primary-foreground' : 'text-muted-foreground')}>
                        Publish
                      </Text>
                    )}
                  </Pressable>
                )}
              </>
            )}
          </View>
          </View>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}
