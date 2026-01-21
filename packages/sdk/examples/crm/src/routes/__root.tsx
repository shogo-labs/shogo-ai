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
      { title: 'CRM - TanStack Start' },
    ],
  }),
  // Load user at root level - available to all child routes via context
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
        <style dangerouslySetInnerHTML={{ __html: globalStyles }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

const globalStyles = `
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background-color: #f8fafc;
    color: #1e293b;
    line-height: 1.6;
  }

  .app {
    min-height: 100vh;
  }

  .header {
    background: white;
    border-bottom: 1px solid #e2e8f0;
    padding: 16px 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .header h1 {
    font-size: 1.5rem;
    font-weight: 700;
    color: #0f172a;
  }

  .user-info {
    color: #64748b;
    font-size: 0.875rem;
  }

  .main-content {
    max-width: 1400px;
    margin: 0 auto;
    padding: 24px;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .stat-card {
    background: white;
    border-radius: 12px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  .stat-label {
    font-size: 0.875rem;
    color: #64748b;
    margin-bottom: 4px;
  }

  .stat-value {
    font-size: 2rem;
    font-weight: 700;
    color: #0f172a;
  }

  .section {
    background: white;
    border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    margin-bottom: 24px;
  }

  .section-header {
    padding: 16px 20px;
    border-bottom: 1px solid #e2e8f0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .section-header h2 {
    font-size: 1.125rem;
    font-weight: 600;
  }

  .section-body {
    padding: 20px;
  }

  .filters {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  .search-input {
    flex: 1;
    min-width: 200px;
    padding: 10px 16px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    font-size: 0.875rem;
  }

  .search-input:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  .filter-select {
    padding: 10px 16px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    font-size: 0.875rem;
    background: white;
    min-width: 150px;
  }

  .btn {
    padding: 10px 20px;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: #3b82f6;
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: #2563eb;
  }

  .btn-secondary {
    background: #f1f5f9;
    color: #475569;
    border: 1px solid #e2e8f0;
  }

  .btn-secondary:hover:not(:disabled) {
    background: #e2e8f0;
  }

  .btn-danger {
    background: #fee2e2;
    color: #dc2626;
  }

  .btn-danger:hover:not(:disabled) {
    background: #fecaca;
  }

  .btn-sm {
    padding: 6px 12px;
    font-size: 0.75rem;
  }

  .contact-list {
    display: flex;
    flex-direction: column;
  }

  .contact-item {
    display: flex;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid #f1f5f9;
    gap: 16px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .contact-item:hover {
    background: #f8fafc;
  }

  .contact-item:last-child {
    border-bottom: none;
  }

  .contact-avatar {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: #e2e8f0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    color: #64748b;
    flex-shrink: 0;
  }

  .contact-info {
    flex: 1;
    min-width: 0;
  }

  .contact-name {
    font-weight: 600;
    color: #0f172a;
  }

  .contact-details {
    font-size: 0.875rem;
    color: #64748b;
    display: flex;
    gap: 16px;
    margin-top: 4px;
  }

  .contact-tags {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .tag {
    padding: 2px 8px;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .status-badge {
    padding: 4px 12px;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: capitalize;
  }

  .status-lead { background: #fef3c7; color: #92400e; }
  .status-prospect { background: #dbeafe; color: #1e40af; }
  .status-customer { background: #dcfce7; color: #166534; }
  .status-churned { background: #fee2e2; color: #991b1b; }

  .form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .form-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .form-group label {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
  }

  .input {
    padding: 10px 14px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    font-size: 0.875rem;
    transition: all 0.2s;
  }

  .input:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  select.input {
    background: white;
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: white;
    border-radius: 16px;
    max-width: 600px;
    width: 90%;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal-header {
    padding: 20px;
    border-bottom: 1px solid #e2e8f0;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .modal-header h3 {
    font-size: 1.125rem;
    font-weight: 600;
  }

  .modal-body {
    padding: 20px;
  }

  .modal-footer {
    padding: 16px 20px;
    border-top: 1px solid #e2e8f0;
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }

  .empty {
    padding: 48px 20px;
    text-align: center;
    color: #64748b;
  }

  .empty-icon {
    font-size: 3rem;
    margin-bottom: 16px;
  }

  .error {
    color: #dc2626;
    font-size: 0.875rem;
  }

  .activity-list {
    display: flex;
    flex-direction: column;
  }

  .activity-item {
    display: flex;
    gap: 12px;
    padding: 12px 0;
    border-bottom: 1px solid #f1f5f9;
  }

  .activity-item:last-child {
    border-bottom: none;
  }

  .activity-icon {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-size: 0.875rem;
  }

  .activity-icon.note { background: #e0e7ff; }
  .activity-icon.call { background: #dcfce7; }
  .activity-icon.email { background: #fef3c7; }
  .activity-icon.meeting { background: #fce7f3; }

  .activity-content {
    flex: 1;
  }

  .activity-text {
    color: #1e293b;
  }

  .activity-meta {
    font-size: 0.75rem;
    color: #94a3b8;
    margin-top: 4px;
  }

  .pipeline-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 16px;
  }

  .pipeline-stage {
    text-align: center;
    padding: 16px;
    background: #f8fafc;
    border-radius: 8px;
  }

  .pipeline-stage-name {
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #64748b;
    margin-bottom: 8px;
  }

  .pipeline-stage-count {
    font-size: 1.5rem;
    font-weight: 700;
    color: #0f172a;
  }

  .pipeline-stage-value {
    font-size: 0.875rem;
    color: #22c55e;
  }

  .setup-container {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .setup-card {
    background: white;
    padding: 40px;
    border-radius: 16px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.1);
    max-width: 400px;
    width: 100%;
    text-align: center;
  }

  .setup-card h1 {
    font-size: 2rem;
    margin-bottom: 8px;
    color: #0f172a;
  }

  .setup-card > p {
    color: #64748b;
    margin-bottom: 24px;
  }

  .setup-card .form {
    text-align: left;
  }

  .setup-footer {
    margin-top: 24px;
    font-size: 0.75rem;
    color: #94a3b8;
  }

  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid #e2e8f0;
    margin-bottom: 20px;
  }

  .tab {
    padding: 12px 20px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    color: #64748b;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: all 0.2s;
  }

  .tab:hover {
    color: #3b82f6;
  }

  .tab.active {
    color: #3b82f6;
    border-bottom-color: #3b82f6;
  }

  .tag-input-container {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    min-height: 44px;
    align-items: center;
  }

  .tag-input-tag {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 9999px;
    font-size: 0.75rem;
  }

  .tag-input-tag button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    font-size: 1rem;
    line-height: 1;
    opacity: 0.7;
  }

  .tag-input-tag button:hover {
    opacity: 1;
  }
`
