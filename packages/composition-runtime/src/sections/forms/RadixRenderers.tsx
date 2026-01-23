/**
 * Radix UI Renderers for JSON Forms
 *
 * Custom renderers using shadcn/ui components (built on Radix UI) for:
 * - StringInput (text, email, url, textarea)
 * - NumberInput
 * - BooleanToggle (checkbox)
 * - EnumSelect (dropdown)
 * - DatePicker
 * - EntityPicker (for reference fields)
 *
 * Each renderer uses withJsonFormsControlProps HOC from @jsonforms/react
 */

import React, { useCallback, useMemo } from "react"
import { withJsonFormsControlProps, withJsonFormsLayoutProps, JsonFormsDispatch } from "@jsonforms/react"
import {
  rankWith,
  isStringControl,
  isNumberControl,
  isBooleanControl,
  isEnumControl,
  isDateControl,
  uiTypeIs,
  type RankedTester,
  type ControlElement,
  type JsonSchema,
  type ControlProps,
  type LayoutProps,
} from "@jsonforms/core"
import { Input } from "../../ui"
import { Label } from "../../ui"
import { Checkbox } from "../../ui"
import { Textarea } from "../../ui"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui"
import { cn } from "../../utils/cn"

// ============================================================================
// Shared Components
// ============================================================================

interface FieldWrapperProps {
  id: string
  label: string
  description?: string
  errors?: string
  required?: boolean
  children: React.ReactNode
}

/**
 * Common field wrapper with label, description, and error display
 */
function FieldWrapper({
  id,
  label,
  description,
  errors,
  required,
  children,
}: FieldWrapperProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className={cn(errors && "text-destructive")}>
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {children}
      {description && !errors && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      {errors && <p className="text-sm text-destructive">{errors}</p>}
    </div>
  )
}

// ============================================================================
// String Renderer
// ============================================================================

/**
 * String control renderer with support for text, email, url, and textarea
 */
const StringRenderer = ({
  data,
  path,
  handleChange,
  label,
  description,
  enabled,
  required,
  errors,
  id,
  uischema,
  schema,
}: ControlProps) => {
  const controlType = uischema?.options?.controlType as string | undefined
  const isTextarea = controlType === "textarea" || schema?.format === "textarea"

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      handleChange(path, e.target.value === "" ? undefined : e.target.value)
    },
    [path, handleChange]
  )

  // Determine input type
  let inputType = "text"
  if (schema?.format === "email" || controlType === "email") {
    inputType = "email"
  } else if (schema?.format === "uri" || schema?.format === "url" || controlType === "url") {
    inputType = "url"
  }

  const inputId = id || path

  return (
    <FieldWrapper
      id={inputId}
      label={label || ""}
      description={description}
      errors={errors}
      required={required}
    >
      {isTextarea ? (
        <Textarea
          id={inputId}
          value={data ?? ""}
          onChange={onChange}
          disabled={!enabled}
          placeholder={schema?.default as string}
          aria-invalid={!!errors}
        />
      ) : (
        <Input
          id={inputId}
          type={inputType}
          value={data ?? ""}
          onChange={onChange}
          disabled={!enabled}
          placeholder={schema?.default as string}
          aria-invalid={!!errors}
        />
      )}
    </FieldWrapper>
  )
}

export const stringRendererTester: RankedTester = rankWith(3, isStringControl)
export const RadixStringRenderer = withJsonFormsControlProps(StringRenderer)

// ============================================================================
// Number Renderer
// ============================================================================

/**
 * Number control renderer
 */
const NumberRenderer = ({
  data,
  path,
  handleChange,
  label,
  description,
  enabled,
  required,
  errors,
  id,
  schema,
}: ControlProps) => {
  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      if (value === "") {
        handleChange(path, undefined)
      } else {
        const num = schema?.type === "integer" ? parseInt(value, 10) : parseFloat(value)
        handleChange(path, isNaN(num) ? undefined : num)
      }
    },
    [path, handleChange, schema?.type]
  )

  const inputId = id || path

  return (
    <FieldWrapper
      id={inputId}
      label={label || ""}
      description={description}
      errors={errors}
      required={required}
    >
      <Input
        id={inputId}
        type="number"
        value={data ?? ""}
        onChange={onChange}
        disabled={!enabled}
        min={schema?.minimum}
        max={schema?.maximum}
        step={schema?.type === "integer" ? 1 : "any"}
        aria-invalid={!!errors}
      />
    </FieldWrapper>
  )
}

export const numberRendererTester: RankedTester = rankWith(3, isNumberControl)
export const RadixNumberRenderer = withJsonFormsControlProps(NumberRenderer)

// ============================================================================
// Boolean Renderer
// ============================================================================

/**
 * Boolean control renderer using Checkbox
 */
const BooleanRenderer = ({
  data,
  path,
  handleChange,
  label,
  description,
  enabled,
  errors,
  id,
}: ControlProps) => {
  const onChange = useCallback(
    (checked: boolean | "indeterminate") => {
      handleChange(path, checked === true)
    },
    [path, handleChange]
  )

  const inputId = id || path

  return (
    <div className="space-y-2">
      <div className="flex items-center space-x-2">
        <Checkbox
          id={inputId}
          checked={data ?? false}
          onCheckedChange={onChange}
          disabled={!enabled}
          aria-invalid={!!errors}
        />
        <Label
          htmlFor={inputId}
          className={cn("cursor-pointer", errors && "text-destructive")}
        >
          {label}
        </Label>
      </div>
      {description && !errors && (
        <p className="text-sm text-muted-foreground ml-6">{description}</p>
      )}
      {errors && <p className="text-sm text-destructive ml-6">{errors}</p>}
    </div>
  )
}

export const booleanRendererTester: RankedTester = rankWith(3, isBooleanControl)
export const RadixBooleanRenderer = withJsonFormsControlProps(BooleanRenderer)

// ============================================================================
// Enum Renderer
// ============================================================================

/**
 * Enum control renderer using Select dropdown
 */
const EnumRenderer = ({
  data,
  path,
  handleChange,
  label,
  description,
  enabled,
  required,
  errors,
  id,
  schema,
  uischema,
}: ControlProps) => {
  const options = useMemo(() => {
    // Get enum values from schema or uischema options
    const enumValues =
      schema?.enum ||
      (uischema?.options?.enumValues as string[] | undefined) ||
      []
    return enumValues.map((value: string) => ({
      value,
      label: humanizeEnumValue(value),
    }))
  }, [schema?.enum, uischema?.options])

  const onChange = useCallback(
    (value: string) => {
      handleChange(path, value === "" ? undefined : value)
    },
    [path, handleChange]
  )

  const inputId = id || path

  return (
    <FieldWrapper
      id={inputId}
      label={label || ""}
      description={description}
      errors={errors}
      required={required}
    >
      <Select
        value={data ?? ""}
        onValueChange={onChange}
        disabled={!enabled}
      >
        <SelectTrigger id={inputId} aria-invalid={!!errors}>
          <SelectValue placeholder="Select..." />
        </SelectTrigger>
        <SelectContent>
          {options.map((option: { value: string; label: string }) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldWrapper>
  )
}

/**
 * Humanize enum value (snake_case or kebab-case to Title Case)
 */
function humanizeEnumValue(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim()
}

export const enumRendererTester: RankedTester = rankWith(5, isEnumControl)
export const RadixEnumRenderer = withJsonFormsControlProps(EnumRenderer)

// ============================================================================
// Date Renderer
// ============================================================================

/**
 * Date control renderer using native date input
 * (Future: could use a proper date picker component)
 */
const DateRenderer = ({
  data,
  path,
  handleChange,
  label,
  description,
  enabled,
  required,
  errors,
  id,
  schema,
}: ControlProps) => {
  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      handleChange(path, e.target.value === "" ? undefined : e.target.value)
    },
    [path, handleChange]
  )

  const inputId = id || path
  const isDateTime = schema?.format === "date-time"

  return (
    <FieldWrapper
      id={inputId}
      label={label || ""}
      description={description}
      errors={errors}
      required={required}
    >
      <Input
        id={inputId}
        type={isDateTime ? "datetime-local" : "date"}
        value={data ?? ""}
        onChange={onChange}
        disabled={!enabled}
        aria-invalid={!!errors}
      />
    </FieldWrapper>
  )
}

export const dateRendererTester: RankedTester = rankWith(4, isDateControl)
export const RadixDateRenderer = withJsonFormsControlProps(DateRenderer)

// ============================================================================
// Entity Picker Renderer (for reference fields)
// ============================================================================

/**
 * Custom tester for entity picker (reference fields)
 */
const isEntityPicker = (uischema: any): boolean => {
  return (
    uischema?.options?.controlType === "entity-picker" ||
    uischema?.options?.referenceType === "single" ||
    uischema?.options?.referenceType === "array"
  )
}

export const entityPickerTester: RankedTester = rankWith(
  10,
  (uischema, schema, context) => isEntityPicker(uischema)
)

/**
 * Entity Picker renderer for reference fields
 *
 * Currently renders as a text input for ID.
 * Future: Could integrate with collection lookup for autocomplete.
 */
const EntityPickerRenderer = ({
  data,
  path,
  handleChange,
  label,
  description,
  enabled,
  required,
  errors,
  id,
  uischema,
}: ControlProps) => {
  const referenceTarget = uischema?.options?.referenceTarget as string | undefined
  const referenceType = uischema?.options?.referenceType as string | undefined

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      handleChange(path, e.target.value === "" ? undefined : e.target.value)
    },
    [path, handleChange]
  )

  const inputId = id || path

  // For array references, this would need a multi-select
  // For now, handle single references only
  if (referenceType === "array") {
    return (
      <FieldWrapper
        id={inputId}
        label={label || ""}
        description={`Array of ${referenceTarget || "references"} (comma-separated IDs)`}
        errors={errors}
        required={required}
      >
        <Input
          id={inputId}
          type="text"
          value={Array.isArray(data) ? data.join(", ") : (data ?? "")}
          onChange={(e) => {
            const ids = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
            handleChange(path, ids.length > 0 ? ids : undefined)
          }}
          disabled={!enabled}
          placeholder={`Enter ${referenceTarget || "entity"} IDs...`}
          aria-invalid={!!errors}
        />
      </FieldWrapper>
    )
  }

  return (
    <FieldWrapper
      id={inputId}
      label={label || ""}
      description={description || `Reference to ${referenceTarget || "entity"}`}
      errors={errors}
      required={required}
    >
      <Input
        id={inputId}
        type="text"
        value={data ?? ""}
        onChange={onChange}
        disabled={!enabled}
        placeholder={`Enter ${referenceTarget || "entity"} ID...`}
        aria-invalid={!!errors}
      />
    </FieldWrapper>
  )
}

export const RadixEntityPickerRenderer = withJsonFormsControlProps(EntityPickerRenderer)

// ============================================================================
// Layout Renderers (REQUIRED for VerticalLayout, HorizontalLayout, Group)
// ============================================================================

/**
 * Vertical Layout renderer - renders children in a vertical stack
 */
const VerticalLayoutRenderer = ({
  uischema,
  renderers,
  cells,
  schema,
  path,
  enabled,
  visible
}: LayoutProps) => {
  const layout = uischema as any
  if (!visible) return null

  return (
    <div className="space-y-4">
      {layout.elements?.map((element: any, index: number) => (
        <JsonFormsDispatch
          key={`${path}-${index}`}
          uischema={element}
          schema={schema}
          path={path}
          renderers={renderers}
          cells={cells}
          enabled={enabled}
        />
      ))}
    </div>
  )
}

export const verticalLayoutTester: RankedTester = rankWith(1, uiTypeIs("VerticalLayout"))
export const RadixVerticalLayoutRenderer = withJsonFormsLayoutProps(VerticalLayoutRenderer)

/**
 * Horizontal Layout renderer - renders children in a horizontal row
 */
const HorizontalLayoutRenderer = ({
  uischema,
  renderers,
  cells,
  schema,
  path,
  enabled,
  visible
}: LayoutProps) => {
  const layout = uischema as any
  if (!visible) return null

  return (
    <div className="flex gap-4 flex-wrap">
      {layout.elements?.map((element: any, index: number) => (
        <div key={`${path}-${index}`} className="flex-1 min-w-[200px]">
          <JsonFormsDispatch
            uischema={element}
            schema={schema}
            path={path}
            renderers={renderers}
            cells={cells}
            enabled={enabled}
          />
        </div>
      ))}
    </div>
  )
}

export const horizontalLayoutTester: RankedTester = rankWith(1, uiTypeIs("HorizontalLayout"))
export const RadixHorizontalLayoutRenderer = withJsonFormsLayoutProps(HorizontalLayoutRenderer)

/**
 * Group Layout renderer - renders children with a label/heading
 */
const GroupLayoutRenderer = ({
  uischema,
  renderers,
  cells,
  schema,
  path,
  enabled,
  visible
}: LayoutProps) => {
  const layout = uischema as any
  if (!visible) return null

  return (
    <fieldset className="border border-border rounded-lg p-4 space-y-4">
      {layout.label && (
        <legend className="text-sm font-medium px-2">{layout.label}</legend>
      )}
      {layout.elements?.map((element: any, index: number) => (
        <JsonFormsDispatch
          key={`${path}-${index}`}
          uischema={element}
          schema={schema}
          path={path}
          renderers={renderers}
          cells={cells}
          enabled={enabled}
        />
      ))}
    </fieldset>
  )
}

export const groupLayoutTester: RankedTester = rankWith(1, uiTypeIs("Group"))
export const RadixGroupLayoutRenderer = withJsonFormsLayoutProps(GroupLayoutRenderer)

// ============================================================================
// Export All Renderers
// ============================================================================

/**
 * Array of all Radix UI renderers with their testers
 * Use this with JsonForms renderers prop
 */
export const radixRenderers = [
  // Layout renderers (MUST be included for VerticalLayout, HorizontalLayout, Group)
  { tester: verticalLayoutTester, renderer: RadixVerticalLayoutRenderer },
  { tester: horizontalLayoutTester, renderer: RadixHorizontalLayoutRenderer },
  { tester: groupLayoutTester, renderer: RadixGroupLayoutRenderer },
  // Control renderers
  { tester: entityPickerTester, renderer: RadixEntityPickerRenderer },
  { tester: enumRendererTester, renderer: RadixEnumRenderer },
  { tester: dateRendererTester, renderer: RadixDateRenderer },
  { tester: booleanRendererTester, renderer: RadixBooleanRenderer },
  { tester: numberRendererTester, renderer: RadixNumberRenderer },
  { tester: stringRendererTester, renderer: RadixStringRenderer },
]
