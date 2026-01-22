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
      { title: 'Form Builder - Shogo SDK Example' },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: 'https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css',
      },
    ],
  }),
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
          .form-card {
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 0.5rem;
            padding: 1rem;
            margin-bottom: 1rem;
            transition: border-color 0.15s;
          }
          .form-card:hover {
            border-color: #3b82f6;
          }
          .field-card {
            background: white;
            border: 1px solid #e5e7eb;
            border-radius: 0.375rem;
            padding: 0.75rem;
            margin-bottom: 0.5rem;
            display: flex;
            align-items: center;
            gap: 0.75rem;
          }
          .field-card .drag-handle {
            cursor: grab;
            color: #9ca3af;
            font-size: 1.25rem;
          }
          .field-type-badge {
            display: inline-block;
            padding: 0.125rem 0.5rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 500;
            background: #dbeafe;
            color: #1e40af;
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
          .status-badge {
            display: inline-block;
            padding: 0.125rem 0.5rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 500;
          }
          .status-badge.published {
            background: #d1fae5;
            color: #065f46;
          }
          .status-badge.draft {
            background: #fef3c7;
            color: #92400e;
          }
          .tabs {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 1.5rem;
            border-bottom: 1px solid #e5e7eb;
            padding-bottom: 0.5rem;
          }
          .tabs button {
            padding: 0.5rem 1rem;
            border: none;
            background: none;
            cursor: pointer;
            font-size: 0.875rem;
            color: #6b7280;
            border-bottom: 2px solid transparent;
            margin-bottom: -0.5rem;
            padding-bottom: calc(0.5rem + 1px);
          }
          .tabs button.active {
            color: #3b82f6;
            border-bottom-color: #3b82f6;
          }
          .submission-row {
            display: flex;
            align-items: center;
            gap: 1rem;
            padding: 0.75rem;
            border-bottom: 1px solid #e5e7eb;
          }
          .submission-row.unread {
            background: #eff6ff;
          }
          .response-item {
            margin-bottom: 0.75rem;
            padding-bottom: 0.75rem;
            border-bottom: 1px solid #f3f4f6;
          }
          .response-item:last-child {
            border-bottom: none;
            margin-bottom: 0;
            padding-bottom: 0;
          }
          .response-label {
            font-size: 0.75rem;
            color: #6b7280;
            margin-bottom: 0.25rem;
          }
          .response-value {
            font-size: 0.875rem;
            color: #1f2937;
          }
        `}</style>
      </head>
      <body>
        <main className="container" style={{ maxWidth: '900px', paddingTop: '2rem' }}>
          {children}
        </main>
        <Scripts />
      </body>
    </html>
  )
}
