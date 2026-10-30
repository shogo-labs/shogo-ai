// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Are you sure you want to add them?" — the confirmation Slack puts in front
 * of adding somebody to a private channel, because the new member gains the
 * whole history, files included, and that is not obvious from an "Add them"
 * button.
 *
 * One AlertDialog on web; on native (where this UI is currently web-first) we
 * fall back to `Alert.alert` with the same copy, so the action still has
 * friction without a custom modal. Same host indirection as
 * `EditConfirmDialog`: `requestAddToChannelConfirm()` can be called from any
 * nested row without a ref to the host.
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

export const ADD_TO_CHANNEL_TITLE = 'Are you sure you want to add them?'
export const ADD_TO_CHANNEL_BODY =
  "New members will be able to see all of the channel's history, including any files that have been shared in the channel."

interface AddToChannelRequest {
  resolve: (confirmed: boolean) => void
}

type Subscriber = (request: AddToChannelRequest | null) => void

let activeRequest: AddToChannelRequest | null = null
const subscribers = new Set<Subscriber>()

function pushRequest(request: AddToChannelRequest) {
  // A second ask collapses onto the latest one rather than stacking dialogs.
  if (activeRequest) activeRequest.resolve(false)
  activeRequest = request
  for (const sub of subscribers) sub(request)
}

function clearRequest() {
  activeRequest = null
  for (const sub of subscribers) sub(null)
}

export const __resetAddToChannelConfirmForTest = () => clearRequest()

/**
 * Resolves true when the reader confirmed. On native this is a system alert;
 * on web it's the AlertDialog hosted by `AddToChannelConfirmHost`.
 */
export function requestAddToChannelConfirm(): Promise<boolean> {
  if (Platform.OS !== 'web') {
    return new Promise((resolve) => {
      Alert.alert(
        ADD_TO_CHANNEL_TITLE,
        ADD_TO_CHANNEL_BODY,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Add', onPress: () => resolve(true) },
        ],
        { onDismiss: () => resolve(false) },
      )
    })
  }
  return new Promise((resolve) => pushRequest({ resolve }))
}

/**
 * Whether to ask before adding. Only a private channel needs it: its history —
 * files included — is what the new member gains, which is not obvious from an
 * "Add them" button. A public channel's history is already public, so Slack
 * adds without a prompt and so do we.
 */
export async function confirmsAddToChannel(kind: string, ask: () => Promise<boolean> = requestAddToChannelConfirm): Promise<boolean> {
  if (kind !== 'private') return true
  return ask()
}

/** Mount once in the chat tree. Renders nothing until a request comes in. */
export function AddToChannelConfirmHost() {
  const [request, setRequest] = useState<AddToChannelRequest | null>(null)

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
    // `useRNModal`: this is asked from inside other react-native `Modal`s (the
    // Members dialog). On web those portal to document.body, above anything in
    // the app tree, so the default in-tree overlay renders *behind* them and the
    // Add/Cancel buttons are unreachable. A Modal opened later stacks on top.
    <AlertDialog isOpen onClose={handleCancel} size="sm" useRNModal>
      <AlertDialogBackdrop />
      <AlertDialogContent testID="add-to-channel-confirm">
        <AlertDialogHeader>
          <Heading size="md" className="text-typography-950">
            {ADD_TO_CHANNEL_TITLE}
          </Heading>
        </AlertDialogHeader>
        <AlertDialogBody className="mb-4 mt-3">
          <UIText size="sm" className="text-typography-700">
            {ADD_TO_CHANNEL_BODY}
          </UIText>
        </AlertDialogBody>
        <AlertDialogFooter>
          <Button variant="outline" action="secondary" onPress={handleCancel} accessibilityLabel="Cancel">
            <ButtonText>Cancel</ButtonText>
          </Button>
          <Button action="primary" onPress={handleConfirm} accessibilityLabel="Add">
            <ButtonText>Add</ButtonText>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
