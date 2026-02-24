import { createAuthClient } from '@shogo/shared-app/auth'
import { API_URL } from './api'

export const authClient = createAuthClient({
  baseURL: API_URL!,
  basePath: '/api/auth',
})
