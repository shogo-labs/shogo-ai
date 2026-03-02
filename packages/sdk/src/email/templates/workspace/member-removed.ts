import type { EmailTemplate } from '../../types.js'
import { EMAIL_CONSTANTS, wrapInLayout } from '../_layout.js'

export const memberRemovedTemplate: EmailTemplate<{
  workspaceName: string
  appName: string
}> = {
  name: 'member-removed',
  subject: 'You have been removed from {{workspaceName}}',
  html: wrapInLayout(`
    <h1 class="email-h1">Workspace Access Removed</h1>
    <p class="email-text">
      You no longer have access to the <strong>{{workspaceName}}</strong>
      workspace. All associated projects and data in that workspace are no
      longer accessible from your account.
    </p>
    <hr class="email-divider">
    <p class="email-muted">
      If you believe this was a mistake, please contact the workspace owner
      or reply to this email.
    </p>
  `),
  defaults: {
    appName: EMAIL_CONSTANTS.APP_NAME,
  },
}
