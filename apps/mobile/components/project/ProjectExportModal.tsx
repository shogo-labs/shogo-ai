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
import { Button, ButtonText, ButtonSpinner, ButtonIcon } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Download, X, MessageSquare, Rocket } from 'lucide-react-native'

interface ProjectExportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isExporting: boolean
  onExport: (options: { includeChats: boolean }) => void
}

export function ProjectExportModal({
  open,
  onOpenChange,
  isExporting,
  onExport,
}: ProjectExportModalProps) {
  const [includeChats, setIncludeChats] = useState(true)

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
          <Button
            onPress={() => onExport({ includeChats })}
            disabled={isExporting}
          >
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
