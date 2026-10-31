// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Better Auth Server Configuration
 * Task: task-ba-006, task-org-002
 *
 * Configures Better Auth with:
 * - PostgreSQL database via pg Pool from DATABASE_URL
 * - Uses Prisma-managed tables (users, sessions, accounts, verifications)
 * - Email/password authentication (no email verification required)
 * - JWT sessions with 7-day expiry
 * - Google OAuth social provider
 * - Trusted origins for CORS
 * - Database hooks for auto-creating personal workspace on signup
 */

import { betterAuth, type BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { expo } from "@better-auth/expo"
import { createDefaultTeamWorkspace, createPersonalWorkspace } from "./services/workspace.service"
import { sendWelcomeEmail, sendPasswordResetEmail, sendEmailVerificationEmail, identifyUser, trackEvent, resolveAttributionForUser } from "./services/auth-integrations"
import { evaluateAllowlist, recordSignIn } from "./services/project-auth-config.service"
import { prisma } from "./lib/prisma"
import { getFrontendUrl } from "./lib/cloud-urls"
import { homeRegionForNewUser } from "./lib/region"
import { E2E_BOOTSTRAP_HEADER, isE2eBootstrapRequest } from "./lib/e2e-bootstrap-secret"
import { isBlockedEmailDomain } from "./services/signup-risk-scoring"

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'
const LOAD_TEST_SECRET = process.env.LOAD_TEST_SECRET

/**
 * Signup provider for risk scoring. Google and Apple sign-ups arrive on the
 * OAuth callback (`/callback/:provider`, Apple form-posts there too) or an
 * ID-token sign-in (`/sign-in/social`). Anything else, including server-side
 * user creation with no request context, is scored as a credential signup so
 * it never earns the trusted-provider credit.
 */
export function signupProviderFromPath(path: string | undefined): 'credential' | 'social' {
  return path?.startsWith('/callback/') || path === '/sign-in/social' ? 'social' : 'credential'
}

function isLoadTestBypass(request: Request): boolean {
  return !!(LOAD_TEST_SECRET && request?.headers?.get?.('x-load-test-key') === LOAD_TEST_SECRET)
}

/**
 * Parse a single cookie value from a raw `Cookie:` header. Used by the
 * better-auth `user.create.after` hook to extract affiliate-attribution
 * cookies (`__shogo_ref` + `__shogo_ref_visitor`) without pulling in a
 * cookie-jar dependency.
 */
export function parseCookieHeader(header: string, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    if (k !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

// The app DB connection string. Prefer the Shogo-specific name (set by the
// desktop app) over the generic `DATABASE_URL` so Better Auth never resolves
// to whatever a project agent might leave in the ambient env. See
// apps/api/src/lib/prisma.ts (appDatabaseUrl) for the rationale.
function appDbUrl(): string | undefined {
  return process.env.SHOGO_APP_DATABASE_URL ?? process.env.DATABASE_URL
}

function getSqliteDbPath(): string {
  const url = appDbUrl()
  if (!url || url.startsWith('postgres')) return './shogo.db'
  return url.replace(/^file:/, '')
}

function createAuthDatabase() {
  if (isLocalMode) {
    const { Database } = require('bun:sqlite')
    const db = new Database(getSqliteDbPath())
    // Prisma writes through its own connection; wait out its lock instead of failing with SQLITE_BUSY.
    db.run('PRAGMA busy_timeout = 5000')
    return db
  }
  const { Pool } = require('pg')
  return new Pool({
    connectionString: appDbUrl(),
    max: parseInt(process.env.AUTH_POOL_SIZE || '60', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  })
}

const MAX_NAME_LENGTH = 100

/**
 * Sanitize a user-provided display name before it is stored.
 *
 * Defends against stored XSS *and* hyperlink/phishing injection (OWASP A03):
 * stored names are interpolated into transactional email bodies (e.g. the
 * welcome email), so a name like "https://evil.com" must not survive in a
 * clickable/auto-linkable form even though emails also HTML-encode values.
 *
 * - Strips HTML tags and stray angle brackets
 * - Removes URL schemes (http, https, javascript:, data:, etc.) and "www."
 * - Defangs bare "domain.tld" tokens so mail clients won't auto-link them
 * - Collapses whitespace and caps length
 */
function sanitizeName(name: string | undefined | null): string {
  if (!name) return ""
  return name
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/\b(?:https?|ftps?|mailto|javascript|data|vbscript|file):\/*/gi, "")
    .replace(/\bwww\./gi, "")
    .replace(/([a-z0-9-]+)\.(?=[a-z]{2,})/gi, "$1 ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
}

// Port configuration from environment
const API_PORT = process.env.API_PORT || "8002"
const VITE_PORT = process.env.VITE_PORT || "3000"

// Base URL for Better Auth - use BETTER_AUTH_URL in production, localhost in dev
// In dev with proxy setup, use VITE_PORT so OAuth callbacks route through the frontend proxy
const getBaseURL = (): string => {
  if (process.env.BETTER_AUTH_URL) {
    return process.env.BETTER_AUTH_URL
  }
  return `http://localhost:${VITE_PORT}`
}

// CORS origins from environment - supports comma-separated list
// Defaults to localhost for development
const getAllowedOrigins = (): string[] => {
  const envOrigins = process.env.ALLOWED_ORIGINS
  if (envOrigins) {
    return envOrigins.split(',').map(o => o.trim())
  }
  // Default: localhost only (dev mode) - use VITE_PORT since requests originate from frontend
  return [`http://localhost:${VITE_PORT}`]
}


/**
 * Better Auth plugin that enforces per-project sign-in allowlists for
 * SDK-driven auth. The Shogo SDK forwards `X-Shogo-Project-Id` on
 * `/sign-up/email` and `/sign-in/email` (see
 * `packages/sdk/src/http/client.ts`). When that header is present, we:
 *
 *   - Before-hook: load the project's `ProjectAuthConfig` and reject
 *     with a 403 / `project_auth_not_allowed` if the email is not
 *     allowed under the project's mode (`workspace` or `custom`).
 *
 *   - After-hook: stamp a `ProjectAuthSignIn` row on success so the
 *     project's owner can see the user list under Studio Settings ->
 *     Auth & Database.
 *
 * Requests without the header pass through unchanged — this preserves
 * the existing platform-Studio sign-in flow for users browsing
 * `studio.shogo.ai` directly.
 */
const PROJECT_ID_HEADER = "x-shogo-project-id"
const PROJECT_AUTH_ALLOWLIST_PATHS: readonly string[] = [
  "/sign-up/email",
  "/sign-in/email",
]

function projectAuthHeader(ctx: any): string | null {
  const fromHeaders = ctx?.headers?.get?.(PROJECT_ID_HEADER) as string | null | undefined
  if (fromHeaders) return fromHeaders
  return ctx?.request?.headers?.get?.(PROJECT_ID_HEADER) ?? null
}

const projectAuthPlugin: BetterAuthPlugin = {
  id: "shogo-project-auth-allowlist",
  hooks: {
    before: [
      {
        matcher(ctx) {
          return PROJECT_AUTH_ALLOWLIST_PATHS.some((p) => ctx.path === p)
        },
        handler: createAuthMiddleware(async (ctx) => {
          const projectId = projectAuthHeader(ctx)
          if (!projectId) return

          const email = (ctx.body as { email?: unknown })?.email
          if (typeof email !== "string" || !email) {
            // Let Better Auth's own validation produce the canonical
            // error for missing/invalid email — we only block when
            // the allowlist explicitly disallows.
            return
          }

          const verdict = await evaluateAllowlist(projectId, email)
          if (verdict.allowed) return

          const message =
            verdict.reason === "workspace_not_member"
              ? "This project is restricted to workspace members. Ask the project owner to invite you."
              : verdict.reason === "custom_not_listed"
                ? "This email is not on the project's allowlist. Ask the project owner to add you."
                : "Not allowed to sign in to this project."
          throw new APIError("FORBIDDEN", {
            code: "project_auth_not_allowed",
            message,
            reason: verdict.reason ?? "denied",
            projectId,
          })
        }),
      },
    ],
    after: [
      {
        matcher(ctx) {
          return PROJECT_AUTH_ALLOWLIST_PATHS.some((p) => ctx.path === p)
        },
        handler: createAuthMiddleware(async (ctx) => {
          const projectId = projectAuthHeader(ctx)
          if (!projectId) return

          const newSession = (ctx.context as { newSession?: { user?: { id?: string } } })
            ?.newSession
          const userId = newSession?.user?.id
          if (!userId) return

          try {
            await recordSignIn(projectId, userId)
          } catch (err) {
            console.error("[shogo-project-auth] recordSignIn failed", err)
          }
        }),
      },
    ],
  },
}

export const auth = betterAuth({
  // Base URL for OAuth callbacks - must match Google's authorized redirect URIs
  baseURL: getBaseURL(),

  database: createAuthDatabase(),

  // User model configuration - uses Prisma's users table
  user: {
    modelName: "users",
    fields: {
      emailVerified: "emailVerified",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    // Multi-region write-ownership: persist `homeRegion` on the users row.
    // `input: false` so it can never be set from the client — it is stamped
    // server-side in the user.create.before hook to the signing-up region.
    // Cloud-only: `schema.local.prisma` deliberately omits this column
    // (single-region desktop has no use for it — see check-schema-parity's
    // allow-list), so declaring it here for local mode makes Better Auth's
    // Kysely adapter try to INSERT a `homeRegion` value into a `users` table
    // that doesn't have that column, throwing `SQLiteError: table users has
    // no column named homeRegion` and silently failing the local auto-seed
    // (`[LocalMode] Failed to auto-seed user`) — no local user ever gets
    // created, so every session-dependent flow (onboarding completion,
    // /api/local/auto-sign-in) 401/503s forever and the user is bounced back
    // to sign-in on every restart.
    ...(isLocalMode
      ? {}
      : {
          additionalFields: {
            homeRegion: {
              type: "string",
              required: false,
              input: false,
            },
          },
        }),
  },

  // Session model configuration - uses Prisma's sessions table
  session: {
    modelName: "sessions",
    fields: {
      userId: "userId",
      expiresAt: "expiresAt",
      ipAddress: "ipAddress",
      userAgent: "userAgent",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    expiresIn: 60 * 60 * 24 * 30,
    cookieCache: {
      enabled: true,
      maxAge: 120,
    },
  },

  // Account model configuration - uses Prisma's accounts table
  account: {
    modelName: "accounts",
    fields: {
      userId: "userId",
      accountId: "accountId",
      providerId: "providerId",
      accessToken: "accessToken",
      refreshToken: "refreshToken",
      accessTokenExpiresAt: "accessTokenExpiresAt",
      refreshTokenExpiresAt: "refreshTokenExpiresAt",
      idToken: "idToken",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
    // Idempotent signup (multi-region split-brain prevention): when a user
    // signs in with a social provider whose verified email already belongs to
    // an existing account, link the new provider to that user instead of
    // minting a second `users` row. Same-email matching only links for the
    // trusted providers below (which return verified emails), avoiding the
    // account-takeover risk of linking unverified emails.
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "apple"],
      allowDifferentEmails: false,
    },
  },

  // Verification model configuration - uses Prisma's verifications table
  verification: {
    modelName: "verifications",
    fields: {
      expiresAt: "expiresAt",
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    },
  },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',
    sendResetPassword: async ({ user, url }: { user: { email: string; name?: string | null }; url: string }) => {
      const result = (await sendPasswordResetEmail({
        to: user.email,
        name: user.name ?? undefined,
        resetUrl: url,
      })) ?? { success: false, error: 'email integration unavailable' }
      const logResetLinkInConsole =
        !result.success &&
        (process.env.NODE_ENV !== 'production' || process.env.SHOGO_LOG_PASSWORD_RESET_URL === 'true')
      if (logResetLinkInConsole) {
        console.warn(
          `[Auth] Password reset email was not sent (${result.error ?? 'unknown'}). ` +
            'Configure email in .env (see EMAIL_PROVIDER / SMTP_* or SES). Dev-only reset link:\n' +
            url,
        )
      }
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }: { user: { email: string; name?: string | null }; url: string }) => {
      const result = (await sendEmailVerificationEmail({
        to: user.email,
        name: user.name ?? undefined,
        verifyUrl: url,
      })) ?? { success: false, error: 'email integration unavailable' }
      const logVerifyLinkInConsole =
        !result.success &&
        (process.env.NODE_ENV !== 'production' || process.env.SHOGO_LOG_EMAIL_VERIFICATION_URL === 'true')
      if (logVerifyLinkInConsole) {
        console.warn(
          `[Auth] Email verification email was not sent (${result.error ?? 'unknown'}). ` +
            'Configure email in .env (see EMAIL_PROVIDER / SMTP_* or SES). Dev-only verify link:\n' +
            url,
        )
      }
    },
    afterEmailVerification: async (user: { id: string }) => {
      if (isLocalMode) return
      // Release the held/remaining signup credit once the address is verified.
      // The risk re-score runs here, so the decision reflects accounts created
      // since signup. Best-effort: never fail the verification itself.
      try {
        // Lazy: keeps billing out of the auth module graph at startup.
        const { releaseSignupCreditOnVerification } = await import('./services/signup-credit.service')
        const outcome = await releaseSignupCreditOnVerification({ userId: user.id })
        if (outcome.released) {
          console.log(`[signup-credit] released $${outcome.amountUsd} for user ${user.id} (band ${outcome.band})`)
        }
      } catch (err) {
        console.error('[signup-credit] verification release failed', err)
      }
    },
  },

  socialProviders: isLocalMode ? {} : {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
    // Sign in with Apple — required by App Store Guideline 4.8 alongside
    // any third-party login. Native iOS clients use the ID-token flow:
    //   authClient.signIn.social({ provider: 'apple', idToken: { token, nonce } })
    // better-auth verifies the ID token against Apple's JWKS using the
    // bundle id below as the audience.
    //
    // The native ID-token path does NOT exchange an authorization code,
    // so it never uses `clientSecret`. The web/OAuth code-flow path does.
    // Previously this block required BOTH env vars to be present, which
    // silently disabled the entire apple provider on any environment that
    // didn't ship the .p8-signed ES256 secret — causing
    // `signIn.social({ provider: 'apple' })` to fail with
    // "provider not configured" and producing the App Review
    // Guideline 2.1(a) rejection in build 182. We now enable the
    // provider as long as we know the iOS audience (bundle id), and
    // only attach `clientSecret` when it's actually configured for the
    // web OAuth flow.
    //
    // APPLE_CLIENT_ID         = the Service ID (e.g. ai.shogo.web) for
    //                           web OAuth, OR the iOS bundle id
    //                           (ai.shogo.app) for native ID-token flow.
    //                           Defaults to the bundle id so the native
    //                           flow works without any env setup.
    // APPLE_CLIENT_SECRET     = ES256 JWT signed with the .p8 Sign in
    //                           with Apple key. Optional — only needed
    //                           for the web OAuth code-exchange path
    //                           (rotated via cron — Apple caps secret
    //                           lifetime at 6 months). Not used by the
    //                           native iOS idToken flow.
    // APPLE_APP_BUNDLE_ID     = audience accepted on ID-token
    //                           verification (defaults to ai.shogo.app,
    //                           matching apps/mobile/app.json).
    ...(!isLocalMode
      ? (() => {
          const bundleId = process.env.APPLE_APP_BUNDLE_ID || 'ai.shogo.app'
          const clientId = process.env.APPLE_CLIENT_ID || bundleId
          const clientSecret = process.env.APPLE_CLIENT_SECRET
          return {
            apple: {
              clientId,
              ...(clientSecret ? { clientSecret } : {}),
              appBundleIdentifier: bundleId,
            },
          }
        })()
      : {}),
  },

  trustedOrigins: (request) => {
    const baseURL = getBaseURL()
    const origins = [
      ...getAllowedOrigins(), baseURL,
      'https://eu.studio.shogo.ai',
      'shogo://', 'exp://',
    ]
    if (process.env.NODE_ENV !== 'production') {
      origins.push('http://localhost:8081')

      const reqOrigin = request?.headers?.get?.('origin')
      if (reqOrigin?.startsWith('http://localhost:') && !origins.includes(reqOrigin)) {
        origins.push(reqOrigin)
      }
      if (reqOrigin && /^http:\/\/192\.168\.\d+\.\d+/.test(reqOrigin) && !origins.includes(reqOrigin)) {
        origins.push(reqOrigin)
      }
    }
    return origins
  },

  plugins: [expo(), projectAuthPlugin],

  rateLimit: {
    window: 60,
    max: 1000,
    enabled: process.env.NODE_ENV === 'production',
    customRules: {
      "/sign-in/email": async (request) => {
        if (isLoadTestBypass(request)) return false
        return { window: 10, max: 3 }
      },
      "/sign-up/email": async (request) => {
        if (isLoadTestBypass(request)) return false
        return { window: 10, max: 3 }
      },
      "/sign-in/social": async (request) => {
        if (isLoadTestBypass(request)) return false
        return { window: 10, max: 5 }
      },
      "/sign-out": async (request) => {
        if (isLoadTestBypass(request)) return false
        return { window: 10, max: 10 }
      },
      "/get-session": async (request) => {
        if (isLoadTestBypass(request)) return false
        return { window: 10, max: 30 }
      },
    },
  },

  // Advanced configuration
  advanced: {
    // Client IP for signup risk scoring. Cloudflare sets cf-connecting-ip (the
    // real client); x-forwarded-for is the fallback for other ingress paths.
    ipAddress: {
      ipAddressHeaders: ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'],
    },
    database: {
      generateId: (options) => crypto.randomUUID(),
    },
    // Namespace our session cookie so user-built apps (which default to
    // better-auth's "better-auth.session_token") cannot stomp the platform
    // session when served on the same origin as the Studio (e.g. path-based
    // previews under /api/projects/:id/preview/...). See also the Set-Cookie
    // strip in the preview/agent-runtime proxies in server.ts.
    cookiePrefix: 'shogo',
  },

  // Database hooks for auto-creating personal workspace on user signup
  // Task: task-org-002
  databaseHooks: {
    user: {
      create: {
        /**
         * Before creating a user, sanitize the name to prevent stored XSS.
         * Strips any HTML tags and angle brackets from the name field.
         * In local mode, enforces a single-account limit.
         */
        before: async (user, ctx?: any) => {
          if (user.name) {
            user.name = sanitizeName(user.name)
          }
          if (isLocalMode) {
            // No `homeRegion` additionalField is registered for local mode
            // (see the `user` config above) and `schema.local.prisma` has no
            // such column — stamping it here would make the insert 500/throw
            // and silently break the single local-account auto-seed.
            const existingCount = await prisma.user.count()
            if (existingCount >= 1) {
              throw new Error('Local mode only supports a single account.')
            }
            return { data: user }
          }
          // Hard block for domains seen only in abuse farms (see
          // signup-risk-config BLOCKED_EMAIL_DOMAINS). The e2e bootstrap header is
          // honored only when the server has e2e bootstrap enabled.
          if (user.email && isBlockedEmailDomain(user.email)) {
            const reqHeaders = ctx?.request?.headers ?? ctx?.headers
            const e2e = isE2eBootstrapRequest(
              typeof reqHeaders?.get === 'function' ? reqHeaders.get(E2E_BOOTSTRAP_HEADER) : null,
            )
            if (!e2e) {
              throw new APIError('UNPROCESSABLE_ENTITY', {
                code: 'SIGNUP_BLOCKED',
                message:
                  "Please use a permanent email address — temporary inboxes can't be used to sign up.",
              })
            }
          }

          // Stamp the write-ownership home region for this identity to the
          // region the signup lands in. `input: false` on the additionalField
          // means a client can never override it.
          ;(user as { homeRegion?: string | null }).homeRegion = homeRegionForNewUser()

          // Idempotent signup (multi-region): if a user with this email already
          // exists — including a row that was just created in another region and
          // replicated here — do NOT insert a duplicate identity. Surface a
          // clean "account exists → sign in" error instead of letting the insert
          // hit the `users.email` unique constraint and bubble up as a 500.
          // This proactively handles the P2002 case before the write.
          //
          // Residual: a truly simultaneous (sub-second) same-email signup in two
          // regions can pass this check in both before either row replicates.
          // That rare case is still caught by the conflict watchdog + the
          // identity-merge runbook in prod-investigation/recovery/recon/. We do
          // NOT claim 100% prevention here.
          if (user.email) {
            try {
              const existing = await prisma.user.findFirst({
                where: { email: { equals: user.email, mode: 'insensitive' } },
                select: { id: true },
              })
              if (existing) {
                throw new APIError('UNPROCESSABLE_ENTITY', {
                  code: 'USER_ALREADY_EXISTS',
                  message: 'An account with this email already exists. Please sign in.',
                })
              }
            } catch (err) {
              // Re-throw our own clean error; swallow DB hiccups so a transient
              // lookup failure never blocks legitimate signups.
              if (err instanceof APIError) throw err
              console.warn('[auth] duplicate-email pre-check failed; proceeding', err)
            }
          }

          return { data: user }
        },
        /**
         * After a new user is created, automatically create their personal workspace.
         * This ensures every user has at least one workspace to work in immediately after signup.
         *
         * Uses Prisma-based workspace service.
         *
         * Errors are logged but do not block user creation (graceful degradation).
         */
        after: async (user, ctx?: any) => {
          // Signup attribution — written HERE, not by the client (SHO-258 §7).
          //
          // The app's client-side flush reads UTMs out of localStorage on the
          // wrong origin, which is why the table had 14 rows, all from March.
          // The cookie rides along with this POST, so read it here and derive
          // the tag before anything else can fail. Best-effort, and never able
          // to fail the signup: a new user with no UTMs is still a `direct` row,
          // which is a number we were missing entirely.
          try {
            const { recordSignupAttribution } = await import('./lib/signup-attribution')
            await recordSignupAttribution({
              userId: user.id,
              cookieHeader:
                ctx?.request?.headers?.get?.('cookie') ?? ctx?.headers?.get?.('cookie') ?? '',
              method: signupProviderFromPath(ctx?.path),
            })
          } catch (err) {
            console.warn('[Attribution] signup attribution on signup failed', err)
          }

          // Affiliate attribution — best-effort, swallow errors.
          //
          // The Cloudflare /r/:code Pages Function sets two first-party
          // cookies on the marketing site: `__shogo_ref_visitor` (a
          // UUID) and `__shogo_ref` (the affiliate code). They tag
          // along on the signup POST because the better-auth cookie
          // policy is SameSite=Lax (and the marketing site issues
          // them as first-party). We read both and call into the
          // affiliate service, which does the self-referral and
          // expiry checks. Feature-flag-gated so dev/test stacks
          // without the native rollout don't pay the DB roundtrip.
          if (process.env.SHOGO_AFFILIATES_NATIVE === 'true') {
            try {
              const cookieHeader =
                ctx?.request?.headers?.get?.('cookie') ||
                ctx?.headers?.get?.('cookie') ||
                ''
              const visitorId = parseCookieHeader(cookieHeader, '__shogo_ref_visitor')
              const code = parseCookieHeader(cookieHeader, '__shogo_ref')
              // Either signal is enough: the visitor cookie drives
              // click-based attribution, the code cookie drives the
              // direct code fallback (resolveAttributionForUser handles
              // both, including the case where only one is present).
              if (visitorId || code) {
                await resolveAttributionForUser(user.id, visitorId ?? null, code ?? null)
              }
            } catch (err) {
              console.error('[Affiliate] attribution on signup failed', err)
            }
          }

          // In local/desktop mode, every user is a super_admin
          if (isLocalMode) {
            try {
              await prisma.user.update({
                where: { id: user.id },
                data: { role: 'super_admin', emailVerified: true },
              })
              console.log(`[LocalMode] User ${user.email} promoted to super_admin`)
            } catch (err) {
              console.error(`[LocalMode] Failed to promote user:`, err)
            }
          }

          const createWithRetry = async (label: string, create: () => Promise<unknown>) => {
            const maxAttempts = 5
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              try {
                await create()
                console.log(`Created ${label} workspace for user ${user.email}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
                return
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                if (attempt < maxAttempts) {
                  const delay = attempt * 1000 + Math.random() * 500
                  console.warn(`Workspace creation attempt ${attempt}/${maxAttempts} failed for ${user.email}: ${msg} — retrying in ${Math.round(delay)}ms`)
                  await new Promise((r) => setTimeout(r, delay))
                } else {
                  console.error(`Failed to create ${label} workspace for ${user.email} after ${maxAttempts} attempts: ${msg}`)
                }
              }
            }
          }

          // Every cloud account starts with both spaces: Personal (companion)
          // and Team (where you build). Desktop stays single-workspace.
          // Independent, so run in parallel; allSettled keeps one failing
          // from blocking the other or the signup itself.
          await Promise.allSettled([
            createWithRetry('personal', () => createPersonalWorkspace(user.id, user.name || "User")),
            ...(!isLocalMode
              ? [createWithRetry('team', () => createDefaultTeamWorkspace(user.id, user.name || "User"))]
              : []),
          ])

          // Signup risk assessment + initial promo credit (cloud only). Runs after
          // the team workspace exists, since the credit lives on that wallet.
          // Best-effort: a failure here must never block the signup itself.
          if (!isLocalMode) {
            try {
              const { assessNewSignup } = await import('./services/signup-risk.service')
              const { applyInitialSignupCredit } = await import('./services/signup-credit.service')
              const risk = await assessNewSignup({
                userId: user.id,
                email: user.email,
                provider: signupProviderFromPath(ctx?.path),
                emailVerified: Boolean(user.emailVerified),
                headers: ctx?.request?.headers ?? ctx?.headers ?? null,
              })
              await applyInitialSignupCredit({ userId: user.id, result: risk })
              trackEvent(user.id, 'signup_risk_scored', {
                band: risk.band,
                decision: risk.decision,
                score: risk.score,
              }).catch(() => {})
            } catch (err) {
              console.error(`[signup-risk] assessment failed for ${user.email}`, err)
            }
          }

          // FIRE-AND-FORGET: Send welcome email (non-blocking)
          const baseUrl = getFrontendUrl()
          sendWelcomeEmail({
            to: user.email,
            name: user.name || 'User',
            loginUrl: `${baseUrl}/sign-in`
          }).catch((err: unknown) => {
            console.error(`Welcome email failed for ${user.email}:`, err)
          })

          // FIRE-AND-FORGET: Upsert contact in Loops and fire signup event
          identifyUser(user.id, {
            email: user.email,
            firstName: user.name?.split(' ')[0] || undefined,
            lastName: user.name?.split(' ').slice(1).join(' ') || undefined,
            plan: 'free',
            createdAt: new Date().toISOString(),
          }).catch((err: unknown) => console.error('[Loops] identify failed:', err))
          trackEvent(user.id, 'signup', { email: user.email }).catch((err: unknown) =>
            console.error('[Loops] signup event failed:', err)
          )
        },
      },
      update: {
        /**
         * Before updating a user, sanitize the name to prevent stored XSS.
         * This covers profile name changes via settings pages.
         */
        before: async (user) => {
          if (user.name) {
            user.name = sanitizeName(user.name)
          }
          return { data: user }
        },
      },
    },
  },
})

// Export the Auth type for use in route handlers
export type Auth = typeof auth
