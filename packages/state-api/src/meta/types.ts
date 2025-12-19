/**
 * Type definitions for meta-store model descriptors
 *
 * These types describe the structure of models for introspection purposes.
 * Used by meta-store enhancements to convert MST models to descriptors.
 */

export type RefKind = "single" | "array"

export interface ModelField {
  name: string
  type: string
  required: boolean
  computed?: boolean
}

export interface ModelRef {
  field: string
  target: string
  kind: RefKind
}

export interface ModelDescriptor {
  name: string
  collectionName: string
  fields: ModelField[]
  refs?: ModelRef[]
}
