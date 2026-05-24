// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * TrustPrompt
 *
 * VS Code-style Workspace Trust modal. Shown when the user opens an
 * external (folder-linked) project whose `trustLevel === 'restricted'`.
 *
 * Three options, matching VS Code's "Do you trust the authors..." prompt:
 *   1. **Trust folder.** Flip `trustLevel='trusted'`. Write + exec tools
 *      become available immediately (the agent-runtime reads trust on
 *      every chat turn).
 *   2. **Trust parent…**  Trust the enclosing directory so future
 *      subfolders auto-trust. Implementation note: in v1 we treat this
 *      as a normal Trust (we don't yet persist parent-allowlist rules),
 *      but the affordance is here so users see the same surface they
 *      know from VS Code; the persistence layer is a follow-up.
 *   3. **Browse in restricted mode.** Keep `trustLevel='restricted'`.
 *      Read tools, plan / chat work; edits and shell are blocked. The
 *      `assertAllowedPath()` enforcement in agent-runtime is what makes
 *      this safe — the modal is purely educational.
 *
 * Wire-up:
 *   - Mount in the project view (e.g. apps/mobile/app/(app)/projects/[id].tsx).
 *   - Pass `open={project.trustLevel === 'restricted'}` and an
 *     `onDecision` handler that POSTs to /api/local/projects/:id/trust
 *     then refetches the project.
 */
import React, { useState } from 'react'
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
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button'
import { ShieldCheck, ShieldAlert, FolderTree, X } from 'lucide-react-native'

export type TrustDecision = 'trust' | 'trust-parent' | 'restricted'

export interface TrustPromptProps {
  open: boolean
  /** Primary folder path (shown in the body so the user sees what they're trusting). */
  folderPath?: string
  /** Project name, displayed in the heading. */
  projectName?: string
  /** Submitting state (parent owns the API call). */
  isSubmitting?: boolean
  /** Called with the user's choice. Parent persists it to /api/local/projects/:id/trust. */
  onDecision: (decision: TrustDecision) => void
  /** Called when the user dismisses the modal without choosing. Treat as "browse restricted". */
  onClose: () => void
}

export function TrustPrompt({
  open,
  folderPath,
  projectName,
  isSubmitting,
  onDecision,
  onClose,
}: TrustPromptProps) {
  const [pending, setPending] = useState<TrustDecision | null>(null)

  const handle = (decision: TrustDecision) => {
    if (isSubmitting) return
    setPending(decision)
    onDecision(decision)
  }

  return (
    <Modal isOpen={open} onClose={onClose} size="md">
      <ModalBackdrop />
      <ModalContent className="bg-background-0 p-0">
        <ModalHeader className="px-6 pt-6 pb-4 border-b border-outline-100">
          <View className="flex-row items-start gap-3 flex-1">
            <View className="mt-0.5">
              <ShieldAlert size={22} className="text-amber-500" />
            </View>
            <View className="flex-1">
              <Heading size="md" className="text-typography-900">
                Do you trust this folder?
              </Heading>
              {projectName ? (
                <Text className="text-xs text-typography-600 mt-1">
                  Project: {projectName}
                </Text>
              ) : null}
            </View>
          </View>
          <ModalCloseButton>
            <X size={20} className="text-typography-700" />
          </ModalCloseButton>
        </ModalHeader>

        <ModalBody className="px-6 py-5" contentContainerClassName="gap-4">
          <Text className="text-sm text-typography-800 leading-relaxed">
            Shogo's agent can read, write, and run shell commands inside the
            folder you opened. Trust this folder only if you wrote its code or
            cloned it from a source you trust.
          </Text>

          {folderPath ? (
            <View className="rounded-lg bg-background-50 px-3 py-2 border border-outline-100 flex-row items-center gap-2">
              <FolderTree size={14} className="text-typography-700" />
              <Text
                className="text-xs font-mono text-typography-900 flex-1"
                numberOfLines={1}
              >
                {folderPath}
              </Text>
            </View>
          ) : null}

          {/* Restricted mode behaviour explainer */}
          <View className="rounded-lg border border-outline-100 bg-background-50 px-4 py-3 gap-1.5">
            <Text className="text-sm font-medium text-typography-900">
              Restricted mode (default)
            </Text>
            <Text className="text-xs text-typography-700 leading-relaxed">
              The agent can read files and answer questions, but{' '}
              <Text className="font-semibold text-typography-900">
                write_file, edit_file, and shell commands are blocked
              </Text>
              . You can flip this any time from project settings.
            </Text>
          </View>
        </ModalBody>

        <ModalFooter className="px-6 py-4 border-t border-outline-100 flex-col gap-2">
          <Button
            className="w-full bg-primary-600"
            onPress={() => handle('trust')}
            isDisabled={isSubmitting}
          >
            {isSubmitting && pending === 'trust' ? (
              <ButtonSpinner />
            ) : (
              <View className="flex-row items-center gap-2">
                <ShieldCheck size={16} className="text-white" />
                <ButtonText className="text-white">Trust folder</ButtonText>
              </View>
            )}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onPress={() => handle('trust-parent')}
            isDisabled={isSubmitting}
          >
            {isSubmitting && pending === 'trust-parent' ? (
              <ButtonSpinner />
            ) : (
              <ButtonText>Trust parent folder…</ButtonText>
            )}
          </Button>
          <Button
            variant="link"
            className="w-full"
            onPress={() => handle('restricted')}
            isDisabled={isSubmitting}
          >
            <ButtonText className="text-typography-700">
              Browse in restricted mode
            </ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}
