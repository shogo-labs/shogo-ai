// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
export {
  COMPOSIO_EVENT_PREFIX,
  EVENT_SCOPES,
  NATIVE_EVENTS,
  composioEventType,
  composioScope,
  defineEvent,
  eventTypeMatches,
  getEventDefinition,
  memberJoined,
  parseComposioEventType,
  redactEventPayload,
  scopeForEventType,
  validateEventPayload,
} from './catalog'
export {
  APP_MANIFEST_FILE,
  MAX_APP_EVENTS,
  grantableScopes,
  isKnownScope,
  parseAppManifest,
  scopesForEventPattern,
} from './app-manifest'
export type { AppEventSpec, ParseAppManifestResult, ShogoAppManifest } from './app-manifest'
export {
  SHOGO_EVENT_ID_HEADER,
  SHOGO_SIGNATURE_HEADER,
  SHOGO_TIMESTAMP_HEADER,
  signShogoWebhook,
  verifyShogoSignature,
} from './signature'
export type { VerifyShogoSignatureInput } from './signature'
export type { EventDefinition, EventFieldSchema, MemberJoinedPayload, WorkspaceEventEnvelope } from './types'
