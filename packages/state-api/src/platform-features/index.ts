/**
 * Platform Features Domain
 *
 * Exports for the platform feature development lifecycle domain.
 * Used by Studio UI and Claude skills for feature development.
 */

export {
  platformFeaturesDomain,
  PlatformFeaturesDomain,
  createPlatformFeaturesStore,
  StatusToPhase,
  StatusOrder,
  type CreatePlatformFeaturesStoreOptions,
} from "./domain"
