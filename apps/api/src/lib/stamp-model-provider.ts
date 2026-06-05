import { resolveModelId } from "@shogo/model-catalog"
import { getMergedModelEntrySync } from "../services/model-registry.service"

/**
 * Tell the runtime the model's native provider. DB-defined models are addressed
 * by an opaque UUID the runtime can't classify (it would infer `custom` and
 * route through the lossy OpenAI-compat conversion path); the API server holds
 * the model registry, so resolve the provider here from the final
 * (post-downgrade) id. Unknown ids leave `modelProvider` unset → the runtime
 * infers from the id as before.
 *
 * Mutates `parsedBody` in place. Call after any `agentMode` tier-downgrade so
 * the provider is resolved from the model that will actually run.
 */
export function stampModelProvider(parsedBody: { agentMode?: unknown; modelProvider?: unknown }): void {
  if (!parsedBody?.agentMode || typeof parsedBody.agentMode !== "string") return
  const provider = getMergedModelEntrySync(resolveModelId(parsedBody.agentMode))?.provider
  if (provider) parsedBody.modelProvider = provider
  else delete parsedBody.modelProvider
}
