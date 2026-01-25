/**
 * Root Route - App Shell
 *
 * Production-grade setup:
 * - StoreProvider wraps entire app for MobX store access
 * - No server-side auth loading (handled by AuthStore on client)
 * - Clean separation between root layout and protected routes
 */

import {
  HeadContent,
  Scripts,
  Outlet,
  createRootRoute,
} from '@tanstack/react-router'
import * as React from 'react'
import { StoreProvider } from '../stores'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Todo App - Shogo SDK Example' },
    ],
    scripts: [
      { src: 'https://cdn.tailwindcss.com' },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <StoreProvider>
        <Outlet />
      </StoreProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="bg-gray-50 text-gray-900 font-sans">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
