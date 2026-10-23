// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Sidebar highlighting and page titles for the admin console.
 *
 * Pure string logic, kept out of `app/(admin)/_layout.tsx` so a renamed admin
 * route can be pinned by a test. The two sides disagree by construction: a nav
 * href carries the `(admin)` group segment (`/(admin)/admin/projects`) while
 * `usePathname()` returns the resolved URL (`/admin/projects`). When SHO-110 and
 * SHO-115 moved admin pages under `/admin/*`, every one of these strings had to
 * follow — a miss here silently drops the active highlight or the header title
 * without breaking navigation, which is why it is tested rather than eyeballed.
 */

/** Is `href` (a nav item's `/(admin)/...` target) the section `pathname` is in? */
export function isAdminNavActive(pathname: string, href: string): boolean {
  if (href === '/(admin)') {
    return pathname === '/' || pathname === '' || pathname === '/(admin)' || pathname === '/index'
  }
  const clean = href.replace('/(admin)', '')
  return pathname.startsWith(clean)
}

/** Header title for an admin pathname. */
export function adminPageTitle(pathname: string): string {
  if (pathname.startsWith('/users/')) return 'User Detail'
  if (pathname.startsWith('/users') || pathname === '/users') return 'Users'
  if (pathname.startsWith('/workspaces/')) return 'Workspace Detail'
  if (pathname.includes('workspaces')) return 'Workspaces'
  if (pathname.startsWith('/grants/')) return 'Grant Detail'
  if (pathname.includes('grants')) return 'Credit grants'
  if (pathname.startsWith('/admin/marketplace/listing/')) return 'Listing Detail'
  if (pathname.startsWith('/admin/marketplace/payouts')) return 'Marketplace Payouts'
  if (pathname.startsWith('/admin/marketplace/listings')) return 'Marketplace Listings'
  if (pathname.startsWith('/admin/marketplace')) return 'Marketplace Review'
  if (pathname.startsWith('/admin/projects/')) return 'Project Detail'
  if (pathname.includes('projects')) return 'Projects'
  if (pathname.includes('ai-analytics')) return 'AI Analytics'
  if (pathname.includes('analytics')) return 'Marketing Analytics'
  if (pathname.startsWith('/creators/')) return 'Creator Profile'
  if (pathname.includes('creators')) return 'Creators'
  if (pathname.includes('affiliate-payouts')) return 'Affiliate Payouts'
  if (pathname.includes('signup-risk')) return 'Signup Risk'
  if (pathname.includes('affiliate-content')) return 'Affiliate CPM'
  if (pathname.includes('infrastructure')) return 'Infrastructure'
  if (pathname.includes('heartbeats')) return 'Heartbeats'
  if (pathname.startsWith('/evals/')) return 'Eval Detail'
  if (pathname.includes('evals')) return 'Evals'
  if (pathname.includes('/logs')) return 'Logs'
  if (pathname.includes('meetings')) return 'Meetings'
  if (pathname.includes('general')) return 'General'
  if (pathname.includes('settings')) return 'AI Settings'
  return 'Dashboard'
}
