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
import { View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { FileViewer } from '../../../components/team-chat/FileViewer'
import { PhoneScreenHeader, usePhoneScreenHeaderInset } from '../../../components/layout/PhoneScreenHeader'

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export default function FileViewerScreen() {
  const params = useLocalSearchParams<{ attachmentId: string; name?: string }>()
  const router = useRouter()
  const attachmentId = first(params.attachmentId) ?? ''
  const name = first(params.name) ?? 'File'
  const header = usePhoneScreenHeaderInset()

  const back = () => {
    if (router.canGoBack()) router.back()
    else router.replace('/(app)/home' as never)
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['bottom']}>
      <View className="flex-1">
        <PhoneScreenHeader title={name} onBack={back} backTestID="file-viewer-back" onLayout={header.onLayout} />
        <View className="min-h-0 flex-1" style={{ paddingTop: header.height }}>
          <FileViewer attachmentId={attachmentId} fallbackName={name} />
        </View>
      </View>
    </SafeAreaView>
  )
}
