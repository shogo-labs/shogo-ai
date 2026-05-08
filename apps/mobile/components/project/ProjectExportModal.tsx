// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectExportModal
 *
 * Small modal shown before an export starts. Lets the user choose whether to
 * include chat history in the exported `.shogo-project` bundle. A separate
 * toggle for the built-app `dist/` is intentionally not offered — the server
 * always ships `dist/` when present so imports start up fast.
 */
import React, { useMemo, useState } from 'react'
import { View } from 'react-native'
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal'
import { Heading } from '@/components/ui/heading'
import { Text } from '@/components/ui/text'
import { Button, ButtonText, ButtonSpinner, ButtonIcon } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input, InputField } from '@/components/ui/input'
import {
  Download,
  X,
  MessageSquare,
  Rocket,
  Lock,
  FileKey,
  AlertTriangle,
} from 'lucide-react-native'

export interface ExportOptions {
  includeChats: boolean
  /** Non-empty passphrase ⇒ ship encrypted credentials in the bundle. */
  passphrase?: string
  /** True ships `.env` files verbatim; false (default) redacts secrets. */
  includeEnv?: boolean
}

interface ProjectExportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isExporting: boolean
  onExport: (options: ExportOptions) => void
}

export function ProjectExportModal({
  open,
  onOpenChange,
  isExporting,
  onExport,
}: ProjectExportModalProps) {
  const [includeChats, setIncludeChats] = useState(true)
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [includeEnv, setIncludeEnv] = useState(false)

  const passphraseError = useMemo(() => {
    if (!includeSecrets) return null
    if (passphrase.length === 0) return null
    if (passphrase.length < 8) return 'Use at least 8 characters.'
    if (confirmPassphrase.length > 0 && confirmPassphrase !== passphrase) {
      return 'Passphrases do not match.'
    }
    return null
  }, [includeSecrets, passphrase, confirmPassphrase])

  const canExport =
    !isExporting &&
    (!includeSecrets ||
      (passphrase.length >= 8 && passphrase === confirmPassphrase))

  const handleExport = () => {
    onExport({
      includeChats,
      passphrase: includeSecrets ? passphrase : undefined,
      includeEnv,
    })
  }

  return (
    <Modal isOpen={open} onClose={() => onOpenChange(false)} size="md">
      <ModalBackdrop />
      <ModalContent className="bg-background-0 p-0">
        <ModalHeader className="px-6 pt-6 pb-4 border-b border-outline-100">
          <Heading size="lg" className="text-typography-900">
            Export project
          </Heading>
          <ModalCloseButton>
            <X size={20} className="text-typography-500" />
          </ModalCloseButton>
        </ModalHeader>

        <ModalBody className="px-6 py-5" contentContainerClassName="gap-4">
          <Text className="text-sm text-typography-600 leading-relaxed">
            Download this project as a <Text className="font-mono text-xs">.shogo-project</Text> archive.
            You can re-import it into any workspace.
          </Text>

          {/* Chat history toggle */}
          <View className="flex-row items-start gap-3 rounded-lg border border-outline-100 bg-background-50 px-4 py-3">
            <View className="mt-0.5">
              <MessageSquare size={18} className="text-typography-500" />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-medium text-typography-900">
                Include chat history
              </Text>
              <Text className="text-xs text-typography-500 mt-0.5 leading-relaxed">
                All conversations with the technical agent are bundled with the project.
              </Text>
            </View>
            <Switch
              value={includeChats}
              onValueChange={setIncludeChats}
              disabled={isExporting}
            />
          </View>

          {/* Encrypted-secrets opt-in */}
          <View className="rounded-lg border border-outline-100 bg-background-50 px-4 py-3 gap-3">
            <View className="flex-row items-start gap-3">
              <View className="mt-0.5">
                <Lock size={18} className="text-typography-500" />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-typography-900">
                  Include encrypted credentials
                </Text>
                <Text className="text-xs text-typography-500 mt-0.5 leading-relaxed">
                  Bot tokens, API keys, and secret env values travel inside the bundle, encrypted with your passphrase. Recipients enter the same passphrase to auto-fill them.
                </Text>
              </View>
              <Switch
                value={includeSecrets}
                onValueChange={setIncludeSecrets}
                disabled={isExporting}
              />
            </View>
            {includeSecrets && (
              <View className="gap-2 pl-7">
                <Input>
                  <InputField
                    placeholder="Passphrase (≥ 8 chars)"
                    value={passphrase}
                    onChangeText={setPassphrase}
                    secureTextEntry
                    autoComplete="off"
                    autoCorrect={false}
                    editable={!isExporting}
                  />
                </Input>
                <Input>
                  <InputField
                    placeholder="Confirm passphrase"
                    value={confirmPassphrase}
                    onChangeText={setConfirmPassphrase}
                    secureTextEntry
                    autoComplete="off"
                    autoCorrect={false}
                    editable={!isExporting}
                  />
                </Input>
                {passphraseError && (
                  <View className="flex-row items-center gap-1.5">
                    <AlertTriangle size={12} className="text-amber-500" />
                    <Text className="text-[11px] text-amber-600">
                      {passphraseError}
                    </Text>
                  </View>
                )}
                <Text className="text-[11px] text-typography-500 leading-relaxed">
                  Share this passphrase with the recipient through a separate channel — never paste it inside the bundle file.
                </Text>
              </View>
            )}
          </View>

          {/* .env policy */}
          <View className="flex-row items-start gap-3 rounded-lg border border-outline-100 bg-background-50 px-4 py-3">
            <View className="mt-0.5">
              <FileKey size={18} className="text-typography-500" />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-medium text-typography-900">
                Ship raw <Text className="font-mono text-xs">.env</Text> values
              </Text>
              <Text className="text-xs text-typography-500 mt-0.5 leading-relaxed">
                Off (recommended): secret-looking env vars are redacted; non-secrets and a <Text className="font-mono text-xs">.env.example</Text> are shipped. On: ships <Text className="font-mono text-xs">.env</Text> files verbatim — only do this for trusted recipients.
              </Text>
            </View>
            <Switch
              value={includeEnv}
              onValueChange={setIncludeEnv}
              disabled={isExporting}
            />
          </View>

          <View className="flex-row items-start gap-3 rounded-lg border border-outline-100 bg-background-50 px-4 py-3">
            <View className="mt-0.5">
              <Rocket size={18} className="text-typography-500" />
            </View>
            <View className="flex-1">
              <Text className="text-sm font-medium text-typography-900">
                Prebuilt app included automatically
              </Text>
              <Text className="text-xs text-typography-500 mt-0.5 leading-relaxed">
                When a built <Text className="font-mono text-xs">dist/</Text> exists, it's shipped so the imported project's preview starts immediately.
              </Text>
            </View>
          </View>
        </ModalBody>

        <ModalFooter className="px-6 py-4 border-t border-outline-100 gap-2">
          <Button
            variant="outline"
            onPress={() => onOpenChange(false)}
            disabled={isExporting}
          >
            <ButtonText>Cancel</ButtonText>
          </Button>
          <Button onPress={handleExport} disabled={!canExport}>
            {isExporting ? (
              <ButtonSpinner className="text-typography-0" />
            ) : (
              <ButtonIcon as={Download} className="text-typography-0" />
            )}
            <ButtonText>{isExporting ? 'Exporting...' : 'Export'}</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
