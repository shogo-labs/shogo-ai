/**
 * Template Engine: Nunjucks wrapper for view rendering
 *
 * Provides:
 * - FileSystemLoader scoped to schema templates directory
 * - Auto-escaping enabled for security
 * - Simple rendering interface
 */

import nunjucks from "nunjucks"

/**
 * Configuration for template environment
 */
export interface TemplateConfig {
  templatesPath: string  // Path to templates directory (e.g., ".schemas/my-schema/templates")
  autoescape?: boolean   // Auto-escape HTML (default: true)
}

/**
 * Create a Nunjucks environment configured for a schema's templates
 *
 * @param config - Template configuration
 * @returns Nunjucks environment
 */
export function createTemplateEnvironment(config: TemplateConfig): nunjucks.Environment {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(config.templatesPath, {
      noCache: true  // Disable cache for development (can be made configurable)
    }),
    {
      autoescape: config.autoescape !== undefined ? config.autoescape : true
    }
  )

  return env
}

/**
 * Render a template with context data
 *
 * @param env - Nunjucks environment
 * @param templateName - Template filename (e.g., "report.njk")
 * @param context - Template context (data only, per spec)
 * @returns Rendered string
 */
export function renderTemplate(
  env: nunjucks.Environment,
  templateName: string,
  context: Record<string, any>
): string {
  try {
    return env.render(templateName, context)
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Template rendering failed: ${error.message}`)
    }
    throw error
  }
}
