/**
 * DomainProvider - Hybrid exports for migration
 *
 * During the migration period, this file exports from both:
 * - LegacyDomainProvider: state-api domains with domain-specific queries
 * - SDKDomainProvider: SDK-generated MST stores with basic CRUD
 *
 * Existing code using useDomains() will get state-api stores.
 * New code can use useSDKDomain() for SDK-generated stores.
 *
 * Migration guide:
 * 1. Import useSDKDomain for direct SDK access
 * 2. Refactor domain-specific queries (findByX) to use filter/find
 * 3. Once all queries are migrated, switch fully to SDK
 */

// Re-export legacy provider and hooks (for existing code)
export {
  LegacyDomainProvider as DomainProvider,
  useDomains,
  useDomainStore,
  useSchemaLoadingState,
  type DomainsMap,
  type EagerCollectionsConfig,
} from './LegacyDomainProvider'

// Re-export SDK provider and hooks (for new code)
export {
  SDKDomainProvider,
  useSDKDomains,
  useSDKDomain,
  useSDKHttp,
  useSDKReady,
  useWorkspaceCollection,
  useProjectCollection,
  useMemberCollection,
  useFolderCollection,
  useStarredProjectCollection,
  useInvitationCollection,
  useNotificationCollection,
  useSubscriptionCollection,
  useChatSessionCollection,
  useChatMessageCollection,
  type SDKDomainFacades,
  type SDKDomainProviderProps,
} from './SDKDomainProvider'
