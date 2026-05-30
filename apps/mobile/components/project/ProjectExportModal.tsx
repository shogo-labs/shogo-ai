// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectExportModal
 *
 * Options modal shown before an export starts:
 *   - include chat history (default on)
 *   - password-protect the archive (default off). When on, the entire `.shogo`
 *     archive is encrypted (ZipCrypto) and the project's secrets travel in
 *     place; when off, secret-looking values are redacted and the recipient
 *     re-enters them after import.
 *
 * A built-app `dist/` is always shipped when present so imports start fast.
 */
import React, { useMemo, useState } from 'react'
import { View } from 'react-native'
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalBody,
  ModalFooter,
} from '@/components/ui/modal'
import { Text } from '@/components/ui/text'
import { Button, ButtonText, ButtonSpinner, ButtonIcon } from '@/components/ui/button'
import { Input, InputField } from '@/components/ui/input'
import {
  TransferModalHeader,
  OptionGroup,
  ToggleRow,
  InfoNote,
} from './transfer-modal-parts'
import {
  Download,
  MessageSquare,
  Lock,
  AlertTriangle,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react-native'

const MIN_PASSWORD_LENGTH = 6

export interface ExportOptions {
  includeChats: boolean
  /** Non-empty ⇒ ZipCrypto-encrypt the archive with this password. */
  password?: string
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
  const [passwordProtect, setPasswordProtect] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const passwordError = useMemo(() => {
    if (!passwordProtect) return null
    if (password.length === 0) return null
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
    }
    if (confirmPassword.length > 0 && confirmPassword !== password) {
      return 'Passwords do not match.'
    }
    return null
  }, [passwordProtect, password, confirmPassword])

  const canExport =
    !isExporting &&
    (!passwordProtect ||
      (password.length >= MIN_PASSWORD_LENGTH && password === confirmPassword))

  const handleExport = () => {
    onExport({
      includeChats,
      password: passwordProtect ? password : undefined,
    })
  }

  return (
    <Modal isOpen={open} onClose={() => onOpenChange(false)} size="md">
      <ModalBackdrop />
      <ModalContent className="bg-background-0 p-0">
        <TransferModalHeader icon={Download} title="Export project" />

        <ModalBody className="px-6 py-5" contentContainerClassName="gap-4">
          <Text className="text-sm text-typography-600 leading-relaxed">
            Download this project as a <Text className="font-mono text-xs">.shogo</Text> archive.
            You can re-import it into any workspace.
          </Text>

          <OptionGroup>
            <ToggleRow
              icon={MessageSquare}
              title="Include chat history"
              description="Bundle all conversations with the technical agent."
              value={includeChats}
              onValueChange={setIncludeChats}
              disabled={isExporting}
            />
          </OptionGroup>

          <OptionGroup>
            <ToggleRow
              icon={Lock}
              title="Password-protect this export"
              description="Encrypt the archive so it can only be opened with a password."
              value={passwordProtect}
              onValueChange={setPasswordProtect}
              disabled={isExporting}
            />
            {passwordProtect && (
              <View className="px-4 py-3.5 gap-2">
                <Input>
                  <InputField
                    placeholder={`Password (\u2265 ${MIN_PASSWORD_LENGTH} chars)`}
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoComplete="off"
                    autoCorrect={false}
                    editable={!isExporting}
                  />
                </Input>
                <Input>
                  <InputField
                    placeholder="Confirm password"
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    secureTextEntry
                    autoComplete="off"
                    autoCorrect={false}
                    editable={!isExporting}
                  />
                </Input>
                {passwordError && (
                  <View className="flex-row items-center gap-1.5">
                    <AlertTriangle size={12} className="text-amber-500" />
                    <Text className="text-[11px] text-amber-600">{passwordError}</Text>
                  </View>
                )}
                <Text className="text-[11px] text-typography-500 leading-relaxed">
                  Share this password through a separate channel — never alongside the file.
                </Text>
              </View>
            )}
          </OptionGroup>

          {passwordProtect ? (
            <InfoNote icon={ShieldCheck}>
              Your secrets (API keys, tokens, and <Text className="font-mono text-[11px]">.env</Text> values) are
              included inside the encrypted archive, so the import is ready to run.
            </InfoNote>
          ) : (
            <InfoNote icon={ShieldOff}>
              Secrets are removed from the bundle. The recipient re-enters API keys and tokens after importing.
            </InfoNote>
          )}
        </ModalBody>

        <ModalFooter className="px-6 py-4 border-t border-outline-100 gap-2">
          <Button variant="outline" onPress={() => onOpenChange(false)} disabled={isExporting}>
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
