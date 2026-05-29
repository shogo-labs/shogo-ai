import { CANVAS_V2_EVALS } from './evals/test-cases-canvas-v2'
import { CANVAS_V2_LINT_EVALS } from './evals/test-cases-canvas-v2-lint'
import { WORKSPACE_PARITY_EVALS } from './evals/test-cases-workspace-parity'
import { COMPLEX_EVALS } from './evals/test-cases-complex'
import { MEMORY_EVALS } from './evals/test-cases-memory'
import { PERSONALITY_EVALS } from './evals/test-cases-personality'
import { MULTITURN_EVALS } from './evals/test-cases-multiturn'
import { MCP_DISCOVERY_EVALS } from './evals/test-cases-mcp-discovery'
import { UNIFIED_CONNECT_EVALS } from './evals/test-cases-unified-connect'
import { MCP_ORCHESTRATION_EVALS } from './evals/test-cases-mcp-orchestration'
import { MCP_VACATION_PLANNER_EVALS } from './evals/test-cases-mcp-vacation-planner'
import { COMPOSIO_EVALS } from './evals/test-cases-composio'
import { TOOL_SYSTEM_EVALS } from './evals/test-cases-tool-system'
import { FILE_UPLOAD_EVALS } from './evals/test-cases-file-upload'
import { REAL_DATA_EVALS } from './evals/test-cases-real-data'
import { TRIP_PLANNER_EVALS } from './evals/test-cases-trip-planner'
import { TEMPLATE_EVALS } from './evals/test-cases-template'
import { DATA_PROCESSING_EVALS } from './evals/test-cases-data-processing'
import { CLI_ROUTING_EVALS } from './evals/test-cases-cli-routing'
import { SKILL_SYSTEM_EVALS } from './evals/test-cases-skill-system'
import { SKILL_SERVER_EVALS } from './evals/test-cases-skill-server'
import { SKILL_SERVER_TEMPLATE_EVALS } from './evals/test-cases-skill-server-templates'
import { SKILL_SERVER_ADVANCED_EVALS } from './evals/test-cases-skill-server-advanced'
import { EDIT_FILE_EVALS } from './evals/test-cases-edit-file'
import { CHANNEL_CONNECT_EVALS } from './evals/test-cases-channel-connect'
import { BUG_FIX_EVALS } from './evals/test-cases-bug-fix'
import { CODING_DISCIPLINE_EVALS } from './evals/test-cases-coding-discipline'
import { SUBAGENT_EVALS } from './evals/test-cases-subagent'
import { SUBAGENT_SMOKE_EVALS } from './evals/test-cases-subagent-smoke'
import { SUBAGENT_CODE_EVALS } from './evals/test-cases-subagent-code'
import { SUBAGENT_AB_EVALS } from './evals/test-cases-subagent-ab'
import { KNOWLEDGE_GRAPH_EVALS } from './evals/test-cases-knowledge-graph'
import { TOKEN_BUDGET_EVALS } from './evals/test-cases-token-budget'
import { PLAN_EVALS } from './evals/test-cases-plans'

const tracks = {
  'canvas-v2': CANVAS_V2_EVALS, 'canvas-v2-lint': CANVAS_V2_LINT_EVALS,
  'workspace-parity': WORKSPACE_PARITY_EVALS, complex: COMPLEX_EVALS,
  memory: MEMORY_EVALS, personality: PERSONALITY_EVALS,
  multiturn: MULTITURN_EVALS, 'mcp-discovery': MCP_DISCOVERY_EVALS,
  'unified-connect': UNIFIED_CONNECT_EVALS,
  'mcp-orchestration': MCP_ORCHESTRATION_EVALS,
  'vacation-planner': MCP_VACATION_PLANNER_EVALS,
  composio: COMPOSIO_EVALS, 'tool-system': TOOL_SYSTEM_EVALS,
  'file-upload': FILE_UPLOAD_EVALS, 'real-data': REAL_DATA_EVALS,
  'trip-planner': TRIP_PLANNER_EVALS, template: TEMPLATE_EVALS,
  'data-processing': DATA_PROCESSING_EVALS, 'cli-routing': CLI_ROUTING_EVALS,
  'skill-system': SKILL_SYSTEM_EVALS, 'skill-server': SKILL_SERVER_EVALS,
  'skill-server-templates': SKILL_SERVER_TEMPLATE_EVALS,
  'skill-server-advanced': SKILL_SERVER_ADVANCED_EVALS,
  'edit-file': EDIT_FILE_EVALS, 'channel-connect': CHANNEL_CONNECT_EVALS,
  'bug-fix': BUG_FIX_EVALS, 'coding-discipline': CODING_DISCIPLINE_EVALS,
  subagent: SUBAGENT_EVALS, 'subagent-smoke': SUBAGENT_SMOKE_EVALS,
  'subagent-code': SUBAGENT_CODE_EVALS, 'subagent-ab': SUBAGENT_AB_EVALS,
  'knowledge-graph': KNOWLEDGE_GRAPH_EVALS, 'token-budget': TOKEN_BUDGET_EVALS,
  plan: PLAN_EVALS,
}
let total = 0
for (const [n, e] of Object.entries(tracks)) {
  console.log(`${n.padEnd(28)} ${e.length}`)
  total += e.length
}
console.log('-'.repeat(34))
console.log('TOTAL'.padEnd(28), total)
