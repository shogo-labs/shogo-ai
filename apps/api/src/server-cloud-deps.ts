// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Cloud-only dependency island for the API composer.
 *
 * Desktop/local mode deliberately never imports this module. Keeping the
 * cloud-shaped graph behind one dynamic import prevents Stripe, S3, billing,
 * marketplace, admin, affiliate, and cloud substrate modules from becoming
 * part of the local API's module-evaluation and resident-memory footprint.
 */
import Stripe from 'stripe'
import { getPriceId, getInstancePriceId } from './config/stripe-prices'
import { getCurrencyForCountry, formatPrice, SUPPORTED_CURRENCIES } from './config/currencies'
import { getExchangeRates, convertPrice } from './services/exchange-rate.service'
import { buildRegionalPlans } from './config/regional-plan-pricing'
import * as billingService from './services/billing.service'
import * as appleIap from './services/apple-iap.service'
import * as instanceService from './services/instance.service'
import * as storageService from './services/storage.service'
import * as nodeMetricsService from './services/node-metrics.service'
import * as affiliateService from './services/affiliate.service'
import {
  sendPlanUpgradedEmail,
  sendInvitationEmail,
  sendProjectInviteEmail,
  sendInviteAcceptedEmail,
  sendMemberJoinedEmail,
  sendMemberRemovedEmail,
  sendAccountDeletedEmail,
} from './services/email.service'
import { identifyUser, unsubscribeUser } from './services/loops.service'
import { getUnreadNotificationCount } from './services/notification.service'
import { notifyPaymentReceipt, notifyPaymentFailed } from './services/billing-alerts.service'
import { STRIPE_API_VERSION, resolveInvoiceSubscriptionId } from './lib/stripe-helpers'
import { proxyToPeer } from './lib/region-peer-proxy'
import { publishRoutes } from './routes/publish'
import { slackAgentRoutes } from './routes/slack-agent'
import { projectAdminRoutes } from './routes/project-admin'
import { publicApiRoutes } from './routes/public-api'
import { voiceRoutes } from './routes/voice'
import { adminRoutes, userAttributionRoute } from './routes/admin'
import { adminMarketplaceRoutes } from './routes/admin-marketplace'
import { licenseKeyAdminRoutes, licenseKeyRoutes } from './routes/license-keys'
import { affiliateRoutes } from './routes/affiliates'
import { marketplaceRoutes } from './routes/marketplace'
import { scopedAnalyticsRoutes } from './routes/scoped-analytics'
import { costAnalyticsRoutes } from './routes/cost-analytics'
import { integrationRoutes } from './routes/integrations'
import { evalOutputRoutes } from './routes/eval-outputs'
import { projectExportImportRoutes } from './routes/project-export-import'
import { evalAdminRoutes, evalInternalRoutes } from './routes/eval-admin'
import { cliAuthRoutes } from './routes/cli-auth'
import { instanceRoutes, authenticateInstanceWs, handleInstanceWsOpen, handleInstanceWsMessage, handleInstanceWsClose, startTunnelHeartbeat } from './routes/instances'
import { remoteAuditRoutes } from './routes/remote-audit'
import { mobilePushRoutes } from './routes/mobile-push'
import { appInstallRoutes } from './routes/app-installs'
import { syncRoutes } from './routes/sync'
import internalRoutes from './routes/internal'
import internalE2eRoutes from './routes/internal-e2e'
import { metalRoutes } from './routes/metal'
import { externalPreviewRoutes } from './routes/external-preview'
import { createAdminRoutes } from './generated/admin-routes'
import { adminModelCatalogRoutes } from './routes/admin-model-catalog'
import { checkRedisHealth, isTunnelRedisDegraded } from './lib/tunnel-redis'
import { INSTANCE_SIZES, INSTANCE_SIZE_ORDER, getInstanceDisplayPrice } from './config/instance-sizes'
import { saveAgentAvatar } from './services/workspace-agent-cloud-storage'
import { hydrateRepo } from './services/git-repo-store'

export {
  Stripe,
  getPriceId,
  getInstancePriceId,
  getCurrencyForCountry,
  formatPrice,
  SUPPORTED_CURRENCIES,
  getExchangeRates,
  convertPrice,
  buildRegionalPlans,
  billingService,
  appleIap,
  instanceService,
  storageService,
  nodeMetricsService,
  affiliateService,
  sendPlanUpgradedEmail,
  sendInvitationEmail,
  sendProjectInviteEmail,
  sendInviteAcceptedEmail,
  sendMemberJoinedEmail,
  sendMemberRemovedEmail,
  sendAccountDeletedEmail,
  identifyUser,
  unsubscribeUser,
  getUnreadNotificationCount,
  notifyPaymentReceipt,
  notifyPaymentFailed,
  STRIPE_API_VERSION,
  resolveInvoiceSubscriptionId,
  proxyToPeer,
  publishRoutes,
  slackAgentRoutes,
  projectAdminRoutes,
  publicApiRoutes,
  voiceRoutes,
  adminRoutes,
  userAttributionRoute,
  adminMarketplaceRoutes,
  licenseKeyAdminRoutes,
  licenseKeyRoutes,
  affiliateRoutes,
  marketplaceRoutes,
  scopedAnalyticsRoutes,
  costAnalyticsRoutes,
  integrationRoutes,
  evalOutputRoutes,
  projectExportImportRoutes,
  evalAdminRoutes,
  evalInternalRoutes,
  cliAuthRoutes,
  instanceRoutes,
  authenticateInstanceWs,
  handleInstanceWsOpen,
  handleInstanceWsMessage,
  handleInstanceWsClose,
  startTunnelHeartbeat,
  remoteAuditRoutes,
  mobilePushRoutes,
  appInstallRoutes,
  syncRoutes,
  internalRoutes,
  internalE2eRoutes,
  metalRoutes,
  externalPreviewRoutes,
  createAdminRoutes,
  adminModelCatalogRoutes,
  checkRedisHealth,
  isTunnelRedisDegraded,
  INSTANCE_SIZES,
  INSTANCE_SIZE_ORDER,
  getInstanceDisplayPrice,
  saveAgentAvatar,
  hydrateRepo,
}
