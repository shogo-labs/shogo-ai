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
  ExternalLink,
  CheckCircle,
  XCircle,
  ChevronDown,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import { api } from '../../lib/api'
import { useDomainHttp } from '../../contexts/domain'

export type AccessLevel = 'anyone' | 'authenticated' | 'private'

const PUBLISH_DOMAIN = 'shogo.one'

const ACCESS_OPTIONS: { value: AccessLevel; label: string; Icon: any }[] = [
  { value: 'anyone', label: 'Anyone', Icon: Globe },
  { value: 'authenticated', label: 'Authenticated users', Icon: Users },
  { value: 'private', label: 'Private', Icon: Lock },
]

interface PublishDropdownProps {
  projectId: string
  projectName: string
}

export function PublishDropdown({ projectId, projectName }: PublishDropdownProps) {
  const http = useDomainHttp()
  const [isOpen, setIsOpen] = useState(false)
  const [subdomain, setSubdomain] = useState(
    () => projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  )
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('anyone')
  const [isPublished, setIsPublished] = useState(false)
  const [publishedAt, setPublishedAt] = useState<number | null>(null)
  const [publishedSubdomain, setPublishedSubdomain] = useState<string | null>(null)
  const [isPublishing, setIsPublishing] = useState(false)
  const [isUnpublishing, setIsUnpublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAccessPicker, setShowAccessPicker] = useState(false)

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
        if (data.accessLevel) setAccessLevel(data.accessLevel as AccessLevel)
      }
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
      const data = await api.publishProject(http, projectId, subdomain, accessLevel)
      setIsPublished(true)
      setPublishedSubdomain(data.subdomain)
      setPublishedAt(data.publishedAt)
    } catch (err: any) {
      setError(err.message || 'Failed to publish')
    } finally {
      setIsPublishing(false)
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
    } catch (err: any) {
      setError(err.message || 'Failed to unpublish')
    } finally {
      setIsUnpublishing(false)
    }
  }

  const handleViewPublished = () => {
    if (publishedSubdomain) {
      Linking.openURL(`https://${publishedSubdomain}.${PUBLISH_DOMAIN}`)
    }
  }

  const canPublish =
    subdomain.length >= 3 &&
    !subdomainStatus.checking &&
    (subdomainStatus.available === true || subdomain === publishedSubdomain) &&
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
            <View className="flex-row items-center gap-2 p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20 mb-4">
              <CheckCircle size={16} color="#10b981" />
              <Text className="text-sm text-emerald-600 dark:text-emerald-400">
                {publishedSubdomain}.{PUBLISH_DOMAIN}
              </Text>
            </View>
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
                    onPress={() => { setAccessLevel(value); setShowAccessPicker(false) }}
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
          </View>

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
                {subdomain !== publishedSubdomain && (
                  <Pressable
                    onPress={handlePublish}
                    disabled={!canPublish}
                    className={cn('flex-1 h-10 rounded-lg items-center justify-center', canPublish ? 'bg-primary' : 'bg-muted')}
                  >
                    <Text className={cn('text-sm font-medium', canPublish ? 'text-primary-foreground' : 'text-muted-foreground')}>
                      {isPublishing ? 'Updating...' : 'Update URL'}
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
              </>
            )}
          </View>
          </View>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}
