/**
 * Shared route constants and deep link patterns.
 * Used by both web (React Router) and native (Expo Router) apps.
 */

export const ROUTES = {
  HOME: '/',
  SIGN_IN: '/sign-in',
  SIGN_UP: '/sign-up',

  PROJECTS: '/projects',
  PROJECT: (id: string) => `/projects/${id}`,
  PROJECT_SETTINGS: (id: string) => `/projects/${id}/settings`,

  PROFILE: '/profile',
  BILLING: '/billing',
  MEMBERS: '/members',
  SETTINGS: '/settings',
  STARRED: '/starred',
  SHARED: '/shared',
  TEMPLATES: '/templates',

  ADMIN: '/admin',
  ADMIN_USERS: '/admin/users',
  ADMIN_USER: (userId: string) => `/admin/users/${userId}`,
  ADMIN_WORKSPACES: '/admin/workspaces',
  ADMIN_ANALYTICS: '/admin/analytics',
} as const

export const DEEP_LINK_SCHEME = 'shogo'

export function buildDeepLink(path: string): string {
  return `${DEEP_LINK_SCHEME}://${path.replace(/^\//, '')}`
}

export function parseDeepLink(url: string): string | null {
  if (url.startsWith(`${DEEP_LINK_SCHEME}://`)) {
    return '/' + url.slice(`${DEEP_LINK_SCHEME}://`.length)
  }
  return null
}
