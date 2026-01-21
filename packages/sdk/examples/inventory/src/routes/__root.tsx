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
      { title: 'Inventory Management - TanStack Start' },
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
    background-color: #f5f5f5;
    color: #333;
    line-height: 1.6;
  }

  .app {
    max-width: 1100px;
    margin: 0 auto;
    padding: 20px;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid #e5e5e5;
  }

  .header h1 {
    font-size: 1.8rem;
    font-weight: 700;
  }

  .user-info {
    display: flex;
    align-items: center;
    gap: 12px;
    color: #666;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }

  .summary-card {
    background: white;
    padding: 20px;
    border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    border-left: 4px solid;
  }

  .card-label {
    font-size: 0.875rem;
    color: #666;
    margin-bottom: 4px;
  }

  .card-value {
    font-size: 1.75rem;
    font-weight: 700;
  }

  .section {
    background: white;
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  .section h3 {
    margin-bottom: 16px;
    font-size: 1.1rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    flex-wrap: wrap;
    gap: 12px;
  }

  .btn {
    padding: 10px 20px;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    transition: opacity 0.2s;
  }

  .btn:hover {
    opacity: 0.9;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: #3B82F6;
    color: white;
  }

  .btn-secondary {
    background: #f5f5f5;
    color: #666;
    border: 1px solid #ddd;
  }

  .btn-success {
    background: #22C55E;
    color: white;
  }

  .btn-warning {
    background: #F59E0B;
    color: white;
  }

  .btn-danger {
    background: transparent;
    color: #EF4444;
    border: 1px solid #EF4444;
    padding: 4px 8px;
    font-size: 0.8rem;
  }

  .btn-sm {
    padding: 6px 12px;
    font-size: 0.8rem;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    background: #f9f9f9;
    border-radius: 8px;
    margin-bottom: 16px;
  }

  .form-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
  }

  .input {
    padding: 12px;
    border: 1px solid #ddd;
    border-radius: 8px;
    font-size: 1rem;
    width: 100%;
  }

  .input:focus {
    outline: none;
    border-color: #3B82F6;
  }

  .product-table {
    width: 100%;
    border-collapse: collapse;
  }

  .product-table th,
  .product-table td {
    padding: 12px;
    text-align: left;
    border-bottom: 1px solid #eee;
  }

  .product-table th {
    font-weight: 600;
    color: #666;
    font-size: 0.875rem;
  }

  .product-table tr:hover {
    background: #f9f9f9;
  }

  .product-name {
    font-weight: 600;
  }

  .product-sku {
    font-size: 0.75rem;
    color: #999;
  }

  .stock-badge {
    display: inline-block;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .stock-ok {
    background: #D1FAE5;
    color: #059669;
  }

  .stock-low {
    background: #FEF3C7;
    color: #D97706;
  }

  .stock-out {
    background: #FEE2E2;
    color: #DC2626;
  }

  .category-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 0.75rem;
  }

  .low-stock-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .low-stock-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: #FEF3C7;
    border-radius: 8px;
  }

  .category-breakdown {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .category-row {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid #eee;
  }

  .category-row:last-child {
    border-bottom: none;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .empty {
    padding: 40px;
    text-align: center;
    color: #999;
  }

  .loading {
    padding: 40px;
    text-align: center;
    color: #666;
  }

  .error {
    color: #EF4444;
    font-size: 0.875rem;
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
  }

  .setup-card > p {
    color: #666;
    margin-bottom: 24px;
  }

  .setup-card .form {
    background: transparent;
    padding: 0;
    text-align: left;
  }

  .setup-footer {
    margin-top: 24px;
    font-size: 0.75rem;
    color: #999;
  }

  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }

  .tab {
    padding: 8px 16px;
    border: none;
    background: #f5f5f5;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 500;
  }

  .tab.active {
    background: #3B82F6;
    color: white;
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .modal {
    background: white;
    padding: 24px;
    border-radius: 12px;
    max-width: 500px;
    width: 90%;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal h3 {
    margin-bottom: 16px;
  }
`
