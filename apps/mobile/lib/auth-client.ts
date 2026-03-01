import { Platform } from 'react-native'
import { createAuthClient } from '@shogo/shared-app/auth'
import { createAuthClient as createBetterAuthClient } from 'better-auth/react'
import { expoClient } from '@better-auth/expo/client'
import * as SecureStore from 'expo-secure-store'
import { API_URL } from './api'

function createMobileAuthClient() {
  if (Platform.OS === 'web') {
    return createAuthClient({
      baseURL: API_URL!,
      basePath: '/api/auth',
    })
  }

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
