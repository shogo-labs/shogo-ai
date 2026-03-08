// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
export * from './types'
export {
  COMPONENT_SCHEMA,
  COMPONENT_CATEGORIES,
  getComponentSchema,
  getComponentsByCategory,
  type PropDef,
  type ComponentSchema,
} from './component-schema'
export * from './pointer'
export { useDynamicAppStream, type DynamicAppStreamState, type DynamicAppStreamOptions } from './useDynamicAppStream'
export { useApiDataSource, type ApiBinding, type ApiDataSourceResult, type ApiDataSourceOptions } from './useApiDataSource'
export { useAgentUrl } from './useAgentUrl'
export {
  resolveValue,
  resolveComponentProps,
  sanitizeForRender,
  RESERVED_KEYS,
  type ApiDataSourceLike,
} from './resolve-props'
export {
  resolveChildDescriptors,
  type ChildDescriptor,
} from './resolve-children'
