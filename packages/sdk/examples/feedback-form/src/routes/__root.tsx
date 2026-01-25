import {
  HeadContent,
  Scripts,
  Outlet,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import * as React from 'react'
import { getCurrentUser } from '../utils/user'
import type { RouterContext } from '../router'

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Feedback Form - Shogo SDK Example' },
    ],
    scripts: [
      { src: 'https://cdn.tailwindcss.com' },
    ],
  }),
  // Load user using shogo.db
  beforeLoad: async () => {
    const user = await getCurrentUser()
    return { user }
  },
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
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
        <main className="max-w-3xl mx-auto px-4 pt-8">
          {children}
        </main>
        <Scripts />
      </body>
    </html>
  )
}
