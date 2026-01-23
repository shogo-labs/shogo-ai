/**
 * FormSection Component
 *
 * Renders forms for any Wavesmith entity using JSON Forms library.
 * Generic, reusable component that works with any schema/model combination.
 *
 * Uses platform abstractions:
 * - Meta-store for JSON Schema (model.toJsonSchema())
 * - DomainProvider for schema-name-based store lookup
 * - Custom Radix UI renderers for consistent styling
 *
 * Config options:
 * - schema: string - Schema name (e.g., "platform-features")
 * - model: string - Model name (e.g., "Requirement")
 * - entityId?: string - If editing, the entity ID
 * - fields?: string[] - Property names to display (auto-detect if omitted)
 * - layout?: 'vertical' | 'horizontal' | 'grouped' - Form layout
 * - groups?: Array<{ label: string, fields: string[] }> - Group configuration
 * - title?: string - Optional section title
 * - onSuccess?: () => void - Callback on successful submit
 * - onCancel?: () => void - Callback on cancel
 */

import { useState, useMemo, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { JsonForms } from "@jsonforms/react"
import { Button } from "@/components/ui/button"
import type { SectionRendererProps } from "../sectionImplementations"
import { useDataGridMetadata } from "./hooks"
import { deriveUiSchema, filterFormProperties } from "./utils"
import { radixRenderers } from "./forms"
import { useDomainStore } from "@shogo/app-core"
import { useWavesmithMetaStore } from "@shogo/app-core"

// ============================================================================
// Types
// ============================================================================

export interface FormSectionConfig {
  /** Schema name (e.g., "platform-features") */
  schema?: string
  /** Schema name - alternate key for compatibility */
  schemaName?: string
  /** Workspace/projectId for project-specific schema loading */
  schemaWorkspace?: string
  /** Model name (e.g., "Requirement") */
  model?: string

  /** If editing, the entity ID */
  entityId?: string

  // Field configuration
  /** Property names to display (auto-detect if omitted) */
  fields?: string[]
  /** Layout type: vertical (default), horizontal, or grouped */
  layout?: "vertical" | "horizontal" | "grouped"
  /** Group configuration for 'grouped' layout */
  groups?: Array<{
    label: string
    fields: string[]
  }>

  // Display options
  /** Optional section title */
  title?: string
  /** Submit button text */
  submitLabel?: string
  /** Cancel button text */
  cancelLabel?: string
  /** Hide submit button */
  hideSubmit?: boolean
  /** Hide cancel button */
  hideCancel?: boolean

  // Callbacks
  /** Callback on successful submit */
  onSuccess?: (entity: any) => void
  /** Callback on cancel */
  onCancel?: () => void

  // Session binding
  /** Auto-bind session field to feature.id when creating */
  sessionField?: string
}

interface FormState {
  data: Record<string, any>
  errors: any[]
  isSubmitting: boolean
  submitError: string | null
}

// ============================================================================
// Component
// ============================================================================

/**
 * FormSection Component
 *
 * Renders a form for any Wavesmith entity using JSON Forms.
 * Supports both create and edit modes based on whether entityId is provided.
 */
export const FormSection = observer(function FormSection({
  feature,
  config,
}: SectionRendererProps) {
  const formConfig = config as FormSectionConfig | undefined

  // ============================================================================
  // Extract config values
  // ============================================================================

  const schemaName = formConfig?.schema ?? formConfig?.schemaName
  const modelName = formConfig?.model
  // schemaWorkspace is the projectId - used for project-specific schema storage
  const schemaWorkspace = formConfig?.schemaWorkspace ?? feature?.id
  const entityId = formConfig?.entityId
  const configFields = formConfig?.fields ?? []
  const layout = formConfig?.layout ?? "vertical"
  const groups = formConfig?.groups
  const title = formConfig?.title ?? (modelName ? `${entityId ? "Edit" : "New"} ${modelName}` : "Form")
  const submitLabel = formConfig?.submitLabel ?? (entityId ? "Save" : "Create")
  const cancelLabel = formConfig?.cancelLabel ?? "Cancel"
  const hideSubmit = formConfig?.hideSubmit ?? false
  const hideCancel = formConfig?.hideCancel ?? false
  const onSuccess = formConfig?.onSuccess
  const onCancel = formConfig?.onCancel
  const sessionField = formConfig?.sessionField ?? "session"

  // ============================================================================
  // Get metadata and domain store
  // ============================================================================

  // 1. Get metadata from meta-store (reuse DataGrid's working hook)
  const {
    properties,
    collectionName,
    loading: metaLoading,
    error: metaError,
  } = useDataGridMetadata(schemaName, modelName, schemaWorkspace)

  // 2. Get meta-store for JSON Schema derivation
  const metaStore = useWavesmithMetaStore()

  // 3. Derive JSON Schema from model (done in component, not hook)
  // Dependencies include `properties` to ensure re-computation after async schema load
  const jsonSchema = useMemo(() => {
    if (!schemaName || !modelName) return null
    // Wait for metadata to be loaded (properties will be populated)
    if (properties.length === 0 && !metaError) return null
    const schema = metaStore.findSchemaByName(schemaName)
    const model = schema?.models?.find((m: any) => m.name === modelName)
    const result = model?.toJsonSchema?.() ?? null

    // DEBUG: Log enum values for featureArchetype
    if (modelName === "FeatureSession") {
      const featureArchetypeProp = properties.find((p: any) => p.name === "featureArchetype")
      console.log("[FormSection DEBUG] featureArchetype property:", featureArchetypeProp)
      console.log("[FormSection DEBUG] featureArchetype.enum:", featureArchetypeProp?.enum)
      console.log("[FormSection DEBUG] jsonSchema.properties.featureArchetype:", result?.properties?.featureArchetype)
    }

    return result
  }, [metaStore, schemaName, modelName, properties.length, metaError])

  // 4. Get domain store for CRUD operations
  const domainStore = useDomainStore(schemaName ?? "")

  // ============================================================================
  // Form state
  // ============================================================================

  const [formState, setFormState] = useState<FormState>({
    data: {},
    errors: [],
    isSubmitting: false,
    submitError: null,
  })

  // Load existing entity data if editing
  const initialData = useMemo(() => {
    if (!entityId || !domainStore || !collectionName) return {}

    const collection = domainStore[collectionName]
    if (!collection?.get) return {}

    const entity = collection.get(entityId)
    if (!entity) return {}

    // Extract plain data from MST instance
    const data: Record<string, any> = {}
    for (const prop of properties) {
      if (prop.name in entity) {
        data[prop.name] = entity[prop.name]
      }
    }
    return data
  }, [entityId, domainStore, collectionName, properties])

  // Initialize form data with existing entity data
  const [isInitialized, setIsInitialized] = useState(false)
  if (!isInitialized && Object.keys(initialData).length > 0) {
    setFormState((prev) => ({ ...prev, data: initialData }))
    setIsInitialized(true)
  }

  // ============================================================================
  // Derive UI Schema
  // ============================================================================

  const uiSchema = useMemo(() => {
    if (properties.length === 0) return null

    // Filter properties for form display
    const formProperties = filterFormProperties(properties)

    return deriveUiSchema(formProperties, {
      fields: configFields.length > 0 ? configFields : undefined,
      layout,
      groups,
    })
  }, [properties, configFields, layout, groups])

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleChange = useCallback(
    ({ data, errors }: { data: any; errors: any[] }) => {
      setFormState((prev) => ({
        ...prev,
        data,
        errors,
        submitError: null,
      }))
    },
    []
  )

  const handleSubmit = useCallback(async () => {
    if (!domainStore || !collectionName) return

    const collection = domainStore[collectionName]
    if (!collection) {
      setFormState((prev) => ({
        ...prev,
        submitError: `Collection ${collectionName} not found`,
      }))
      return
    }

    // Check for validation errors
    if (formState.errors.length > 0) {
      setFormState((prev) => ({
        ...prev,
        submitError: "Please fix validation errors before submitting",
      }))
      return
    }

    setFormState((prev) => ({ ...prev, isSubmitting: true, submitError: null }))

    try {
      let result: any

      if (entityId) {
        // Edit mode: use updateOne
        if (!collection.updateOne) {
          throw new Error("Collection does not support updateOne")
        }
        result = await collection.updateOne(entityId, formState.data)
      } else {
        // Create mode: use insertOne
        if (!collection.insertOne) {
          throw new Error("Collection does not support insertOne")
        }

        // Prepare data with session binding if available
        const insertData = { ...formState.data }

        // Auto-bind session field to feature.id if feature is available
        if (feature?.id && sessionField && !insertData[sessionField]) {
          insertData[sessionField] = feature.id
        }

        // Generate ID if not provided
        if (!insertData.id) {
          insertData.id = `${modelName?.toLowerCase()}-${Date.now()}`
        }

        // Add timestamp
        if (!insertData.createdAt) {
          insertData.createdAt = Date.now()
        }

        result = await collection.insertOne(insertData)
      }

      setFormState((prev) => ({ ...prev, isSubmitting: false }))
      onSuccess?.(result)
    } catch (error: any) {
      setFormState((prev) => ({
        ...prev,
        isSubmitting: false,
        submitError: error.message ?? "Failed to save",
      }))
    }
  }, [
    domainStore,
    collectionName,
    entityId,
    formState.data,
    formState.errors,
    feature?.id,
    sessionField,
    modelName,
    onSuccess,
  ])

  const handleCancel = useCallback(() => {
    onCancel?.()
  }, [onCancel])

  // ============================================================================
  // Render
  // ============================================================================

  const error = metaError

  // Handle missing configuration
  if (!schemaName || !modelName) {
    return (
      <section data-testid="form-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            Configuration required: specify schema and model
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Example: {`{ schema: "platform-features", model: "Requirement" }`}
          </p>
        </div>
      </section>
    )
  }

  // Handle errors
  if (error) {
    return (
      <section data-testid="form-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-destructive/10 rounded-lg text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </section>
    )
  }

  // Handle loading state
  if (metaLoading || !jsonSchema || !uiSchema) {
    return (
      <section data-testid="form-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">Loading form...</p>
        </div>
      </section>
    )
  }

  // Render the form
  return (
    <section data-testid="form-section" className="h-full flex flex-col">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        {title}
      </h3>

      <div className="flex-1 space-y-4">
        <JsonForms
          schema={jsonSchema}
          uischema={uiSchema}
          data={formState.data}
          renderers={radixRenderers}
          onChange={handleChange}
        />

        {formState.submitError && (
          <div className="p-3 bg-destructive/10 rounded-lg">
            <p className="text-sm text-destructive">{formState.submitError}</p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t">
          {!hideCancel && onCancel && (
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={formState.isSubmitting}
            >
              {cancelLabel}
            </Button>
          )}
          {!hideSubmit && (
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={formState.isSubmitting || formState.errors.length > 0}
            >
              {formState.isSubmitting ? "Saving..." : submitLabel}
            </Button>
          )}
        </div>
      </div>
    </section>
  )
})
