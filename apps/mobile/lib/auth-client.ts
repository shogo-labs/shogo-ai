import { Platform } from 'react-native'
import { createAuthClient } from '@shogo/shared-app/auth'
import { API_URL } from './api'
import { saveSetCookieHeader, getAuthCookieHeader, clearAuthCookies } from './auth-storage'

function createMobileAuthClient() {
  if (Platform.OS === 'web') {
    return createAuthClient({
      baseURL: API_URL!,
      basePath: '/api/auth',
    })
  }

  const { createAuthClient: createBetterAuthClient } = require('better-auth/react')

  return createBetterAuthClient({
    baseURL: API_URL!,
    basePath: '/api/auth',
    fetchOptions: {
      credentials: 'omit' as RequestCredentials,

      onRequest(context: any) {
        if (context.url?.toString().includes('/sign-out')) {
          clearAuthCookies()
        }

        const cookie = getAuthCookieHeader()
        if (cookie) {
          const existing = context.headers || {}
          return {
            ...context,
            headers: { ...existing, cookie },
            credentials: 'omit',
          }
        }
        return { ...context, credentials: 'omit' }
      },

      onSuccess(context: any) {
        const response = context.response
        const setCookie = response?.headers?.get?.('set-cookie') || response?.headers?.get?.('Set-Cookie')
        if (setCookie) {
          console.log('[auth-client] Captured set-cookie header')
          saveSetCookieHeader(setCookie)
        } else {
          const url = context.request?.url?.toString() || context.url?.toString() || 'unknown'
          if (url.includes('/sign-in') || url.includes('/sign-up') || url.includes('/get-session')) {
            console.log('[auth-client] No set-cookie in auth response for:', url)
            // Log all response headers for debugging
            if (response?.headers?.forEach) {
              const hdrs: string[] = []
              response.headers.forEach((_v: string, k: string) => hdrs.push(k))
              console.log('[auth-client] Response header names:', hdrs.join(', '))
            }
          }
        }
      },
    },
  })
}

export const authClient = createMobileAuthClient()
