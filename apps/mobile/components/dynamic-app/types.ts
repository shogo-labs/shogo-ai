/**
 * Dynamic App Protocol Types (Mobile)
 *
 * Re-exports from @shogo/shared-app/dynamic-app.
 * Mobile-specific code can still import from this local path.
 */
export {
  type DynamicValue,
  isDynamicPath,
  isApiBinding,
  type ComponentType,
  type ComponentDefinition,
  type ActionEvent,
  type CreateSurfaceMessage,
  type UpdateComponentsMessage,
  type UpdateDataMessage,
  type DeleteSurfaceMessage,
  type ConfigureApiMessage,
  type DynamicAppMessage,
  type ApiModelInfo,
  type SurfaceState,
} from '@shogo/shared-app/dynamic-app'
