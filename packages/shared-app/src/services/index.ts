// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
// Services barrel export - add new services here

export {
  createRemoteAwareHttpClient,
  shouldRouteToRemote,
  rewritePathForRemote,
  REMOTE_ROUTED_PREFIXES,
  REMOTE_EXCLUDED_PATTERNS,
  ROUTE_TABLE,
  MACHINE_WORKSPACE_CLOUD_ONLY,
  MACHINE_WORKSPACE_OWNED,
  MACHINE_WORKSPACE_FAMILIES,
  type RemoteInterceptorConfig,
  type RouteTarget,
  type RouteEntry,
} from './remote-http-interceptor'

export {
  MACHINE_RETRY_CAP_MS,
  MACHINE_RETRY_BASE_MS,
  MachineWorkspaceStateStore,
  machineWorkspaceState,
  describeMachineWorkspace,
  describeLastSynced,
  errorLastSyncedAt,
  isMachineConditionError,
  parseRetryAfter,
  type MachineWorkspaceCondition,
  type MachineWorkspaceTone,
  type MachineWorkspaceView,
} from './machine-workspace-state'

export {
  SyncClient,
  type SyncClientConfig,
  type SyncConnectionStatus,
  type SyncEvent,
  type SyncEventHandler,
  type SyncEventSource,
  type SyncEventType,
  type SyncStatusHandler,
} from './sync-client'
