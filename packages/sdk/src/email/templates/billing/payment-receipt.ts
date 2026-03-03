import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const paymentReceiptTemplate: EmailTemplate<{
  name?: string
  workspaceName: string
  planName: string
  amount: string
  currency?: string
  invoiceDate: string
  invoiceUrl?: string
  appName: string
}> = {
  name: 'payment-receipt',
  subject: 'Payment receipt for {{workspaceName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Payment Received</h1>
    <p class="email-text">
      Thank you! Here's your receipt for <strong>{{workspaceName}}</strong>.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td class="email-detail-label">Plan</td>
        <td class="email-detail-value" align="right">{{planName}}</td>
      </tr>
      <tr>
        <td class="email-detail-label">Amount</td>
        <td class="email-detail-value" align="right">{{currency}}{{amount}}</td>
      </tr>
      <tr>
        <td class="email-detail-label">Date</td>
        <td class="email-detail-value" align="right">{{invoiceDate}}</td>
      </tr>
    </table>
    <br>
    <a href="{{invoiceUrl}}" class="email-btn-outline">View Invoice</a>
    <hr class="email-divider">
    <p class="email-muted">
      If you have billing questions, reply to this email or contact support.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
    currency: '$',
  },
}
