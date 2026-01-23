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
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

// Global styles
const globalStyles = `
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background-color: #f9fafb;
    color: #111827;
    line-height: 1.5;
  }
`
