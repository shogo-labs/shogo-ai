// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Notify everyone in #eng?" — the confirmation Slack puts in front of
 * `@channel` / `@here`, because the token looks like any other mention and its
 * reach is invisible until the message is already out.
 *
 * One AlertDialog on web; on native we fall back to `Alert.alert` with the same
 * copy, so the action still has friction without a custom modal. Same host
 * indirection as `AddToChannelConfirm`: `requestChannelBroadcastConfirm()` can
 * be called from the composer without a ref to the host.
 *
 * The copy is passed in rather than fixed here, because it names the channel
 * and differs between `@channel` and `@here`.
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
import type { BroadcastCopy } from '../../lib/channel-broadcast-consent'

export const BROADCAST_CONFIRM_ACTION = 'Send'

interface BroadcastRequest {
  copy: BroadcastCopy
  resolve: (confirmed: boolean) => void
}

type Subscriber = (request: BroadcastRequest | null) => void

let activeRequest: BroadcastRequest | null = null
const subscribers = new Set<Subscriber>()

function pushRequest(request: BroadcastRequest) {
  // A second ask collapses onto the latest one rather than stacking dialogs.
  if (activeRequest) activeRequest.resolve(false)
  activeRequest = request
  for (const sub of subscribers) sub(request)
}

function clearRequest() {
  activeRequest = null
  for (const sub of subscribers) sub(null)
}

export const __resetChannelBroadcastConfirmForTest = () => clearRequest()

/**
 * Resolves true when the reader chose to send. On native this is a system
 * alert; on web it's the AlertDialog hosted by `ChannelBroadcastConfirmHost`.
 */
export function requestChannelBroadcastConfirm(copy: BroadcastCopy): Promise<boolean> {
  if (Platform.OS !== 'web') {
    return new Promise((resolve) => {
      Alert.alert(
        copy.title,
        copy.body,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: BROADCAST_CONFIRM_ACTION, onPress: () => resolve(true) },
        ],
        { onDismiss: () => resolve(false) },
      )
    })
  }
  return new Promise((resolve) => pushRequest({ copy, resolve }))
}

/** Mount once in the chat tree. Renders nothing until a request comes in. */
export function ChannelBroadcastConfirmHost() {
  const [request, setRequest] = useState<BroadcastRequest | null>(null)

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
      <AlertDialogContent testID="channel-broadcast-confirm">
        <AlertDialogHeader>
          <Heading size="md" className="text-typography-950">
            {request.copy.title}
          </Heading>
        </AlertDialogHeader>
        <AlertDialogBody className="mb-4 mt-3">
          <UIText size="sm" className="text-typography-700">
            {request.copy.body}
          </UIText>
        </AlertDialogBody>
        <AlertDialogFooter>
          <Button variant="outline" action="secondary" onPress={handleCancel} accessibilityLabel="Cancel">
            <ButtonText>Cancel</ButtonText>
          </Button>
          <Button action="primary" onPress={handleConfirm} accessibilityLabel={BROADCAST_CONFIRM_ACTION}>
            <ButtonText>{BROADCAST_CONFIRM_ACTION}</ButtonText>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
