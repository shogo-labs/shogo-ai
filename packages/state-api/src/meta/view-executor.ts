/**
 * View Executor: Executes query and template views
 *
 * Supports:
 * - Query views: Filter collections, return data array
 * - Template views: Render templates with data from query views
 * - Parameter substitution: ${paramName} in filter values
 */

import { getMetaStore } from "./bootstrap"
import { getRuntimeStore } from "./runtime-store-cache"
import { renderTemplate, createTemplateEnvironment } from "../utils/template"

/**
 * Execute a view by name
 *
 * @param schemaName - Schema name
 * @param viewName - View name
 * @param params - Parameters for substitution and context
 * @returns Data array (query view) or rendered string (template view)
 */
export async function executeView(
  schemaName: string,
  viewName: string,
  params: Record<string, any> = {}
): Promise<any> {
  const metaStore = getMetaStore()
  const schema = metaStore.findSchemaByName(schemaName)

  if (!schema) {
    throw new Error(`Schema '${schemaName}' not found`)
  }

  // Find view definition
  const viewDef = schema.views?.find((v: any) => v.name === viewName)
  if (!viewDef) {
    throw new Error(`View '${viewName}' not found in schema '${schemaName}'`)
  }

  // Execute based on type
  if (viewDef.type === "query") {
    return executeQueryView(schema, viewDef, params)
  } else if (viewDef.type === "template") {
    return await executeTemplateView(schema, viewDef, params)
  } else {
    throw new Error(`Unknown view type: ${viewDef.type}`)
  }
}

/**
 * Execute a query view
 *
 * @param schema - Schema entity
 * @param viewDef - ViewDefinition entity
 * @param params - Parameters for filter substitution
 * @returns Array of filtered data
 */
function executeQueryView(
  schema: any,
  viewDef: any,
  params: Record<string, any>
): any[] {
  const runtimeStore = getRuntimeStore(schema.id)
  if (!runtimeStore) {
    throw new Error(`Runtime store not found for schema '${schema.name}'`)
  }

  // Validate collection exists (camelCase: Task -> taskCollection)
  const collectionName = viewDef.collection.charAt(0).toLowerCase() + viewDef.collection.slice(1) + "Collection"
  const collection = runtimeStore[collectionName]
  if (!collection) {
    throw new Error(`Collection '${viewDef.collection}' not found in schema '${schema.name}'`)
  }

  // Get base data
  let data: any[]

  if (viewDef.filter) {
    // Substitute parameters in filter
    const filter = substituteParams(viewDef.filter, params)
    // Use where() base view for filtering
    data = collection.where(filter)
  } else {
    // No filter - use all() base view
    data = collection.all()
  }

  // Apply field projection if specified
  if (viewDef.select && viewDef.select.length > 0) {
    data = data.map(item => {
      const projected: Record<string, any> = {}
      viewDef.select.forEach((field: string) => {
        if (field in item) {
          projected[field] = item[field]
        }
      })
      return projected
    })
  }

  return data
}

/**
 * Execute a template view
 *
 * @param schema - Schema entity
 * @param viewDef - ViewDefinition entity
 * @param params - Parameters for data source and template context
 * @returns Rendered template string
 */
async function executeTemplateView(
  schema: any,
  viewDef: any,
  params: Record<string, any>
): Promise<string> {
  // Get data from dataSource view
  if (!viewDef.dataSource) {
    throw new Error(`Template view '${viewDef.name}' missing dataSource`)
  }

  const data = await executeView(schema.name, viewDef.dataSource, params)

  // Render template
  if (!viewDef.template) {
    throw new Error(`Template view '${viewDef.name}' missing template`)
  }

  const templateDir = `.schemas/${schema.name}/templates`
  const env = createTemplateEnvironment({ templatesPath: templateDir })

  return renderTemplate(env, viewDef.template, { data })
}

/**
 * Substitute parameters in filter values
 *
 * Replaces ${paramName} with params.paramName
 *
 * @param filter - Filter object with potential ${param} placeholders
 * @param params - Parameter values
 * @returns Filter with substituted values
 */
function substituteParams(
  filter: Record<string, any>,
  params: Record<string, any>
): Record<string, any> {
  const substituted: Record<string, any> = {}

  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
      const paramName = value.slice(2, -1)
      if (!(paramName in params)) {
        throw new Error(`Missing required parameter: ${paramName}`)
      }
      substituted[key] = params[paramName]
    } else {
      substituted[key] = value
    }
  }

  return substituted
}
