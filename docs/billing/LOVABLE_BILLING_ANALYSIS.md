# Lovable.dev Billing Flow Analysis

## Overview
This document analyzes how Lovable.dev handles billing account management and plan upgrades/downgrades, based on exploration using Playwright.

## Billing Account Management

### Current Implementation
Lovable.dev uses **Stripe Customer Portal** for all billing account management. They provide a unified "Manage" button that opens a dialog with two options:

1. **Edit billing information** - Opens Stripe portal to edit:
   - Name
   - Email
   - Address (Country, Address lines, City, State, ZIP)
   - Phone number
   - Tax ID

2. **Invoices & payments** - Opens Stripe portal to view:
   - Current subscription details
   - Payment method management
   - Billing information (with update option)
   - Invoice history

### User Flow
1. User clicks "Manage" button next to current plan
2. Dialog opens showing:
   - Current plan status
   - Gift card balance (if any)
   - "Edit billing information" button
   - "Invoices & payments" button
3. Clicking either button redirects to Stripe Customer Portal
4. Portal URL format: `https://billing.stripe.com/p/session/{session_id}/...`
5. Portal includes "Return to Lovable" link that brings user back

## Plan Upgrades/Downgrades

### UI Structure
- Plan cards displayed directly on billing page (no separate upgrade page)
- Each plan card shows:
  - Plan name and description
  - Price (with monthly/annual toggle)
  - Credit tier selector (combobox dropdown)
  - "Upgrade" button
  - Feature list

### Plan Selection Features
- **Annual/Monthly Toggle**: Switch at top of each plan card
- **Credit Tier Selector**: Dropdown showing available credit amounts (e.g., "100 credits / month")
- **Upgrade Button**: Initiates checkout flow

### Current Plan Display
- Shows current plan status prominently at top
- Displays credit balance and usage
- "Manage" button for account management
- Clear indication of plan tier (Free, Pro, Business, Enterprise)

## Key Differences from Our Current Implementation

### What We Need to Add/Change

1. **Manage Dialog**: 
   - Add a "Manage" button that opens a dialog
   - Dialog should have "Edit billing information" and "Invoices & payments" buttons
   - Both should open Stripe Customer Portal

2. **Billing Page Layout**:
   - Show current plan status at top with "Manage" button
   - Display credit balance prominently
   - Show plan cards inline (already done)
   - Remove separate "Manage Billing" button from header

3. **Stripe Portal Integration**:
   - Ensure portal URLs are properly configured
   - Portal should allow editing billing info and viewing invoices
   - Return URL should point back to billing page

## Implementation Notes

### Stripe Portal Configuration
- Portal sessions are created server-side
- Return URL should be: `/app/billing` or `/settings?tab=billing`
- Portal allows customers to:
  - Update billing information
  - View invoices and payment history
  - Manage payment methods
  - View subscription details

### UX Best Practices from Lovable
1. **Single Entry Point**: One "Manage" button opens dialog with options
2. **Clear Separation**: Billing account management vs. plan selection are separate flows
3. **Inline Plan Selection**: Users can upgrade/downgrade directly from billing page
4. **Credit Visibility**: Current credit balance is prominently displayed
5. **Plan Status Clarity**: Current plan is clearly indicated

## Recommendations

1. **Add Manage Dialog Component**: Create a dialog that opens when "Manage" is clicked
2. **Update Billing Page Layout**: Match Lovable's structure with current plan at top
3. **Enhance Stripe Portal Integration**: Ensure both "Edit billing information" and "Invoices & payments" work correctly
4. **Improve Credit Display**: Show credit balance more prominently
5. **Simplify Navigation**: Remove redundant "Manage Billing" button from header
