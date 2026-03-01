import { createAuthClient as createBetterAuthClient } from 'better-auth/react'

export interface AuthClientConfig {
  baseURL: string
  basePath?: string
}

export function createAuthClient(config: AuthClientConfig) {
  return createBetterAuthClient({
    baseURL: config.baseURL,
    basePath: config.basePath ?? '/api/auth',
  })
}

export type AuthClient = ReturnType<typeof createAuthClient>
