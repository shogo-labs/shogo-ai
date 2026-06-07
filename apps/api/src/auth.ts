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
import { createPersonalWorkspace } from "./services/workspace.service"
import { sendWelcomeEmail, sendPasswordResetEmail, sendEmailVerificationEmail } from "./services/email.service"
import { resolveAttributionForUser } from "./services/affiliate.service"
import { evaluateAllowlist, recordSignIn } from "./services/project-auth-config.service"
import { prisma } from "./lib/prisma"
import { getFrontendUrl } from "./lib/cloud-urls"

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'
const LOAD_TEST_SECRET = process.env.LOAD_TEST_SECRET

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
    return new Database(getSqliteDbPath())
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
      const result = await sendPasswordResetEmail({
        to: user.email,
        name: user.name ?? undefined,
        resetUrl: url,
      })
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
      const result = await sendEmailVerificationEmail({
        to: user.email,
        name: user.name ?? undefined,
        verifyUrl: url,
      })
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
      'https://eu.studio.shogo.ai', 'https://india.studio.shogo.ai',
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
        before: async (user) => {
          if (user.name) {
            user.name = sanitizeName(user.name)
          }
          if (isLocalMode) {
            const existingCount = await prisma.user.count()
            if (existingCount >= 1) {
              throw new Error('Local mode only supports a single account.')
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

          const maxAttempts = 5
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              await createPersonalWorkspace(user.id, user.name || "User")
              console.log(`Created personal workspace for user ${user.email}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
              break
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error)
              if (attempt < maxAttempts) {
                const delay = attempt * 1000 + Math.random() * 500
                console.warn(`Workspace creation attempt ${attempt}/${maxAttempts} failed for ${user.email}: ${msg} — retrying in ${Math.round(delay)}ms`)
                await new Promise((r) => setTimeout(r, delay))
              } else {
                console.error(`Failed to create personal workspace for ${user.email} after ${maxAttempts} attempts: ${msg}`)
              }
            }
          }

          // FIRE-AND-FORGET: Send welcome email (non-blocking)
          const baseUrl = getFrontendUrl()
          sendWelcomeEmail({
            to: user.email,
            name: user.name || 'User',
            loginUrl: `${baseUrl}/sign-in`
          }).catch((err) => {
            console.error(`Welcome email failed for ${user.email}:`, err)
          })
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
