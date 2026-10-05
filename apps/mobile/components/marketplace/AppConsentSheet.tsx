// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What an app asks for before it is installed (its `shogo.app.json`): the
 * workspace access it needs, optional extras the user can opt into, the
 * connected apps it requires, and the events it listens to. Accepting
 * returns the consent the install endpoint expects.
 */

import { useEffect, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from 'react-native'
import { Check, X } from 'lucide-react-native'
import type { AppConsentRequest } from '../../lib/api'

export interface AppConsent {
  accept: true
  optionalScopes: string[]
}

function toolkitLabel(toolkit: string): string {
  return toolkit.charAt(0).toUpperCase() + toolkit.slice(1)
}

function eventLabel(event: { type: string; name?: string }): string {
  if (event.name) return event.name
  const composio = /^composio\.([^.]+)\.(.+)$/.exec(event.type)
  if (composio) return `${toolkitLabel(composio[1])}: ${composio[2].replace(/_/g, ' ').toLowerCase()}`
  return event.type
}

export function AppConsentSheet({
  visible,
  appName,
  request,
  installing,
  error,
  missingToolkits,
  onConnect,
  onAccept,
  onCancel,
}: {
  visible: boolean
  appName: string
  request: AppConsentRequest | null
  installing: boolean
  error?: string | null
  /** Required toolkits the workspace still has to connect (from a `needs_connection` reply). */
  missingToolkits?: string[]
  onConnect?: () => void
  onAccept: (consent: AppConsent) => void
  onCancel: () => void
}) {
  const [optional, setOptional] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (visible) setOptional(new Set())
  }, [visible, request?.version])

  if (!request) return null
  const toggle = (scope: string) => {
    setOptional((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      return next
    })
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View className="flex-1 bg-black/50 justify-end md:justify-center md:items-center">
        <View
          className="bg-background rounded-t-2xl md:rounded-2xl w-full md:max-w-lg max-h-[85%]"
          testID="app-consent-sheet"
        >
          <View className="flex-row items-center px-5 pt-5 pb-3">
            <View className="flex-1">
              <Text className="text-lg font-semibold text-foreground">Allow {appName}?</Text>
              <Text className="text-xs text-muted-foreground mt-0.5">Version {request.version}</Text>
            </View>
            <Pressable onPress={onCancel} accessibilityLabel="Cancel" className="p-2 rounded-full active:bg-muted">
              <X size={18} className="text-muted-foreground" />
            </Pressable>
          </View>

          <ScrollView className="px-5" contentContainerClassName="gap-5 pb-4">
            {request.scopes.length > 0 && (
              <View className="gap-2">
                <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">It will be able to</Text>
                {request.scopes.map((s) => (
                  <View key={s.scope} className="flex-row gap-2 items-start" testID={`consent-scope-${s.scope}`}>
                    <Check size={14} className="text-primary mt-0.5" />
                    <Text className="text-sm text-foreground flex-1">{s.description}</Text>
                  </View>
                ))}
              </View>
            )}

            {request.optionalScopes.length > 0 && (
              <View className="gap-2">
                <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Optional</Text>
                {request.optionalScopes.map((s) => {
                  const on = optional.has(s.scope)
                  return (
                    <Pressable
                      key={s.scope}
                      onPress={() => toggle(s.scope)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={s.description}
                      className="flex-row gap-2 items-start active:opacity-70"
                      testID={`consent-optional-${s.scope}`}
                    >
                      <View className={`w-4 h-4 mt-0.5 rounded border items-center justify-center ${on ? 'bg-primary border-primary' : 'border-border'}`}>
                        {on && <Check size={11} className="text-primary-foreground" />}
                      </View>
                      <Text className="text-sm text-foreground flex-1">{s.description}</Text>
                    </Pressable>
                  )
                })}
              </View>
            )}

            {request.requiredToolkits.length > 0 && (
              <View className="gap-1">
                <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Needs connected apps</Text>
                <Text className="text-sm text-foreground">{request.requiredToolkits.map(toolkitLabel).join(', ')}</Text>
                <Text className="text-xs text-muted-foreground">
                  It receives events from your connected accounts; it never sees your credentials.
                </Text>
              </View>
            )}

            {request.events.length > 0 && (
              <View className="gap-1">
                <Text className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Runs when</Text>
                {request.events.map((e) => (
                  <Text key={`${e.type}:${e.target}:${e.name ?? ''}`} className="text-sm text-foreground">
                    • {eventLabel(e)}
                  </Text>
                ))}
              </View>
            )}

            <Text className="text-xs text-muted-foreground">
              You can revoke its access any time in Settings → Automations.
            </Text>
          </ScrollView>

          {(!!error || !!missingToolkits?.length) && (
            <View className="mx-5 mb-2 p-3 rounded-lg bg-destructive/10 gap-2" testID="app-consent-error">
              <Text className="text-xs text-destructive">
                {missingToolkits?.length
                  ? `Connect ${missingToolkits.map(toolkitLabel).join(', ')} to this workspace first, then install again.`
                  : error}
              </Text>
              {missingToolkits?.length && onConnect ? (
                <Pressable onPress={onConnect} className="self-start px-3 py-1.5 rounded-md border border-destructive/40 active:bg-destructive/10">
                  <Text className="text-xs text-destructive">Open Integrations</Text>
                </Pressable>
              ) : null}
            </View>
          )}

          <View className="flex-row gap-3 px-5 pb-5 pt-2">
            <Pressable onPress={onCancel} className="flex-1 items-center py-3 rounded-lg border border-border active:bg-muted">
              <Text className="text-sm text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => onAccept({ accept: true, optionalScopes: [...optional] })}
              disabled={installing}
              className="flex-1 items-center py-3 rounded-lg bg-primary active:bg-primary/80"
              testID="app-consent-accept"
            >
              {installing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text className="text-sm font-medium text-primary-foreground">Allow and install</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}
