// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QR / PIN Pairing Screen
 *
 * Supports two pairing modes:
 * 1. QR Code scanning (when expo-camera is available)
 * 2. Manual 6-digit PIN entry (always available as fallback)
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import {
  ArrowLeft,
  Link2,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  Camera,
  Keyboard,
} from 'lucide-react-native'
import { useAuth } from '../../../contexts/auth'
import { API_URL } from '../../../lib/api'

type PairState = 'idle' | 'pairing' | 'success' | 'error'
type InputMode = 'qr' | 'pin'

let CameraView: any = null
let useCameraPermissions: any = null
try {
  const mod = require('expo-camera')
  CameraView = mod.CameraView
  useCameraPermissions = mod.useCameraPermissions
} catch {
  // expo-camera not installed — QR mode unavailable
}

const HAS_CAMERA = !!CameraView

export default function PairScreen() {
  const router = useRouter()
  const { session } = useAuth()
  const [code, setCode] = useState('')
  const [state, setState] = useState<PairState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ apiKey: string; workspaceId: string } | null>(null)
  const [inputMode, setInputMode] = useState<InputMode>(HAS_CAMERA ? 'qr' : 'pin')
  const [cameraPermission, requestCameraPermission] = HAS_CAMERA
    ? useCameraPermissions()
    : [null, () => Promise.resolve(null)]
  const scannedRef = useRef(false)

  const headers = useCallback(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (Platform.OS !== 'web' && session?.token) {
      h.Cookie = `better-auth.session_token=${session.token}`
    }
    return h
  }, [session?.token])

  useEffect(() => {
    if (inputMode === 'qr' && HAS_CAMERA && !cameraPermission?.granted) {
      requestCameraPermission()
    }
  }, [inputMode])

  const completePairing = useCallback(async (pairingCode: string) => {
    const trimmed = pairingCode.replace(/\s/g, '')
    if (trimmed.length !== 6) {
      setError('Enter a 6-digit code')
      return
    }

    setState('pairing')
    setError(null)

    try {
      // Generate an ECDH key pair for future E2E encryption
      let mobilePublicKey: string | undefined
      try {
        const keyPair = await crypto.subtle.generateKey(
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveBits'],
        )
        const exported = await crypto.subtle.exportKey('raw', keyPair.publicKey)
        mobilePublicKey = btoa(String.fromCharCode(...new Uint8Array(exported)))
      } catch {
        // WebCrypto not available (some RN environments) — proceed without E2E
      }

      const res = await fetch(`${API_URL}/api/pairing/complete`, {
        method: 'POST',
        credentials: 'include',
        headers: headers(),
        body: JSON.stringify({
          code: trimmed,
          publicKey: mobilePublicKey,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error?.message || 'Pairing failed')
        setState('error')
        scannedRef.current = false
        return
      }

      // data.peerPublicKey contains the desktop's public key (if provided)
      // Future: derive shared secret and store for E2E tunnel encryption
      setResult({ apiKey: data.apiKey, workspaceId: data.workspaceId })
      setState('success')
    } catch {
      setError('Network error — check your connection')
      setState('error')
      scannedRef.current = false
    }
  }, [headers])

  const handlePinSubmit = useCallback(() => completePairing(code), [code, completePairing])

  const handleBarCodeScanned = useCallback(({ data }: { data: string }) => {
    if (scannedRef.current || state === 'pairing') return
    scannedRef.current = true

    // QR codes can be raw 6-digit codes or shogo://pair?code=123456 URLs
    let extractedCode = data
    try {
      const url = new URL(data)
      const codeParam = url.searchParams.get('code')
      if (codeParam) extractedCode = codeParam
    } catch {
      // Not a URL — treat as raw code
    }

    const digits = extractedCode.replace(/\D/g, '').slice(0, 6)
    if (digits.length === 6) {
      setCode(digits)
      completePairing(digits)
    } else {
      setError('Invalid QR code — expected a 6-digit pairing code')
      scannedRef.current = false
    }
  }, [state, completePairing])

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-background"
    >
      {/* Header */}
      <View className="px-4 pt-4 pb-3 border-b border-border">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-3">
            <Pressable onPress={() => router.back()} className="p-1 rounded-md active:bg-muted">
              <ArrowLeft size={20} className="text-foreground" />
            </Pressable>
            <Text className="text-lg font-bold text-foreground">Pair Device</Text>
          </View>
          {HAS_CAMERA && state !== 'success' && (
            <Pressable
              onPress={() => {
                setInputMode(inputMode === 'qr' ? 'pin' : 'qr')
                setError(null)
                scannedRef.current = false
              }}
              className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-md bg-muted active:bg-muted/80"
            >
              {inputMode === 'qr' ? (
                <>
                  <Keyboard size={14} className="text-muted-foreground" />
                  <Text className="text-xs text-muted-foreground">Enter PIN</Text>
                </>
              ) : (
                <>
                  <Camera size={14} className="text-muted-foreground" />
                  <Text className="text-xs text-muted-foreground">Scan QR</Text>
                </>
              )}
            </Pressable>
          )}
        </View>
      </View>

      <View className="flex-1 justify-center px-6">
        {/* Success State */}
        {state === 'success' ? (
          <View className="items-center">
            <View className="w-16 h-16 rounded-full bg-green-500/10 items-center justify-center mb-4">
              <CheckCircle2 size={32} className="text-green-500" />
            </View>
            <Text className="text-xl font-bold text-foreground mb-2">Paired Successfully!</Text>
            <Text className="text-sm text-muted-foreground text-center mb-6">
              Your device is now connected to the workspace. You can control your desktop remotely.
            </Text>
            <Pressable
              onPress={() => router.replace('/(app)/remote-control')}
              className="px-6 py-3 rounded-lg bg-primary active:opacity-80"
            >
              <Text className="text-sm font-medium text-primary-foreground">Go to Remote Control</Text>
            </Pressable>
          </View>
        ) : inputMode === 'qr' && HAS_CAMERA ? (
          /* QR Scanner */
          <View className="items-center">
            <Text className="text-lg font-bold text-foreground mb-2">Scan QR Code</Text>
            <Text className="text-sm text-muted-foreground text-center mb-6">
              Point your camera at the QR code shown on your desktop Shogo app.
            </Text>

            {cameraPermission?.granted ? (
              <View className="w-full aspect-square max-w-[300px] rounded-2xl overflow-hidden border-2 border-primary/30 mb-4">
                <CameraView
                  style={{ flex: 1 }}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={state === 'pairing' ? undefined : handleBarCodeScanned}
                />
              </View>
            ) : (
              <View className="w-full aspect-square max-w-[300px] rounded-2xl bg-muted items-center justify-center mb-4">
                <Camera size={48} className="text-muted-foreground/40 mb-3" />
                <Text className="text-sm text-muted-foreground mb-3">Camera permission needed</Text>
                <Pressable
                  onPress={requestCameraPermission}
                  className="px-4 py-2 rounded-lg bg-primary active:opacity-80"
                >
                  <Text className="text-sm font-medium text-primary-foreground">Grant Access</Text>
                </Pressable>
              </View>
            )}

            {state === 'pairing' && (
              <View className="flex-row items-center gap-2 mt-2">
                <ActivityIndicator size="small" />
                <Text className="text-sm text-muted-foreground">Pairing...</Text>
              </View>
            )}

            {error && (
              <View className="flex-row items-center gap-2 p-3 rounded-lg bg-destructive/10 mt-2">
                <AlertCircle size={16} className="text-destructive" />
                <Text className="text-sm text-destructive flex-1">{error}</Text>
              </View>
            )}
          </View>
        ) : (
          /* PIN Entry */
          <>
            <View className="items-center mb-8">
              <View className="w-16 h-16 rounded-full bg-primary/10 items-center justify-center mb-4">
                <Link2 size={28} className="text-primary" />
              </View>
              <Text className="text-xl font-bold text-foreground mb-2">Enter Pairing Code</Text>
              <Text className="text-sm text-muted-foreground text-center">
                Open your desktop Shogo app, go to Settings → Remote Control, and find the 6-digit code.
              </Text>
            </View>

            <TextInput
              value={code}
              onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
              placeholder="000000"
              placeholderTextColor="#666"
              keyboardType="number-pad"
              maxLength={6}
              className="text-center text-3xl font-mono tracking-[12px] py-4 px-4 rounded-xl border border-border bg-card text-foreground mb-4"
              autoFocus
            />

            {error && (
              <View className="flex-row items-center gap-2 p-3 rounded-lg bg-destructive/10 mb-4">
                <AlertCircle size={16} className="text-destructive" />
                <Text className="text-sm text-destructive flex-1">{error}</Text>
              </View>
            )}

            <Pressable
              onPress={handlePinSubmit}
              disabled={state === 'pairing' || code.length < 6}
              className={`py-3 rounded-lg items-center ${
                code.length >= 6 && state !== 'pairing' ? 'bg-primary active:opacity-80' : 'bg-muted'
              }`}
            >
              {state === 'pairing' ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text className={`text-sm font-medium ${
                  code.length >= 6 ? 'text-primary-foreground' : 'text-muted-foreground'
                }`}>
                  Pair Device
                </Text>
              )}
            </Pressable>

            <View className="flex-row items-center gap-2 mt-6 p-3 rounded-lg bg-muted/50">
              <ShieldCheck size={16} className="text-muted-foreground" />
              <Text className="text-xs text-muted-foreground flex-1">
                Pairing creates a secure API key that lets this device communicate with your desktop.
                The code expires in 5 minutes.
              </Text>
            </View>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  )
}
