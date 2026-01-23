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
      { title: 'Booking App - Shogo SDK Example' },
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
          .service-card {
            background: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 0.5rem;
            padding: 1rem;
            margin-bottom: 1rem;
          }
          .service-card:hover {
            border-color: #3b82f6;
          }
          .booking-row {
            display: flex;
            align-items: center;
            gap: 1rem;
            padding: 0.75rem;
            border-bottom: 1px solid #e5e7eb;
          }
          .booking-row:last-child {
            border-bottom: none;
          }
          .status-badge {
            display: inline-block;
            padding: 0.125rem 0.5rem;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 500;
            text-transform: uppercase;
          }
          .status-pending {
            background: #fef3c7;
            color: #92400e;
          }
          .status-confirmed {
            background: #d1fae5;
            color: #065f46;
          }
          .status-completed {
            background: #dbeafe;
            color: #1e40af;
          }
          .status-cancelled {
            background: #fee2e2;
            color: #991b1b;
          }
          .time-slot-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            gap: 0.5rem;
          }
          .time-slot {
            padding: 0.5rem;
            text-align: center;
            border: 1px solid #e5e7eb;
            border-radius: 0.375rem;
            cursor: pointer;
            transition: all 0.15s;
          }
          .time-slot:hover {
            border-color: #3b82f6;
            background: #eff6ff;
          }
          .time-slot.selected {
            background: #3b82f6;
            color: white;
            border-color: #3b82f6;
          }
          .day-schedule {
            margin-bottom: 1rem;
            padding: 0.75rem;
            background: #f9fafb;
            border-radius: 0.5rem;
          }
          .day-schedule h4 {
            margin: 0 0 0.5rem;
            font-size: 0.875rem;
            color: #374151;
          }
          .color-dot {
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            margin-right: 0.5rem;
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
