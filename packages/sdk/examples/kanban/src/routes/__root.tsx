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
      { title: 'Kanban Board - Shogo SDK' },
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
    background-color: #0079bf;
    color: #172b4d;
    line-height: 1.4;
    min-height: 100vh;
  }

  /* Header */
  .header {
    background: rgba(0,0,0,0.15);
    padding: 8px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: white;
  }

  .header h1 {
    font-size: 1.25rem;
    font-weight: 700;
  }

  .header-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  /* Board container */
  .board-container {
    padding: 16px;
    overflow-x: auto;
    height: calc(100vh - 52px);
  }

  .columns-wrapper {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    height: 100%;
  }

  /* Column */
  .column {
    background: #ebecf0;
    border-radius: 12px;
    width: 280px;
    min-width: 280px;
    max-height: calc(100vh - 100px);
    display: flex;
    flex-direction: column;
  }

  .column-header {
    padding: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .column-title {
    font-weight: 600;
    font-size: 0.9rem;
  }

  .column-count {
    background: rgba(0,0,0,0.1);
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 0.75rem;
    color: #5e6c84;
  }

  .column-cards {
    padding: 0 8px 8px;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Card */
  .card {
    background: white;
    border-radius: 8px;
    padding: 8px 12px;
    box-shadow: 0 1px 0 rgba(9,30,66,0.25);
    cursor: pointer;
    transition: background 0.1s;
  }

  .card:hover {
    background: #f4f5f7;
  }

  .card.dragging {
    opacity: 0.5;
    transform: rotate(3deg);
  }

  .card-title {
    font-size: 0.9rem;
    margin-bottom: 8px;
    word-break: break-word;
  }

  .card-labels {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }

  .card-label {
    height: 8px;
    width: 40px;
    border-radius: 4px;
  }

  .card-meta {
    display: flex;
    gap: 8px;
    font-size: 0.75rem;
    color: #5e6c84;
  }

  .card-due {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 4px;
    background: #f4f5f7;
  }

  .card-due.overdue {
    background: #ffebe6;
    color: #ae2e24;
  }

  .card-due.soon {
    background: #fff8e6;
    color: #946f00;
  }

  /* Add card form */
  .add-card-form {
    padding: 8px;
  }

  .add-card-btn {
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    color: #5e6c84;
    font-size: 0.9rem;
    transition: background 0.1s;
  }

  .add-card-btn:hover {
    background: rgba(0,0,0,0.05);
    color: #172b4d;
  }

  .card-input {
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-radius: 8px;
    font-size: 0.9rem;
    resize: none;
    min-height: 60px;
    margin-bottom: 8px;
  }

  .card-input:focus {
    outline: none;
  }

  .form-actions {
    display: flex;
    gap: 8px;
  }

  /* Add column */
  .add-column {
    background: rgba(255,255,255,0.24);
    border-radius: 12px;
    width: 280px;
    min-width: 280px;
    padding: 12px;
  }

  .add-column-btn {
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    color: white;
    font-size: 0.9rem;
    transition: background 0.1s;
  }

  .add-column-btn:hover {
    background: rgba(255,255,255,0.1);
  }

  .column-input {
    width: 100%;
    padding: 8px 12px;
    border: 2px solid #0079bf;
    border-radius: 4px;
    font-size: 0.9rem;
    margin-bottom: 8px;
  }

  .column-input:focus {
    outline: none;
  }

  /* Buttons */
  .btn {
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
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
    background: #0079bf;
    color: white;
  }

  .btn-secondary {
    background: transparent;
    color: #5e6c84;
  }

  .btn-ghost {
    background: transparent;
    color: #5e6c84;
    padding: 4px 8px;
  }

  .btn-danger {
    background: #eb5a46;
    color: white;
  }

  .btn-icon {
    padding: 4px;
    background: transparent;
    border: none;
    cursor: pointer;
    color: #6b778c;
    border-radius: 4px;
  }

  .btn-icon:hover {
    background: rgba(0,0,0,0.1);
  }

  /* Board selector */
  .board-list {
    padding: 40px;
    max-width: 800px;
    margin: 0 auto;
  }

  .board-list h2 {
    color: white;
    margin-bottom: 20px;
  }

  .board-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
  }

  .board-card {
    background: white;
    border-radius: 8px;
    padding: 16px;
    cursor: pointer;
    transition: transform 0.1s, box-shadow 0.1s;
    border-left: 4px solid;
  }

  .board-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  }

  .board-card h3 {
    margin-bottom: 4px;
  }

  .board-card p {
    font-size: 0.875rem;
    color: #5e6c84;
  }

  .new-board-card {
    background: rgba(255,255,255,0.24);
    border: 2px dashed rgba(255,255,255,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-weight: 500;
    min-height: 100px;
  }

  .new-board-card:hover {
    background: rgba(255,255,255,0.32);
    transform: none;
  }

  /* Setup */
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
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    max-width: 400px;
    width: 100%;
    text-align: center;
  }

  .setup-card h1 {
    font-size: 1.75rem;
    margin-bottom: 8px;
  }

  .setup-card > p {
    color: #5e6c84;
    margin-bottom: 24px;
  }

  .setup-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    text-align: left;
  }

  .input {
    padding: 12px;
    border: 1px solid #dfe1e6;
    border-radius: 4px;
    font-size: 1rem;
    width: 100%;
  }

  .input:focus {
    outline: none;
    border-color: #0079bf;
  }

  /* Modal overlay */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 48px 16px;
    overflow-y: auto;
    z-index: 100;
  }

  .modal {
    background: #f4f5f7;
    border-radius: 8px;
    width: 100%;
    max-width: 768px;
    position: relative;
  }

  .modal-header {
    padding: 16px 48px 16px 16px;
    border-bottom: 1px solid #dfe1e6;
  }

  .modal-close {
    position: absolute;
    top: 12px;
    right: 12px;
    background: transparent;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #6b778c;
    padding: 4px;
    line-height: 1;
  }

  .modal-body {
    padding: 16px;
  }

  .modal-section {
    margin-bottom: 16px;
  }

  .modal-section h4 {
    font-size: 0.75rem;
    text-transform: uppercase;
    color: #5e6c84;
    margin-bottom: 8px;
  }

  .modal-input {
    width: 100%;
    padding: 8px 12px;
    border: 1px solid #dfe1e6;
    border-radius: 4px;
    font-size: 0.9rem;
  }

  .modal-input:focus {
    outline: none;
    border-color: #0079bf;
  }

  textarea.modal-input {
    min-height: 100px;
    resize: vertical;
  }

  /* Labels in modal */
  .labels-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .label-chip {
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 0.875rem;
    color: white;
    cursor: pointer;
    border: 2px solid transparent;
  }

  .label-chip.selected {
    border-color: #172b4d;
  }

  /* Drop zone indicator */
  .drop-zone {
    min-height: 8px;
    border-radius: 4px;
    transition: all 0.15s;
  }

  .drop-zone.active {
    background: rgba(0,121,191,0.2);
    min-height: 60px;
    border: 2px dashed #0079bf;
  }

  /* Loading & Empty states */
  .loading {
    padding: 40px;
    text-align: center;
    color: white;
  }

  .empty {
    padding: 40px;
    text-align: center;
    color: #5e6c84;
  }

  .error {
    color: #eb5a46;
    font-size: 0.875rem;
  }
`
