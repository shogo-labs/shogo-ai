// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reading the generated media-model option tables.
 *
 * A grouped model (`hf-kling-3.0-std` = text-to-video + image-to-video) carries
 * one option list per endpoint, because the vendor documents them separately —
 * the image-to-video endpoint requires `image_url`, the text-to-video one takes
 * `aspect_ratio`. These helpers are the only place that merge matters: the
 * request builder looks a field up on the endpoint it is about to submit to,
 * and `list_media_models` shows one merged view per model.
 */

import type { ImageModelEntry, ModelOptionField, VideoModelEntry } from './models'

type MediaEntry = ImageModelEntry | VideoModelEntry

/** Typed view of the per-endpoint option tables. */
function tablesOf(entry: MediaEntry): Record<string, readonly ModelOptionField[]> {
  return (entry.optionsByEndpoint ?? {}) as Record<string, readonly ModelOptionField[]>
}

/** The option list the given endpoint documents (empty when the model has none). */
export function optionsForEndpoint(entry: MediaEntry, endpoint: string | undefined): readonly ModelOptionField[] {
  if (!endpoint) return []
  return tablesOf(entry)[endpoint] ?? []
}

/** One documented field on one endpoint, or undefined when it is undeclared. */
export function mediaOption(
  entry: MediaEntry,
  endpoint: string | undefined,
  name: string,
): ModelOptionField | undefined {
  return optionsForEndpoint(entry, endpoint).find((option) => option.name === name)
}

/** Every endpoint the model documents, in submit order. */
export function endpointsOf(entry: MediaEntry): readonly string[] {
  const declared = entry.endpoints
  if (declared && declared.length > 0) return declared
  const tables = Object.keys(tablesOf(entry))
  if (tables.length > 0) return tables
  const video = entry as VideoModelEntry
  return [video.textToVideoApiModel, video.imageToVideoApiModel].filter((id): id is string => !!id)
}

/**
 * One row per field name across the model's endpoints. A field every endpoint
 * declares shows the values valid on *all* of them (the safe intersection of
 * its enum and range); a field only some endpoints declare keeps its own
 * constraints and lists the endpoints it belongs to.
 */
export function mergeModelOptions(entry: MediaEntry): ModelOptionField[] {
  const tables = tablesOf(entry)
  const byName = new Map<string, ModelOptionField[]>()
  const order: string[] = []
  for (const endpoint of endpointsOf(entry)) {
    for (const field of tables[endpoint] ?? []) {
      if (!byName.has(field.name)) {
        byName.set(field.name, [])
        order.push(field.name)
      }
      byName.get(field.name)!.push({ ...field, endpoints: [endpoint] })
    }
  }

  return order.map((name) => {
    const variants = byName.get(name)!
    const endpoints = variants.flatMap((variant) => variant.endpoints ?? [])
    if (variants.length === 1) return { ...variants[0], endpoints }

    const merged: ModelOptionField = { ...variants[0], endpoints }
    const enums = variants.map((variant) => variant.enum)
    if (enums.every((values) => values && values.length > 0)) {
      const intersection = enums[0]!.filter((value) => enums.every((values) => values!.includes(value)))
      merged.enum = intersection.length > 0 ? intersection : [...new Set(enums.flat() as string[])]
    } else {
      delete merged.enum
    }

    const minimums = variants.map((variant) => variant.minimum).filter((value): value is number => value !== undefined)
    const maximums = variants.map((variant) => variant.maximum).filter((value): value is number => value !== undefined)
    const minItems = variants.map((variant) => variant.minItems).filter((value): value is number => value !== undefined)
    const maxItems = variants.map((variant) => variant.maxItems).filter((value): value is number => value !== undefined)
    if (minimums.length > 0) merged.minimum = Math.max(...minimums)
    else delete merged.minimum
    if (maximums.length > 0) merged.maximum = Math.min(...maximums)
    else delete merged.maximum
    if (minItems.length > 0) merged.minItems = Math.max(...minItems)
    else delete merged.minItems
    if (maxItems.length > 0) merged.maxItems = Math.min(...maxItems)
    else delete merged.maxItems
    // A default only means something when it is valid everywhere.
    if (merged.default !== undefined && merged.enum && !merged.enum.includes(String(merged.default))) {
      delete merged.default
    }
    return merged
  })
}
