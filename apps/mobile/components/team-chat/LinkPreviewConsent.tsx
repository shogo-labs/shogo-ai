// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Share a preview of this link?" — the question Slack puts in front of you
 * when you share a link that points into a closed conversation.
 *
 * Saying no does not break the link: it stays exactly where it is, and opening
 * it still works for whoever has access. All that is withheld is the card.
 *
 * One AlertDialog on web; on native a system alert with the same copy. Same
 * host indirection as `AddToChannelConfirm`, so the composer can request it
 * without threading a ref through the tree.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Platform } from 'react-native'
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
} from '@/components/ui/alert-dialog'
import { Heading } from '@/components/ui/heading'
import { Text as UIText } from '@/components/ui/text'
import { Button, ButtonText } from '@/components/ui/button'

export const LINK_PREVIEW_CONSENT_TITLE = 'Share a preview of this link?'

/** Names the conversations the link points into, so the question is answerable. */
export function linkPreviewConsentBody(names: string[]): string {
  const list = names.filter(Boolean).map((n) => (n.startsWith('#') ? n : `#${n}`))
  if (!list.length) {
    return 'This link points into a private conversation. People here who are not in it will not be able to open it. Share a preview?'
  }
  if (list.length === 1) {
    return `This link points into ${list[0]}, which is private. People here who are not in ${list[0]} will not be able to open it. Share a preview?`
  }
  return `These links point into ${formatList(list)}, which are private. People here who are not in them will not be able to open the links. Share a preview?`
}

function formatList(shown: string[]): string {
  if (shown.length === 1) return shown[0]!
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]!}`
}

interface ConsentRequest {
  body: string
  resolve: (confirmed: boolean) => void
}

type Subscriber = (request: ConsentRequest | null) => void

let activeRequest: ConsentRequest | null = null
const subscribers = new Set<Subscriber>()

function pushRequest(request: ConsentRequest) {
  // A second ask collapses onto the latest one rather than stacking dialogs.
  if (activeRequest) activeRequest.resolve(false)
  activeRequest = request
  for (const sub of subscribers) sub(request)
}

function clearRequest() {
  activeRequest = null
  for (const sub of subscribers) sub(null)
}

export const __resetLinkPreviewConsentForTest = () => clearRequest()

/** Resolves true when the sender chose to share the preview. */
export function requestLinkPreviewConsent(names: string[]): Promise<boolean> {
  const body = linkPreviewConsentBody(names)
  if (Platform.OS !== 'web') {
    return new Promise((resolve) => {
      Alert.alert(
        LINK_PREVIEW_CONSENT_TITLE,
        body,
        [
          { text: "Don't preview", style: 'cancel', onPress: () => resolve(false) },
          { text: 'Share preview', onPress: () => resolve(true) },
        ],
        { onDismiss: () => resolve(false) },
      )
    })
  }
  return new Promise((resolve) => pushRequest({ body, resolve }))
}

/** Mount once in the chat tree. Renders nothing until a request comes in. */
export function LinkPreviewConsentHost() {
  const [request, setRequest] = useState<ConsentRequest | null>(null)

  useEffect(() => {
    subscribers.add(setRequest)
    return () => {
      subscribers.delete(setRequest)
    }
  }, [])

  const handleConfirm = useCallback(() => {
    if (!request) return
    request.resolve(true)
    clearRequest()
  }, [request])

  const handleCancel = useCallback(() => {
    if (!request) return
    request.resolve(false)
    clearRequest()
  }, [request])

  if (Platform.OS !== 'web') return null
  if (!request) return null

  return (
    <AlertDialog isOpen onClose={handleCancel} size="sm">
      <AlertDialogBackdrop />
      <AlertDialogContent testID="link-preview-consent">
        <AlertDialogHeader>
          <Heading size="md" className="text-typography-950">
            {LINK_PREVIEW_CONSENT_TITLE}
          </Heading>
        </AlertDialogHeader>
        <AlertDialogBody className="mb-4 mt-3">
          <UIText size="sm" className="text-typography-700">
            {request.body}
          </UIText>
        </AlertDialogBody>
        <AlertDialogFooter>
          <Button variant="outline" action="secondary" onPress={handleCancel} accessibilityLabel="Don't preview">
            <ButtonText>Don't preview</ButtonText>
          </Button>
          <Button action="primary" onPress={handleConfirm} accessibilityLabel="Share preview">
            <ButtonText>Share preview</ButtonText>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
