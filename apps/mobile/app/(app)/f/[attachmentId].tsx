// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `/f/<attachmentId>` — a shared file, open in the app.
 *
 * Every in-app entry point for a file lands here: the attachment card in a
 * message, a row in a channel's Files pane, and a pasted attachment link. The
 * route exists so those taps have somewhere inside the app to go, instead of a
 * browser tab and a storage URL.
 */
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { FileViewer } from '../../../components/team-chat/FileViewer'

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default function FileViewerScreen() {
  const params = useLocalSearchParams<{ attachmentId: string; name?: string }>()
  const router = useRouter()
  const attachmentId = first(params.attachmentId) ?? ''
  const name = first(params.name) ?? 'File'

  const back = () => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)/home' as never)
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
        <Pressable
          onPress={back}
          accessibilityRole="button"
          accessibilityLabel="Back"
          className="flex-row items-center rounded-md p-1 active:bg-muted"
          testID="file-viewer-back"
        >
          <ChevronLeft size={18} className="text-primary" />
          <Text className="text-sm font-medium text-primary">Back</Text>
        </Pressable>
        <Text className="min-w-0 flex-1 text-sm font-semibold text-foreground" numberOfLines={1}>
          {name}
        </Text>
      </View>
      <FileViewer attachmentId={attachmentId} fallbackName={name} />
    </SafeAreaView>
  )
}
