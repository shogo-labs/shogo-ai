// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Security Scanning API Routes
 *
 * Provides automated security analysis of project source code.
 * Scans for common vulnerabilities like XSS, SQL injection,
 * exposed secrets, insecure dependencies, and more.
 *
 * Endpoints:
 * - POST /projects/:projectId/security/scan - Run security scan on project files
 */

import { Hono } from "hono"
import { readdir, readFile, stat } from "fs/promises"
import { join, relative, extname } from "path"
import { existsSync } from "fs"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

// ============================================================================
// Types
// ============================================================================

/** Severity levels for security findings */
export type Severity = "critical" | "high" | "medium" | "low" | "info"

/** A single security finding */
export interface SecurityFinding {
  /** Unique identifier for this finding */
  id: string
  /** Human-readable title */
  title: string
  /** Severity level */
  severity: Severity
  /** Category of vulnerability */
  category: string
  /** Detailed description of the issue */
  description: string
  /** File where the issue was found */
  file: string
  /** Line number (1-based) */
  line: number
  /** The offending code snippet */
  snippet: string
  /** Suggested fix or remediation */
  recommendation: string
}

/** Summary of scan results */
export interface ScanSummary {
  /** Total findings */
  total: number
  /** Count by severity */
  critical: number
  high: number
  medium: number
  low: number
  info: number
  /** Number of files scanned */
  filesScanned: number
  /** Duration in milliseconds */
  durationMs: number
  /** Whether AI-powered analysis was included */
  aiAnalysis: boolean
  /** Number of dependencies with known vulnerabilities */
  vulnerableDeps: number
}

/** Full scan result */
export interface ScanResult {
  ok: boolean
  findings: SecurityFinding[]
  summary: ScanSummary
}

// ============================================================================
// Security Rules
// ============================================================================

interface SecurityRule {
  id: string
  title: string
  severity: Severity
  category: string
  description: string
  recommendation: string
  /** Regex pattern to match against file content (applied per-line) */
  pattern: RegExp
  /** File extensions to apply this rule to (empty = all) */
  fileExtensions?: string[]
  /** File names/paths to exclude from this rule */
  excludePaths?: RegExp[]
}

const SECURITY_RULES: SecurityRule[] = [
  // ─── CRITICAL: Exposed Secrets ─────────────────────────────────────
  {
    id: "SEC001",
    title: "Hardcoded API Key or Secret",
    severity: "critical",
    category: "Secrets",
    description:
      "An API key, secret, or token appears to be hardcoded in the source code. This can lead to unauthorized access if the code is exposed.",
    recommendation:
      "Move secrets to environment variables (e.g., import.meta.env.VITE_API_KEY or process.env.API_KEY) and never commit them to source control.",
    pattern:
      /(?:api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*['"`](?!import\.meta\.env|process\.env)[A-Za-z0-9+/=_\-]{16,}['"`]/i,
    fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".env"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./, /\.example/],
  },
  {
    id: "SEC002",
    title: "AWS Credentials Exposed",
    severity: "critical",
    category: "Secrets",
    description:
      "AWS access key ID or secret access key found in source code.",
    recommendation:
      "Use IAM roles, environment variables, or AWS credentials file instead of hardcoding credentials.",
    pattern:
      /(?:AKIA[0-9A-Z]{16}|aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*['"`][A-Za-z0-9+/=]{30,}['"`])/i,
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./],
  },
  {
    id: "SEC003",
    title: "Private Key in Source",
    severity: "critical",
    category: "Secrets",
    description:
      "A private key (RSA, SSH, PGP) was found embedded in the source code.",
    recommendation:
      "Store private keys in secure vaults or environment-specific configuration, never in source code.",
    pattern:
      /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----/,
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./],
  },
  {
    id: "SEC004",
    title: "Hardcoded Password",
    severity: "critical",
    category: "Secrets",
    description:
      "A password appears to be hardcoded in the source code.",
    recommendation:
      "Use environment variables or a secrets manager for passwords. Never hardcode credentials.",
    pattern:
      /(?:password|passwd|pwd)\s*[:=]\s*['"`](?!import\.meta\.env|process\.env|<|{|\$)[^\s'"`]{6,}['"`]/i,
    fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./, /\.example/, /schema\.prisma/],
  },

  // ─── HIGH: XSS Vulnerabilities ─────────────────────────────────────
  {
    id: "SEC010",
    title: "Dangerous HTML Injection (dangerouslySetInnerHTML)",
    severity: "high",
    category: "XSS",
    description:
      "Using dangerouslySetInnerHTML can introduce Cross-Site Scripting (XSS) vulnerabilities if the HTML content is not properly sanitized.",
    recommendation:
      "Sanitize HTML input using a library like DOMPurify before rendering. Consider using safe alternatives like markdown rendering.",
    pattern: /dangerouslySetInnerHTML/,
    fileExtensions: [".tsx", ".jsx"],
    excludePaths: [/node_modules/],
  },
  {
    id: "SEC011",
    title: "Unsafe eval() Usage",
    severity: "high",
    category: "XSS",
    description:
      "Using eval() or Function() constructor to execute dynamic strings can lead to code injection attacks.",
    recommendation:
      "Avoid eval() entirely. Use JSON.parse() for data, or safer alternatives for dynamic execution.",
    pattern:
      /\b(?:eval|new\s+Function)\s*\(/,
    fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
    excludePaths: [/node_modules/, /vite\.config/, /webpack\.config/],
  },
  {
    id: "SEC012",
    title: "Unescaped URL in href/src",
    severity: "medium",
    category: "XSS",
    description:
      "Dynamic URLs used in href or src attributes without validation could lead to javascript: protocol injection.",
    recommendation:
      "Validate that URLs start with https:// or / before using them in href/src. Block javascript: protocol.",
    pattern:
      /(?:href|src)\s*=\s*\{(?!['"`]https?:\/\/)(?!['"`]\/)[^}]*\}/,
    fileExtensions: [".tsx", ".jsx"],
    excludePaths: [/node_modules/],
  },
  {
    id: "SEC013",
    title: "document.write() Usage",
    severity: "high",
    category: "XSS",
    description:
      "document.write() can be exploited for DOM-based XSS attacks.",
    recommendation:
      "Use safer DOM manipulation methods like textContent, createElement, or React rendering.",
    pattern: /document\.write\s*\(/,
    fileExtensions: [".ts", ".tsx", ".js", ".jsx"],
    excludePaths: [/node_modules/],
  },
  {
    id: "SEC014",
    title: "innerHTML Assignment",
    severity: "high",
    category: "XSS",
    description:
      "Directly setting innerHTML with user-controlled data can lead to XSS vulnerabilities.",
    recommendation:
      "Use textContent for plain text, or sanitize HTML with DOMPurify before using innerHTML.",
    pattern: /\.innerHTML\s*=\s*(?!['"`]<)/,
    fileExtensions: [".ts", ".tsx", ".js", ".jsx"],
    excludePaths: [/node_modules/],
  },

  // ─── HIGH: SQL Injection ───────────────────────────────────────────
  {
    id: "SEC020",
    title: "Potential SQL Injection",
    severity: "high",
    category: "SQL Injection",
    description:
      "String concatenation or template literals used in SQL queries can lead to SQL injection attacks.",
    recommendation:
      "Use parameterized queries or an ORM like Prisma. Never concatenate user input into SQL strings.",
    pattern:
      /(?:\$queryRaw|\.query|\.execute)\s*\(\s*`[^`]*\$\{/,
    fileExtensions: [".ts", ".js", ".mjs"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./, /migration/],
  },
  {
    id: "SEC021",
    title: "Raw SQL Query with String Concatenation",
    severity: "high",
    category: "SQL Injection",
    description:
      "Building SQL queries by concatenating strings is vulnerable to SQL injection.",
    recommendation:
      "Use parameterized queries (prepared statements) or an ORM.",
    pattern:
      /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.*['"`]\s*\+/i,
    fileExtensions: [".ts", ".js", ".mjs"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./, /migration/],
  },

  // ─── MEDIUM: Authentication & Authorization ────────────────────────
  {
    id: "SEC030",
    title: "JWT Secret Hardcoded",
    severity: "high",
    category: "Authentication",
    description:
      "JWT signing secret appears to be hardcoded instead of loaded from environment.",
    recommendation:
      "Load JWT secrets from environment variables: process.env.JWT_SECRET",
    pattern:
      /(?:jwt|token).*(?:secret|key)\s*[:=]\s*['"`](?!process\.env|import\.meta)[^'"`]{8,}['"`]/i,
    fileExtensions: [".ts", ".js", ".mjs"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./],
  },
  {
    id: "SEC031",
    title: "Missing Authentication Check",
    severity: "medium",
    category: "Authentication",
    description:
      "API route handler does not appear to check authentication. Public endpoints should be explicitly documented.",
    recommendation:
      "Add authentication middleware (e.g., requireAuth) to protect this endpoint, or document why it's intentionally public.",
    pattern:
      /app\.(?:get|post|put|patch|delete)\s*\(\s*['"`]\/api\//,
    fileExtensions: [".ts", ".js"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./, /auth\.ts/, /middleware/],
  },

  // ─── MEDIUM: Insecure Configuration ────────────────────────────────
  {
    id: "SEC040",
    title: "CORS Allow All Origins",
    severity: "medium",
    category: "Configuration",
    description:
      "CORS is configured to allow all origins (*), which permits any website to make requests to your API.",
    recommendation:
      "Restrict CORS to specific allowed origins in production. Use environment-based configuration.",
    pattern:
      /(?:cors|Access-Control-Allow-Origin).*\*/,
    fileExtensions: [".ts", ".js", ".mjs"],
    excludePaths: [/node_modules/, /\.test\./],
  },
  {
    id: "SEC041",
    title: "HTTP Used Instead of HTTPS",
    severity: "medium",
    category: "Configuration",
    description:
      "An HTTP URL (non-HTTPS) is used for an API endpoint or external service. Data sent over HTTP is not encrypted.",
    recommendation:
      "Use HTTPS for all external API calls and service connections.",
    pattern:
      /['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[0-1]\.|192\.168\.)/,
    fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./, /\.dev\./],
  },
  {
    id: "SEC042",
    title: "Debug/Development Mode in Production Code",
    severity: "low",
    category: "Configuration",
    description:
      "Debug flags or development-only configurations found that should not be in production.",
    recommendation:
      "Use environment variables to control debug settings. Ensure debug is disabled in production builds.",
    pattern:
      /(?:debug|verbose|devMode)\s*[:=]\s*true/i,
    fileExtensions: [".ts", ".js", ".mjs"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./, /\.config\./],
  },

  // ─── MEDIUM: Input Validation ──────────────────────────────────────
  {
    id: "SEC050",
    title: "Missing Input Validation on Request Body",
    severity: "medium",
    category: "Input Validation",
    description:
      "Request body is accessed directly without validation or schema checking.",
    recommendation:
      "Validate request bodies using Zod, Joi, or similar schema validation libraries before processing.",
    pattern:
      /(?:req\.body|c\.req\.json\(\)|request\.json\(\))\s*(?:;|\n)/,
    fileExtensions: [".ts", ".js"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./],
  },

  // ─── LOW: Information Disclosure ───────────────────────────────────
  {
    id: "SEC060",
    title: "Sensitive Error Details Exposed",
    severity: "low",
    category: "Information Disclosure",
    description:
      "Stack traces or detailed error information may be exposed to clients, revealing internal implementation details.",
    recommendation:
      "Log detailed errors server-side but return generic error messages to clients in production.",
    pattern:
      /(?:err|error)\.stack/,
    fileExtensions: [".ts", ".js"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./],
  },
  // NOTE: console.log rule removed — too noisy for most projects.

  // ─── MEDIUM: Insecure Dependencies ─────────────────────────────────
  {
    id: "SEC070",
    title: "Disabled SSL/TLS Verification",
    severity: "high",
    category: "Network Security",
    description:
      "SSL/TLS certificate verification is disabled, making the connection vulnerable to man-in-the-middle attacks.",
    recommendation:
      "Never disable SSL verification in production. Fix certificate issues instead.",
    pattern:
      /(?:rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"`]0['"`]|strictSSL\s*:\s*false)/,
    fileExtensions: [".ts", ".js", ".mjs"],
    excludePaths: [/node_modules/, /\.test\./],
  },

  // ─── MEDIUM: Path Traversal ────────────────────────────────────────
  {
    id: "SEC080",
    title: "Potential Path Traversal",
    severity: "high",
    category: "Path Traversal",
    description:
      "File path is constructed from user input without sufficient validation, potentially allowing directory traversal attacks.",
    recommendation:
      "Validate and sanitize file paths. Use path.resolve() and verify the resolved path is within the expected directory.",
    pattern:
      /(?:readFile|writeFile|createReadStream|createWriteStream|readdir)\s*\(\s*(?:req\.|c\.req\.|request\.|params\.)/,
    fileExtensions: [".ts", ".js"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./],
  },

  // ─── INFO: Security Best Practices ─────────────────────────────────
  {
    id: "SEC090",
    title: "TODO/FIXME Security Comment",
    severity: "info",
    category: "Code Quality",
    description:
      "A TODO or FIXME comment mentions security, suggesting a known security issue that hasn't been addressed.",
    recommendation:
      "Review and address security-related TODO/FIXME comments.",
    pattern:
      /(?:TODO|FIXME|HACK|XXX).*(?:security|auth|vulnerability|vuln|cve|exploit|inject)/i,
    fileExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
    excludePaths: [/node_modules/],
  },

  // ─── MEDIUM: Crypto ────────────────────────────────────────────────
  {
    id: "SEC100",
    title: "Weak Cryptographic Algorithm",
    severity: "medium",
    category: "Cryptography",
    description:
      "Using MD5 or SHA1 for hashing is considered cryptographically weak.",
    recommendation:
      "Use SHA-256 or bcrypt for password hashing. Use SHA-256+ for data integrity.",
    pattern:
      /(?:createHash|crypto\.subtle\.digest)\s*\(\s*['"`](?:md5|sha1)['"`]/i,
    fileExtensions: [".ts", ".js", ".mjs"],
    excludePaths: [/node_modules/, /\.test\./, /\.spec\./],
  },
]

// ============================================================================
// File scanning
// ============================================================================

/** File extensions to scan */
const SCANNABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs",
  ".json", ".env", ".yaml", ".yml",
])

/** Directories to skip */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next",
  ".cache", "coverage", "test-results",
])

/** Max file size to scan (500KB) */
const MAX_FILE_SIZE = 500 * 1024

/**
 * Recursively find all scannable files in a directory.
 */
async function findFiles(
  dir: string,
  baseDir: string,
  files: string[] = []
): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await findFiles(fullPath, baseDir, files)
        }
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase()
        if (SCANNABLE_EXTENSIONS.has(ext)) {
          // Check file size
          try {
            const fileStat = await stat(fullPath)
            if (fileStat.size <= MAX_FILE_SIZE) {
              files.push(relative(baseDir, fullPath))
            }
          } catch {
            // Skip files we can't stat
          }
        }
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return files
}

/**
 * Scan a single file against all applicable rules.
 */
async function scanFile(
  filePath: string,
  projectDir: string
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = []
  const fullPath = join(projectDir, filePath)
  const ext = extname(filePath).toLowerCase()

  let content: string
  try {
    content = await readFile(fullPath, "utf-8")
  } catch {
    return findings
  }

  const lines = content.split("\n")

  for (const rule of SECURITY_RULES) {
    // Check file extension filter
    if (rule.fileExtensions && rule.fileExtensions.length > 0) {
      if (!rule.fileExtensions.includes(ext)) continue
    }

    // Check path exclusions
    if (rule.excludePaths) {
      const excluded = rule.excludePaths.some((re) => re.test(filePath))
      if (excluded) continue
    }

    // Scan each line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (rule.pattern.test(line)) {
        findings.push({
          id: `${rule.id}-${filePath}-${i + 1}`,
          title: rule.title,
          severity: rule.severity,
          category: rule.category,
          description: rule.description,
          file: filePath,
          line: i + 1,
          snippet: line.trim().substring(0, 200),
          recommendation: rule.recommendation,
        })
      }
    }
  }

  return findings
}

/**
 * Special scan for package.json to check for known insecure patterns.
 */
async function scanPackageJson(
  projectDir: string
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = []
  const pkgPath = join(projectDir, "package.json")

  try {
    const content = await readFile(pkgPath, "utf-8")
    const pkg = JSON.parse(content)
    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }

    // Check for * version ranges (accept any version)
    for (const [name, version] of Object.entries(allDeps)) {
      if (version === "*" || version === "latest") {
        findings.push({
          id: `SEC071-${name}`,
          title: "Unpinned Dependency Version",
          severity: "medium",
          category: "Dependencies",
          description: `Dependency "${name}" uses version "${version}", which could introduce breaking changes or vulnerabilities.`,
          file: "package.json",
          line: 1,
          snippet: `"${name}": "${version}"`,
          recommendation:
            "Pin dependencies to specific versions or use semver ranges (e.g., ^1.2.3) instead of * or latest.",
        })
      }
    }

    // Check for postinstall scripts (potential supply chain risk)
    if (pkg.scripts?.postinstall || pkg.scripts?.preinstall) {
      findings.push({
        id: "SEC072-scripts",
        title: "Install Hook Scripts",
        severity: "info",
        category: "Dependencies",
        description:
          "Package has preinstall/postinstall scripts that run automatically during npm/yarn/bun install. Verify these are safe.",
        file: "package.json",
        line: 1,
        snippet: `scripts: { ${pkg.scripts.preinstall ? "preinstall: ..." : ""} ${pkg.scripts.postinstall ? "postinstall: ..." : ""} }`,
        recommendation:
          "Review install hook scripts to ensure they're safe and necessary.",
      })
    }
  } catch {
    // No package.json or parse error — skip
  }

  return findings
}

/**
 * Scan for .env files that might be committed.
 */
async function scanEnvFiles(
  projectDir: string
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = []
  const envFiles = [".env", ".env.local", ".env.production", ".env.staging"]

  for (const envFile of envFiles) {
    const envPath = join(projectDir, envFile)
    if (existsSync(envPath)) {
      try {
        const content = await readFile(envPath, "utf-8")
        const lines = content.split("\n")

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim()
          if (!line || line.startsWith("#")) continue

          // Check for sensitive-looking values
          const match = line.match(
            /^(.*(?:SECRET|PASSWORD|KEY|TOKEN|PRIVATE|CREDENTIAL|AUTH).*)=(.+)$/i
          )
          if (match) {
            const value = match[2].trim()
            // Skip placeholder values
            if (
              value === "" ||
              value === '""' ||
              value === "''" ||
              value.startsWith("${") ||
              value === "your-" ||
              value === "change-me" ||
              value === "xxx"
            ) {
              continue
            }

            findings.push({
              id: `SEC005-${envFile}-${i + 1}`,
              title: "Sensitive Value in Environment File",
              severity: "high",
              category: "Secrets",
              description: `Environment file "${envFile}" contains a potentially sensitive value. Ensure this file is in .gitignore.`,
              file: envFile,
              line: i + 1,
              snippet: `${match[1]}=***REDACTED***`,
              recommendation:
                "Ensure .env files are listed in .gitignore. Use a secrets manager for production credentials.",
            })
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Check if .gitignore includes .env
  const gitignorePath = join(projectDir, ".gitignore")
  if (existsSync(gitignorePath)) {
    try {
      const content = await readFile(gitignorePath, "utf-8")
      if (!content.includes(".env")) {
        findings.push({
          id: "SEC006-gitignore",
          title: ".env Files Not in .gitignore",
          severity: "high",
          category: "Secrets",
          description:
            ".gitignore does not include .env files, which means secrets could be committed to version control.",
          file: ".gitignore",
          line: 1,
          snippet: "(missing .env entry)",
          recommendation:
            'Add ".env*" or ".env.local" to your .gitignore file.',
        })
      }
    } catch {
      // Skip
    }
  }

  return findings
}

// ============================================================================
// Dependency Audit (npm audit / CVE checking)
// ============================================================================

/**
 * Run `npm audit` (or parse bun audit) to find dependencies with known CVEs.
 * Falls back gracefully if npm is not available or no lockfile exists.
 */
async function auditDependencies(
  projectDir: string
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = []

  // Need either package-lock.json (npm) or bun.lock or yarn.lock
  const hasNpmLock = existsSync(join(projectDir, "package-lock.json"))
  const hasBunLock = existsSync(join(projectDir, "bun.lock")) || existsSync(join(projectDir, "bun.lockb"))
  const hasPkgJson = existsSync(join(projectDir, "package.json"))

  if (!hasPkgJson) return findings

  try {
    // Try npm audit first (works with package-lock.json, or --package-lock-only)
    let auditJson: any = null

    if (hasNpmLock || !hasBunLock) {
      try {
        const { stdout } = await execAsync(
          "npm audit --json --audit-level=low 2>/dev/null || true",
          { cwd: projectDir, timeout: 30000 }
        )
        auditJson = JSON.parse(stdout)
      } catch {
        // npm audit failed — try with --package-lock-only
        try {
          const { stdout } = await execAsync(
            "npm audit --json --package-lock-only 2>/dev/null || true",
            { cwd: projectDir, timeout: 30000 }
          )
          auditJson = JSON.parse(stdout)
        } catch {
          // npm audit not available
        }
      }
    }

    if (auditJson?.vulnerabilities) {
      // npm audit v7+ format: { vulnerabilities: { [name]: { severity, via, range, ... } } }
      for (const [name, vuln] of Object.entries<any>(auditJson.vulnerabilities)) {
        const severity = mapNpmSeverity(vuln.severity)
        const title =
          Array.isArray(vuln.via) && vuln.via[0]?.title
            ? vuln.via[0].title
            : `Known vulnerability in ${name}`
        const url =
          Array.isArray(vuln.via) && vuln.via[0]?.url
            ? vuln.via[0].url
            : ""

        findings.push({
          id: `DEP-${name}`,
          title: `Vulnerable Dependency: ${name}`,
          severity,
          category: "Dependencies",
          description: `${title}. ${url ? `More info: ${url}` : ""}`,
          file: "package.json",
          line: 1,
          snippet: `"${name}": "${vuln.range || "?"}"`,
          recommendation: vuln.fixAvailable
            ? `Update to a fixed version: npm audit fix, or manually update ${name}.`
            : `No fix available yet. Consider finding an alternative package.`,
        })
      }
    }
  } catch {
    // Audit completely failed — skip silently
  }

  return findings
}

/** Map npm audit severity strings to our Severity type */
function mapNpmSeverity(npmSev: string): Severity {
  switch (npmSev) {
    case "critical":
      return "critical"
    case "high":
      return "high"
    case "moderate":
      return "medium"
    case "low":
      return "low"
    case "info":
      return "info"
    default:
      return "medium"
  }
}

// ============================================================================
// LLM-Powered Code Analysis
// ============================================================================

/**
 * Use an LLM (Claude) to perform semantic security analysis on key project files.
 * This catches issues that regex patterns cannot: logic flaws, auth gaps, etc.
 * Returns findings or empty array if LLM is not available.
 */
async function llmSecurityAnalysis(
  projectDir: string,
  files: string[]
): Promise<SecurityFinding[]> {
  const findings: SecurityFinding[] = []

  // Only run if ANTHROPIC_API_KEY is configured
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return findings

  try {
    // Collect key files for analysis (max ~30KB to stay within token limits)
    // Prioritize server files, auth files, API routes, env configs
    const priorityPatterns = [
      /server\.(ts|js)$/,
      /auth\.(ts|js)$/,
      /middleware/,
      /route/,
      /api\//,
      /\.env/,
      /config/,
      /prisma/,
      /App\.(tsx|jsx)$/,
    ]

    const priorityFiles: string[] = []
    const otherFiles: string[] = []

    for (const file of files) {
      if (priorityPatterns.some((p) => p.test(file))) {
        priorityFiles.push(file)
      } else {
        otherFiles.push(file)
      }
    }

    // Take priority files first, then fill up with others
    const filesToAnalyze = [...priorityFiles, ...otherFiles].slice(0, 15)

    // Read file contents (limit each to 2KB)
    let codeContext = ""
    for (const file of filesToAnalyze) {
      try {
        const content = await readFile(join(projectDir, file), "utf-8")
        const trimmed = content.substring(0, 2000)
        codeContext += `\n--- ${file} ---\n${trimmed}\n`
      } catch {
        // Skip unreadable files
      }
    }

    if (!codeContext.trim()) return findings

    // Call Anthropic API directly (non-streaming, fast)
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-haiku-latest",
        max_tokens: 2048,
        system: `You are a security auditor. Analyze the provided source code files and identify security vulnerabilities.

Return ONLY a JSON array of findings. Each finding must have:
- "title": short title (string)
- "severity": one of "critical", "high", "medium", "low", "info"  
- "category": category name (string)
- "description": what the issue is (string)
- "file": which file (string)
- "line": approximate line number (number, use 1 if unsure)
- "snippet": the relevant code (string, max 100 chars)
- "recommendation": how to fix (string)

Focus on:
1. Authentication/authorization gaps (missing auth checks on routes)
2. Business logic flaws (e.g., no rate limiting, price manipulation)
3. Data exposure (sensitive data in responses, logs)
4. Missing input validation
5. Insecure defaults

Do NOT flag: console.log, TypeScript style issues, missing types.
If no issues found, return an empty array: []
Return ONLY the JSON array, no markdown, no explanation.`,
        messages: [
          {
            role: "user",
            content: `Analyze these project files for security vulnerabilities:\n${codeContext}`,
          },
        ],
      }),
    })

    if (!response.ok) return findings

    const data = await response.json()
    const text = data?.content?.[0]?.text || ""

    // Parse the JSON array from the LLM response
    try {
      // Try direct parse first, then extract from markdown code block
      let parsed: any[]
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0])
      } else {
        parsed = JSON.parse(text)
      }

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.title && item.severity && item.description) {
            findings.push({
              id: `AI-${item.file || "unknown"}-${item.line || 1}`,
              title: item.title,
              severity: ["critical", "high", "medium", "low", "info"].includes(item.severity)
                ? item.severity
                : "medium",
              category: item.category || "AI Analysis",
              description: item.description,
              file: item.file || "unknown",
              line: item.line || 1,
              snippet: (item.snippet || "").substring(0, 200),
              recommendation: item.recommendation || "Review this code for security issues.",
            })
          }
        }
      }
    } catch {
      // LLM returned non-parseable response — skip
    }
  } catch {
    // LLM call failed — skip silently (feature is best-effort)
  }

  return findings
}

// ============================================================================
// Route Configuration
// ============================================================================

export interface SecurityRoutesConfig {
  /** Directory containing project workspaces */
  workspacesDir: string
}

/**
 * Create security scanning routes.
 */
export function securityRoutes(config: SecurityRoutesConfig) {
  const { workspacesDir } = config
  const router = new Hono()

  /**
   * POST /projects/:projectId/security/scan
   *
   * Run a comprehensive security scan on the project's source code.
   *
   * Response: ScanResult
   */
  router.post("/projects/:projectId/security/scan", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    // Verify project directory exists
    if (!existsSync(projectDir)) {
      return c.json(
        {
          ok: false,
          error: {
            code: "project_not_found",
            message: "Project directory not found. The project may still be initializing.",
          },
        },
        404
      )
    }

    const startTime = Date.now()

    try {
      // 1. Find all scannable files
      const files = await findFiles(projectDir, projectDir)

      // 2. Scan each file in parallel (batch of 20)
      const allFindings: SecurityFinding[] = []
      const batchSize = 20

      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize)
        const batchResults = await Promise.all(
          batch.map((file) => scanFile(file, projectDir))
        )
        for (const findings of batchResults) {
          allFindings.push(...findings)
        }
      }

      // 3. Run special scans
      const pkgFindings = await scanPackageJson(projectDir)
      allFindings.push(...pkgFindings)

      const envFindings = await scanEnvFiles(projectDir)
      allFindings.push(...envFindings)

      // 4. Dependency audit (npm audit / CVE database)
      const depFindings = await auditDependencies(projectDir)
      allFindings.push(...depFindings)

      // 5. LLM-powered semantic analysis (best-effort, non-blocking)
      const aiFindings = await llmSecurityAnalysis(projectDir, files)
      allFindings.push(...aiFindings)

      // 6. Sort by severity (critical first)
      const severityOrder: Record<Severity, number> = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
        info: 4,
      }
      allFindings.sort(
        (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
      )

      // 7. Build summary
      const durationMs = Date.now() - startTime
      const summary: ScanSummary = {
        total: allFindings.length,
        critical: allFindings.filter((f) => f.severity === "critical").length,
        high: allFindings.filter((f) => f.severity === "high").length,
        medium: allFindings.filter((f) => f.severity === "medium").length,
        low: allFindings.filter((f) => f.severity === "low").length,
        info: allFindings.filter((f) => f.severity === "info").length,
        filesScanned: files.length,
        durationMs,
        aiAnalysis: aiFindings.length > 0 || !!process.env.ANTHROPIC_API_KEY,
        vulnerableDeps: depFindings.length,
      }

      return c.json({
        ok: true,
        findings: allFindings,
        summary,
      })
    } catch (error: any) {
      console.error("[Security] Scan error:", error)
      return c.json(
        {
          ok: false,
          error: {
            code: "scan_failed",
            message: error.message || "Security scan failed",
          },
        },
        500
      )
    }
  })

  return router
}

