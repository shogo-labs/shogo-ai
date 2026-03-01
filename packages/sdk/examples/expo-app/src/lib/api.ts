/**
 * API Client Configuration
 *
 * Configures the API client with the correct base URL.
 * In web, this uses relative URLs. In native, this should be updated
 * to point to the actual server URL.
 */

import { configureApiClient, api } from '../generated/api-client'
import Constants from 'expo-constants'

// Get the API URL - in web this is relative, in native it's the server URL
const getApiUrl = (): string => {
  // In web mode, detect base path for preview proxy support
  if (typeof window !== 'undefined') {
    // Check if running under a base path (e.g., /preview/)
    // This handles the runtime proxy which serves the app at /preview/*
    const pathname = window.location.pathname
    const previewMatch = pathname.match(/^(\/preview)\/?/)
    if (previewMatch) {
      return `${previewMatch[1]}/api`
    }
    return '/api'
  }

  // In native mode, use the server URL from config or environment
  // Default to localhost for development
  const serverUrl = Constants.expoConfig?.extra?.apiUrl || 'http://localhost:3000'
  return `${serverUrl}/api`
}

// Initialize the API client with the correct URL
export function initializeApi(userId?: string) {
  configureApiClient({
    baseUrl: getApiUrl(),
    userId,
  })
}

// Export the configured API client
export { api } from '../generated/api-client'
