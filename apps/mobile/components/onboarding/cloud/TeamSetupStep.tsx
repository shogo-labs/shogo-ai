// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform, Pressable, Text, TextInput, View } from 'react-native'
import { X } from 'lucide-react-native'
import { Input } from '@shogo/shared-ui/primitives'
import { parseEmailDraft } from './email-draft'

interface TeamSetupStepProps {
  name: string
  onNameChange: (name: string) => void
  emails: string[]
  onEmailsChange: (emails: string[]) => void
  /** Text typed into the invite field but not yet turned into a chip. */
  draft: string
  onDraftChange: (draft: string) => void
  error?: string | null
  /** Invites that failed on the last save, shown under the invite field. */
  inviteError?: string | null
  /** Enter on an empty invite field advances the step. */
  onSubmit?: () => void
}

export function TeamSetupStep({
  name,
  onNameChange,
  emails,
  onEmailsChange,
  draft,
  onDraftChange,
  error,
  inviteError,
  onSubmit,
}: TeamSetupStepProps) {
  const { invalid: draftInvalid } = parseEmailDraft(draft)
  const hasSeparator = /[,;\s]/.test(draft)

  const commitDraft = (raw: string) => {
    const { valid, invalid } = parseEmailDraft(raw)
    const fresh = valid.filter((e) => !emails.includes(e))
    if (fresh.length) onEmailsChange([...emails, ...fresh])
    onDraftChange(invalid.length ? `${invalid.join(' ')} ` : '')
  }

  return (
    <View className="gap-7">
      <View className="gap-2">
        <Text className="text-sm font-medium text-foreground">Workspace name</Text>
        <Input
          value={name}
          onChangeText={onNameChange}
          placeholder="e.g. Acme, Growth team"
          className="h-12 rounded-xl px-4 text-base"
          autoFocus={Platform.OS === 'web'}
        />
        {error ? (
          <Text className="text-sm text-destructive">{error}</Text>
        ) : (
          <Text className="text-xs text-muted-foreground">You can rename it later in settings.</Text>
        )}
      </View>

      <View className="gap-2">
        <View className="flex-row items-baseline justify-between">
          <Text className="text-sm font-medium text-foreground">Invite teammates</Text>
          <Text className="text-xs text-muted-foreground">Optional</Text>
        </View>
        <View className="min-h-12 flex-row flex-wrap items-center gap-2 rounded-xl border border-input bg-background px-3 py-2">
          {emails.map((email) => (
            <View key={email} className="flex-row items-center gap-1 rounded-full bg-muted py-1 pl-3 pr-1.5">
              <Text className="text-sm text-foreground">{email}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${email}`}
                onPress={() => onEmailsChange(emails.filter((e) => e !== email))}
                className="h-5 w-5 items-center justify-center rounded-full web:hover:bg-background"
              >
                <X size={12} className="text-muted-foreground" />
              </Pressable>
            </View>
          ))}
          <TextInput
            value={draft}
            onChangeText={(text) => {
              if (/[,;\s]$/.test(text) && parseEmailDraft(text).valid.length) commitDraft(text)
              else onDraftChange(text)
            }}
            onSubmitEditing={() => {
              if (draft.trim()) commitDraft(draft)
              else onSubmit?.()
            }}
            onKeyPress={(e) => {
              if (e.nativeEvent.key === 'Backspace' && !draft && emails.length) {
                onEmailsChange(emails.slice(0, -1))
              }
            }}
            blurOnSubmit={false}
            placeholder={emails.length ? '' : 'name@company.com, separated by commas'}
            placeholderTextColor="#71717a"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            accessibilityLabel="Teammate email addresses"
            className="min-w-[160px] flex-1 py-1 text-base text-foreground web:outline-none"
          />
        </View>
        {draftInvalid.length > 0 && hasSeparator ? (
          <Text className="text-sm text-destructive">
            {draftInvalid.length === 1
              ? `"${draftInvalid[0]}" doesn't look like an email address.`
              : `These don't look like email addresses: ${draftInvalid.map((t) => `"${t}"`).join(', ')}.`}{' '}
            Fix or remove {draftInvalid.length === 1 ? 'it' : 'them'} to continue.
          </Text>
        ) : draftInvalid.length > 0 ? (
          <Text className="text-xs text-muted-foreground">
            Finish typing the address, or clear it to continue.
          </Text>
        ) : inviteError ? (
          <Text className="text-sm text-destructive">{inviteError}</Text>
        ) : (
          <Text className="text-xs text-muted-foreground">
            They'll get an email invite to join as editors.
          </Text>
        )}
      </View>
    </View>
  )
}
