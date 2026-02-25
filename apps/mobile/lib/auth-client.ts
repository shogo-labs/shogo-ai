import { Platform } from 'react-native'
import { createAuthClient } from '@shogo/shared-app/auth'
import { API_URL } from './api'

function createMobileAuthClient() {
  if (Platform.OS === 'web') {
    return createAuthClient({
      baseURL: API_URL!,
      basePath: '/api/auth',
    })
  }

  // On native (Android/iOS), use the @better-auth/expo client plugin
  // for secure cookie storage via expo-secure-store
  const { createAuthClient: createBetterAuthClient } = require('better-auth/react')
  const { expoClient } = require('@better-auth/expo/client')
  const SecureStore = require('expo-secure-store')

  return createBetterAuthClient({
    baseURL: API_URL!,
    basePath: '/api/auth',
    plugins: [
      expoClient({
        scheme: 'shogo',
        storagePrefix: 'shogo',
        storage: SecureStore,
      }),
    ],
  })
}

export const authClient = createMobileAuthClient()
