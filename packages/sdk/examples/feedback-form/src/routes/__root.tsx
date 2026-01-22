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
    links: [
      {
        rel: 'stylesheet',
        href: 'https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css',
      },
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
        <style>{`
          .star-rating {
            display: flex;
            gap: 0.25rem;
          }
          .star-rating button {
            background: none;
            border: none;
            font-size: 1.5rem;
            cursor: pointer;
            padding: 0;
            color: #d1d5db;
            transition: color 0.15s;
          }
          .star-rating button.filled {
            color: #fbbf24;
          }
          .star-rating button:hover {
            color: #f59e0b;
          }
          .stat-card {
            background: #f9fafb;
            border-radius: 0.5rem;
            padding: 1rem;
            text-align: center;
          }
          .stat-card h3 {
            font-size: 2rem;
            margin: 0;
            color: #1f2937;
          }
          .stat-card p {
            margin: 0.25rem 0 0;
            color: #6b7280;
            font-size: 0.875rem;
          }
          .submission-item {
            display: flex;
            align-items: flex-start;
            gap: 1rem;
            padding: 1rem;
            border-bottom: 1px solid #e5e7eb;
            transition: background 0.15s;
          }
          .submission-item:hover {
            background: #f9fafb;
          }
          .submission-item.unread {
            background: #eff6ff;
          }
          .submission-item.unread:hover {
            background: #dbeafe;
          }
          .category-badge {
            display: inline-block;
            padding: 0.125rem 0.5rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 500;
          }
          .category-badge.feedback { background: #dbeafe; color: #1e40af; }
          .category-badge.bug { background: #fee2e2; color: #991b1b; }
          .category-badge.feature { background: #d1fae5; color: #065f46; }
          .category-badge.question { background: #fef3c7; color: #92400e; }
          .filter-tabs {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 1rem;
          }
          .filter-tabs button {
            padding: 0.5rem 1rem;
            border: 1px solid #e5e7eb;
            background: white;
            border-radius: 0.375rem;
            cursor: pointer;
            font-size: 0.875rem;
          }
          .filter-tabs button.active {
            background: #3b82f6;
            color: white;
            border-color: #3b82f6;
          }
        `}</style>
      </head>
      <body>
        <main className="container" style={{ maxWidth: '800px', paddingTop: '2rem' }}>
          {children}
        </main>
        <Scripts />
      </body>
    </html>
  )
}
