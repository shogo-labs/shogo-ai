# Chat Panel UX Redesign Proposal

## Design Philosophy: "Real-Time Orchestration Feedback"

Building on the established "Orchestrated Precision" design language from the Phase Panel work, this chat panel redesign aims to create a **responsive, information-dense communication interface** that makes AI orchestration feel tangible, traceable, and trustworthy.

**Core Principles:**
- **Streaming Responsiveness**: Every token arrival should feel immediate and purposeful
- **Hierarchical Activity**: Clear visual distinction between conversation, tool execution, and subagent work
- **Progressive Disclosure**: Dense information available on demand, minimal clutter by default
- **Continuity with Phase Panels**: Shared tokens, typography, and interaction patterns

---

## Current State Analysis

### What's Working

1. **Core Architecture is Sound**
   - `ChatPanel.tsx` (1147 lines) properly orchestrates useChat hook with domain persistence
   - AI SDK v3 integration with proper message.parts handling
   - Subagent progress tracking via data-progress events already implemented
   - Tool call extraction and display pipeline functional

2. **Existing Tool Call Display**
   - `ToolCallDisplay.tsx` has good foundations: collapsible, truncation, namespace icons
   - State machine (input-streaming -> input-available -> output-available -> output-error) correct
   - Metadata extraction for results works well

3. **Subagent Panel Infrastructure**
   - Progress events already streaming (subagent-start, subagent-stop, tool-complete)
   - recentTools array tracking last 8 tool calls
   - Category-based styling (MCP purple, File green, Skill orange)

### What's Not Working

1. **Visual Responsiveness Issues**
   - **Streaming feels sluggish**: Loading dots are the only feedback while tokens arrive
   - **No per-token animation**: Text appears in chunks without smooth reveal
   - **Subagent panel appears suddenly**: No transition, jarring when subagent starts

2. **Message Organization Problems**
   - **Tool calls interrupt reading flow**: Each tool call is a separate block between messages
   - **No grouping by conversation turn**: User message -> tool calls -> response should be a unit
   - **Subagent panel is at end of scroll**: Should be sticky/floating for visibility

3. **Tool Call Rendering Issues**
   - **All tool calls same visual weight**: store.create and store.query look identical
   - **No execution timeline**: Can't see temporal sequence of tool calls
   - **Collapsed state loses too much information**: Just tool name, no args summary
   - **No visual connection to result**: Tool output appears detached from tool call

4. **Visual Hierarchy Deficiencies**
   - **Assistant messages too plain**: Light muted background doesn't convey AI origin
   - **No turn boundaries**: Hard to see where one conversation turn ends and another begins
   - **Empty state uninspiring**: Generic "No messages yet" lacks invitation

5. **Consistency Gaps with Established Design**
   - **Missing phase colors**: Chat doesn't reflect current phase context
   - **Generic fonts**: Not using JetBrains Mono / Satoshi / Space Mono system
   - **No technical document aesthetic**: Doesn't match the "mission control" vibe

---

## Design Tokens Alignment

### Typography (from PHASE-PANEL-REDESIGN-CONCEPTS.md)

```css
--font-display: "JetBrains Mono", "IBM Plex Mono", monospace;
--font-body: "Satoshi", "General Sans", system-ui, sans-serif;
--font-micro: "Space Mono", monospace;
```

**Application to Chat:**
- **User messages**: `--font-body` for natural readability
- **Assistant messages**: `--font-body` with subtle monospace accents for code/tools
- **Tool names**: `--font-display` for technical precision
- **Metadata/timestamps**: `--font-micro` for data labels

### Color Tokens

```css
/* Tool Categories (extending existing) */
--tool-mcp:     #8B5CF6 (violet-500)    /* Wavesmith operations */
--tool-file:    #10B981 (emerald-500)   /* Read/Write/Edit/Glob/Grep */
--tool-skill:   #F59E0B (amber-500)     /* Skill/Task invocations */
--tool-bash:    #6B7280 (gray-500)      /* Terminal operations */

/* Execution States */
--exec-streaming: #3B82F6 (blue-500)    /* Input streaming */
--exec-pending:   #6B7280 (gray-500)    /* Waiting to execute */
--exec-running:   #F59E0B (amber-500)   /* Actively executing */
--exec-success:   #22C55E (green-500)   /* Completed successfully */
--exec-error:     #EF4444 (red-500)     /* Failed with error */

/* Subagent Colors (task-specific) */
--subagent-discovery:     var(--phase-discovery)
--subagent-analysis:      var(--phase-analysis)
--subagent-implementation: var(--phase-implementation)
```

---

## Detailed UX Recommendations

### 1. Streaming Responsiveness

**Problem**: Loading dots are the only visual feedback during streaming. Users can't see tokens arriving.

**Solution: Progressive Text Reveal Animation**

```tsx
// Concept: Each new chunk of text animates in with a subtle fade
interface StreamingTextProps {
  content: string
  isStreaming: boolean
}

function StreamingText({ content, isStreaming }: StreamingTextProps) {
  // Split into chunks that arrived together
  const chunks = useTextChunks(content)

  return (
    <div className="whitespace-pre-wrap">
      {chunks.map((chunk, i) => (
        <span
          key={i}
          className={cn(
            "transition-opacity duration-150",
            i === chunks.length - 1 && isStreaming
              ? "animate-fade-in"
              : "opacity-100"
          )}
        >
          {chunk}
        </span>
      ))}
      {isStreaming && <CursorBlink />}
    </div>
  )
}
```

**Visual Treatment:**
- Text fades in chunk-by-chunk (150ms transition)
- Blinking cursor at end during streaming (500ms pulse)
- Subtle glow on newest chunk (box-shadow with --exec-streaming)

**CSS Animation:**
```css
@keyframes fade-in-chunk {
  from { opacity: 0.3; }
  to { opacity: 1; }
}

.animate-fade-in {
  animation: fade-in-chunk 150ms ease-out forwards;
}

.cursor-blink {
  display: inline-block;
  width: 2px;
  height: 1.2em;
  background: var(--exec-streaming);
  animation: blink 500ms infinite;
}
```

### 2. Conversation Turn Grouping

**Problem**: Tool calls appear as separate blocks, breaking the conversation flow.

**Solution: Turn-Based Message Grouping**

```
+----------------------------------------------------------+
| USER TURN                                                |
+----------------------------------------------------------+
| [Avatar] You                                    12:34 PM |
|                                                          |
| "Create a requirement for user authentication            |
|  with OAuth support"                                     |
+----------------------------------------------------------+

+----------------------------------------------------------+
| ASSISTANT TURN                                           |
+----------------------------------------------------------+
| [Avatar] Claude                                 12:34 PM |
|                                                          |
| [TOOL TIMELINE - Collapsible]                           |
| +------------------------------------------------------+|
| | > store.create(Requirement)           [SUCCESS] 0.2s ||
| | > store.query(FeatureSession)         [SUCCESS] 0.1s ||
| +------------------------------------------------------+|
|                                                          |
| "I've created the requirement with ID `req-001`.         |
|  The OAuth support requirement has been added to the     |
|  must-have priority list."                              |
+----------------------------------------------------------+
```

**Component Structure:**
```tsx
interface ConversationTurn {
  role: "user" | "assistant"
  messages: Message[]  // Can include multiple messages in one turn
  toolCalls: ExtractedToolCall[]
  timestamp: Date
}

function TurnGroup({ turn }: { turn: ConversationTurn }) {
  const [toolsExpanded, setToolsExpanded] = useState(false)

  return (
    <div className={cn(
      "rounded-lg border mb-4",
      turn.role === "user"
        ? "border-primary/30 bg-primary/5"
        : "border-muted bg-muted/30"
    )}>
      {/* Turn header */}
      <TurnHeader role={turn.role} timestamp={turn.timestamp} />

      {/* Tool timeline (assistant turns only) */}
      {turn.toolCalls.length > 0 && (
        <ToolTimeline
          tools={turn.toolCalls}
          expanded={toolsExpanded}
          onToggle={() => setToolsExpanded(!toolsExpanded)}
        />
      )}

      {/* Message content */}
      <div className="px-4 pb-4">
        {turn.messages.map(msg => (
          <MessageContent key={msg.id} message={msg} />
        ))}
      </div>
    </div>
  )
}
```

### 3. Tool Timeline Visualization

**Problem**: Tool calls appear as disconnected blocks. No temporal relationship visible.

**Solution: Compact Horizontal Timeline**

```
+----------------------------------------------------------+
| TOOL EXECUTION TIMELINE (3 tools)              [Expand]  |
+----------------------------------------------------------+
| store.create -----> store.query -----> view.execute      |
| [Req]   0.2s       [Session] 0.1s    [Summary] 0.3s      |
|    |                   |                  |               |
|   [=]                 [=]                [=]              |
| SUCCESS             SUCCESS            SUCCESS           |
+----------------------------------------------------------+
```

**Expanded View:**
```
+----------------------------------------------------------+
| TOOL EXECUTION TIMELINE                      [Collapse]  |
+----------------------------------------------------------+
|                                                          |
| 1. store.create (Requirement)                            |
|    +--------------------------------------------------+ |
|    | model: "Requirement"                              | |
|    | data: { description: "OAuth...", priority: "must"| |
|    +--------------------------------------------------+ |
|    | Result: { ok: true, id: "req-001" }      0.23s   | |
|    +--------------------------------------------------+ |
|                                                          |
| 2. store.query (FeatureSession)                          |
|    +--------------------------------------------------+ |
|    | model: "FeatureSession", filter: { id: "..." }   | |
|    +--------------------------------------------------+ |
|    | Result: { count: 1, data: [...] }       0.08s    | |
|    +--------------------------------------------------+ |
|                                                          |
+----------------------------------------------------------+
```

**Component:**
```tsx
function ToolTimeline({ tools, expanded, onToggle }: ToolTimelineProps) {
  if (tools.length === 0) return null

  const totalDuration = tools.reduce((sum, t) => sum + (t.duration || 0), 0)
  const allSuccess = tools.every(t => t.state === "output-available")

  return (
    <div className="border-t border-b border-border/50 bg-muted/20 px-4 py-2">
      {/* Collapsed: Horizontal flow */}
      {!expanded && (
        <div className="flex items-center gap-3">
          <button
            onClick={onToggle}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className="h-3 w-3" />
            <span className="font-mono">{tools.length} tools</span>
            <span className="text-[10px]">({totalDuration.toFixed(1)}s)</span>
          </button>

          {/* Mini timeline */}
          <div className="flex items-center gap-1 flex-1">
            {tools.map((tool, i) => (
              <Fragment key={i}>
                <ToolPill tool={tool} />
                {i < tools.length - 1 && (
                  <ArrowRight className="h-3 w-3 text-muted-foreground/50" />
                )}
              </Fragment>
            ))}
          </div>

          {/* Status indicator */}
          {allSuccess ? (
            <CheckCircle className="h-4 w-4 text-green-500" />
          ) : (
            <AlertCircle className="h-4 w-4 text-amber-500" />
          )}
        </div>
      )}

      {/* Expanded: Full detail view */}
      {expanded && (
        <div className="space-y-3">
          <button
            onClick={onToggle}
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <ChevronDown className="h-3 w-3" />
            <span className="font-semibold">Tool Execution Timeline</span>
          </button>

          {tools.map((tool, i) => (
            <ToolCallDetail key={i} tool={tool} index={i + 1} />
          ))}
        </div>
      )}
    </div>
  )
}
```

### 4. Subagent Progress Overlay

**Problem**: Subagent panel appears at end of scroll, easily missed. No sense of active orchestration.

**Solution: Sticky Floating Subagent Card**

```
+----------------------------------------------------------+
|                    CHAT MESSAGES                         |
|                        ...                               |
|                                                          |
+----------------------------------------------------------+
|  +----------------------------------------------------+  |
|  |  [SUBAGENT ACTIVE]             platform-analysis   |  |
|  |  ------------------------------------------------  |  |
|  |  Running for 12s                                   |  |
|  |                                                    |  |
|  |  Recent Activity:                                  |  |
|  |  o wavesmith.store_query        now               |  |
|  |  o Grep                         2s ago            |  |
|  |  o Read                         5s ago            |  |
|  |  o wavesmith.store_create       8s ago            |  |
|  |                                                    |  |
|  |  [||||||||||||||||||||  ] 23 tools executed       |  |
|  +----------------------------------------------------+  |
+----------------------------------------------------------+
|  [Message Input Area]                                    |
+----------------------------------------------------------+
```

**Positioning & Animation:**
- Card is `position: sticky; bottom: 80px` (above input)
- Animates in from bottom when subagent starts (`translate-y: 20px -> 0`)
- Subtle pulse on activity (`box-shadow` glow)
- Auto-minimizes to pill after 3s of inactivity

**Minimized State:**
```
+----------------------------------------------------------+
|                    CHAT MESSAGES                         |
+----------------------------------------------------------+
|  [pill] platform-analysis | 23 tools | 12s     [expand]  |
+----------------------------------------------------------+
|  [Message Input Area]                                    |
+----------------------------------------------------------+
```

**Component:**
```tsx
function SubagentOverlay({ subagents, recentTools }: SubagentOverlayProps) {
  const [isMinimized, setIsMinimized] = useState(false)
  const activeSubagent = Array.from(subagents.values())
    .find(s => s.status === 'running')

  if (!activeSubagent) return null

  const elapsed = Math.floor((Date.now() - activeSubagent.startTime) / 1000)

  return (
    <div className={cn(
      "sticky bottom-20 mx-4 z-10 transition-all duration-300",
      isMinimized ? "transform translate-y-2" : ""
    )}>
      {isMinimized ? (
        // Pill view
        <button
          onClick={() => setIsMinimized(false)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-sm"
        >
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          <span className="font-mono text-blue-600">{activeSubagent.agentType}</span>
          <span className="text-muted-foreground">|</span>
          <span className="text-xs">{activeSubagent.toolCount} tools</span>
          <span className="text-muted-foreground">|</span>
          <span className="text-xs">{elapsed}s</span>
          <ChevronUp className="h-3 w-3 ml-1" />
        </button>
      ) : (
        // Expanded card
        <div className="rounded-lg border border-blue-500/30 bg-card/95 backdrop-blur shadow-lg">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border/50">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Subagent Active
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-xs">
                {activeSubagent.agentType}
              </Badge>
              <button
                onClick={() => setIsMinimized(true)}
                className="p-1 hover:bg-muted rounded"
              >
                <Minimize2 className="h-3 w-3" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="px-4 py-3 space-y-3">
            <div className="text-xs text-muted-foreground">
              Running for <span className="font-mono text-foreground">{elapsed}s</span>
            </div>

            {/* Recent activity */}
            <div className="space-y-1">
              <div className="text-xs font-semibold text-muted-foreground">Recent Activity</div>
              {recentTools.slice(0, 4).map((tool, i) => (
                <ToolActivityRow key={tool.id} tool={tool} recency={i} />
              ))}
            </div>

            {/* Progress bar */}
            <div className="space-y-1">
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-blue-500 animate-pulse"
                  style={{ width: "60%" }}
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {activeSubagent.toolCount} tools executed
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
```

### 5. Enhanced Message Styling

**Problem**: Assistant messages lack visual distinction and phase context.

**Solution: Phase-Aware Message Styling**

```tsx
function AssistantMessage({ message, phase }: AssistantMessageProps) {
  const phaseColor = usePhaseColor(phase)

  return (
    <div className={cn(
      "rounded-lg p-4",
      "bg-gradient-to-br from-muted/50 to-muted/30",
      "border-l-4",
      phaseColor.border  // Left accent matches current phase
    )}>
      {/* Message header */}
      <div className="flex items-center gap-2 mb-2">
        <Bot className={cn("h-4 w-4", phaseColor.text)} />
        <span className="text-xs font-semibold text-muted-foreground">Claude</span>
        {phase && (
          <Badge variant="secondary" className="text-[10px]">
            {phase}
          </Badge>
        )}
      </div>

      {/* Content with markdown rendering */}
      <div className="prose prose-sm dark:prose-invert max-w-none">
        <StreamingText content={message.content} isStreaming={isStreaming} />
      </div>
    </div>
  )
}
```

**User Message Enhancement:**
```tsx
function UserMessage({ message }: UserMessageProps) {
  return (
    <div className="flex justify-end">
      <div className={cn(
        "max-w-[85%] rounded-lg px-4 py-3",
        "bg-primary text-primary-foreground",
        "shadow-sm"
      )}>
        <div className="flex items-center justify-between gap-4 mb-1">
          <span className="text-xs opacity-70">You</span>
          <span className="text-[10px] opacity-50">
            {formatTime(message.timestamp)}
          </span>
        </div>
        <div className="whitespace-pre-wrap text-sm">
          {message.content}
        </div>
      </div>
    </div>
  )
}
```

### 6. Empty State Enhancement

**Problem**: Generic empty state lacks invitation and context.

**Solution: Phase-Contextual Empty State**

```
+----------------------------------------------------------+
|                                                          |
|                    [Terminal Icon]                       |
|                                                          |
|        Ready for Discovery Phase Commands                |
|                                                          |
|  Suggested prompts:                                      |
|                                                          |
|  > "Describe your feature in natural language"          |
|                                                          |
|  > "What authentication methods should we support?"      |
|                                                          |
|  > "Add requirements for error handling"                |
|                                                          |
|  [Type a message to begin orchestration...]             |
|                                                          |
+----------------------------------------------------------+
```

**Component:**
```tsx
const PHASE_SUGGESTIONS: Record<string, string[]> = {
  discovery: [
    "Describe your feature in natural language",
    "What are the core requirements for this feature?",
    "Add requirements for error handling",
  ],
  analysis: [
    "Analyze the codebase for existing patterns",
    "What integration points should we consider?",
    "Identify potential risks and gaps",
  ],
  design: [
    "Generate the schema for this feature",
    "What entities do we need?",
    "Create the domain model",
  ],
  // ... etc
}

function EmptyState({ phase }: { phase: string }) {
  const suggestions = PHASE_SUGGESTIONS[phase] || PHASE_SUGGESTIONS.discovery
  const phaseColor = usePhaseColor(phase)

  return (
    <div className="flex flex-col items-center justify-center h-full py-12 px-6 text-center">
      <Terminal className={cn("h-12 w-12 mb-4", phaseColor.text, "opacity-50")} />

      <h3 className="text-lg font-semibold mb-2">
        Ready for {capitalizeFirst(phase)} Phase Commands
      </h3>

      <p className="text-sm text-muted-foreground mb-6">
        Start the AI orchestration by typing a message below
      </p>

      <div className="space-y-2 w-full max-w-md">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Suggested prompts
        </div>
        {suggestions.map((suggestion, i) => (
          <button
            key={i}
            className={cn(
              "w-full text-left px-4 py-3 rounded-lg",
              "bg-muted/30 hover:bg-muted/50 transition-colors",
              "border border-transparent hover:border-muted",
              "text-sm text-muted-foreground"
            )}
          >
            <span className="text-foreground/70">&gt;</span> "{suggestion}"
          </button>
        ))}
      </div>
    </div>
  )
}
```

---

## Component Structure Recommendations

### Proposed Component Hierarchy

```
ChatPanel (smart component)
├── ChatHeader
│   ├── SessionName
│   ├── PhaseIndicator (new)
│   ├── StreamingStatus (new)
│   └── CollapseButton
│
├── MessageArea
│   ├── EmptyState (phase-aware)
│   │
│   └── TurnList (new grouping component)
│       └── TurnGroup (repeated)
│           ├── TurnHeader (avatar, role, timestamp)
│           ├── ToolTimeline (collapsible, horizontal)
│           │   └── ToolCallDetail (on expand)
│           └── MessageContent
│               └── StreamingText
│
├── SubagentOverlay (sticky, floating) [new]
│   ├── SubagentHeader
│   ├── RecentActivityList
│   └── ProgressIndicator
│
└── ChatInput
    ├── TextArea
    └── SendButton
```

### File Structure

```
apps/web/src/components/app/chat/
├── ChatPanel.tsx           # Smart orchestrator
├── ChatHeader.tsx          # (enhanced)
├── ChatInput.tsx           # (unchanged)
├── ChatMessage.tsx         # (deprecated, replaced by TurnGroup)
├── MessageList.tsx         # (deprecated, replaced by TurnList)
├── ToolCallDisplay.tsx     # (deprecated, replaced by ToolTimeline)
├── ExpandTab.tsx           # (unchanged)
├── ChatContext.tsx         # (unchanged)
│
├── turns/                  # NEW: Turn-based components
│   ├── TurnList.tsx
│   ├── TurnGroup.tsx
│   ├── TurnHeader.tsx
│   └── MessageContent.tsx
│
├── tools/                  # NEW: Tool visualization
│   ├── ToolTimeline.tsx
│   ├── ToolPill.tsx
│   ├── ToolCallDetail.tsx
│   └── ToolActivityRow.tsx
│
├── streaming/              # NEW: Streaming UX
│   ├── StreamingText.tsx
│   ├── CursorBlink.tsx
│   └── StreamingStatus.tsx
│
├── subagent/               # NEW: Subagent display
│   ├── SubagentOverlay.tsx
│   ├── SubagentCard.tsx
│   └── SubagentPill.tsx
│
└── empty/                  # NEW: Empty states
    └── PhaseEmptyState.tsx
```

---

## Interaction Patterns

### 1. Tool Timeline Toggle

**Default**: Collapsed horizontal flow showing tool names and status
**Click header**: Expand to full detail view with args and results
**Double-click tool pill**: Jump to expand that specific tool

### 2. Subagent Overlay Behavior

**On subagent-start**: Overlay slides up from bottom (300ms ease-out)
**During activity**: Pulse effect on each tool-complete event
**After 3s idle**: Auto-minimize to pill
**Click pill**: Expand back to full card
**On subagent-stop**: Fade out after 2s delay (allow user to see final state)

### 3. Message Streaming

**First token**: Message bubble appears immediately
**Subsequent tokens**: Fade in with 150ms transition
**Cursor**: Blink at end of content during streaming
**Scroll**: Auto-scroll to bottom, pause if user scrolls up manually

### 4. Keyboard Navigation

- `Enter`: Send message (existing)
- `Shift+Enter`: New line (existing)
- `Esc`: Collapse all tool timelines
- `Cmd/Ctrl + .`: Minimize/restore subagent overlay
- `Arrow Up` (when input empty): Edit last user message

---

## Visual Mockup Descriptions

### Mockup 1: Full Chat Panel in Discovery Phase

```
+----------------------------------------------------------+
| [Bot] Discovery                        [Loading...] [-]  |
+----------------------------------------------------------+
|                                                          |
| +------------------------------------------------------+ |
| | [You]                                     10:32 AM   | |
| | "Create requirements for OAuth authentication        | |
| |  supporting Google and GitHub providers"             | |
| +------------------------------------------------------+ |
|                                                          |
| +------------------------------------------------------+ |
| | [Claude] Discovery                        10:32 AM   | |
| |                                                      | |
| | [TOOLS] store.create -> store.query    [v] 0.4s     | |
| |                                                      | |
| | I've created two requirements for OAuth              | |
| | authentication:                                      | |
| |                                                      | |
| | 1. **Google OAuth Integration** (must-have)          | |
| |    - Implement OAuth 2.0 flow for Google            | |
| |    - Handle token refresh and revocation            | |
| |                                                      | |
| | 2. **GitHub OAuth Integration** (must-have)          | |
| |    - Implement OAuth flow for GitHub                 | |
| |    - Support organization access scopes_            | |
| +------------------------------------------------------+ |
|                                                          |
+----------------------------------------------------------+
| +----------------------------------------------------+  |
| | [SUBAGENT] platform-analysis | 8 tools | 5s  [_]   |  |
| +----------------------------------------------------+  |
+----------------------------------------------------------+
| [Type a message...]                            [Send]    |
+----------------------------------------------------------+
```

### Mockup 2: Expanded Tool Timeline

```
+----------------------------------------------------------+
| TOOL EXECUTION TIMELINE                      [Collapse]  |
+----------------------------------------------------------+
|                                                          |
| 1. mcp.wavesmith.store_create                           |
|    +--------------------------------------------------+ |
|    | Arguments:                                        | |
|    | {                                                 | |
|    |   "model": "Requirement",                         | |
|    |   "schema": "platform-features",                  | |
|    |   "data": {                                       | |
|    |     "description": "Google OAuth...",            | |
|    |     "priority": "must"                            | |
|    |   }                                               | |
|    | }                                                 | |
|    +--------------------------------------------------+ |
|    | [SUCCESS] Result:              Duration: 0.23s   | |
|    | { "ok": true, "id": "req-001" }                   | |
|    +--------------------------------------------------+ |
|                                                          |
| 2. mcp.wavesmith.store_create                           |
|    +--------------------------------------------------+ |
|    | Arguments: {...}                                  | |
|    +--------------------------------------------------+ |
|    | [SUCCESS] { "ok": true, "id": "req-002" } 0.18s  | |
|    +--------------------------------------------------+ |
|                                                          |
+----------------------------------------------------------+
```

### Mockup 3: Minimized Subagent Pill

```
+----------------------------------------------------------+
|          ...chat messages...                             |
+----------------------------------------------------------+
|                                                          |
|  [*] platform-analysis | 23 tools | 12s          [^]    |
|                                                          |
+----------------------------------------------------------+
| [Type a message...]                            [Send]    |
+----------------------------------------------------------+
```

---

## Implementation Roadmap

### Phase 1: Foundation (2-3 days)
1. Add CSS variables for tool and execution state colors
2. Add typography CSS variables aligned with design tokens
3. Create `StreamingText` component with chunk animation
4. Create `CursorBlink` component

### Phase 2: Turn Grouping (3-4 days)
1. Create `TurnGroup` component structure
2. Create `TurnHeader` component
3. Refactor `ChatPanel` to group messages into turns
4. Create `MessageContent` wrapper with phase styling

### Phase 3: Tool Timeline (3-4 days)
1. Create `ToolTimeline` component (collapsed view)
2. Create `ToolPill` component
3. Create `ToolCallDetail` component (expanded view)
4. Integrate timeline into `TurnGroup`

### Phase 4: Subagent Overlay (2-3 days)
1. Create `SubagentOverlay` container
2. Create `SubagentCard` expanded view
3. Create `SubagentPill` minimized view
4. Add auto-minimize logic and animations

### Phase 5: Polish (2-3 days)
1. Enhanced empty states with phase suggestions
2. Keyboard navigation improvements
3. Animation timing refinement
4. Accessibility audit (focus management, ARIA labels)

### Phase 6: Testing (2 days)
1. Unit tests for new components
2. Integration tests for turn grouping
3. Visual regression tests
4. Performance profiling (streaming with many messages)

---

## Accessibility Considerations

1. **ARIA Live Regions**: New tool completions announced via `aria-live="polite"`
2. **Focus Management**: When subagent overlay appears, don't steal focus from input
3. **Reduced Motion**: Respect `prefers-reduced-motion` for all animations
4. **High Contrast**: All status colors have sufficient contrast ratios
5. **Screen Reader**: Tool timeline has proper `aria-expanded` and `aria-controls`
6. **Keyboard**: All interactive elements reachable via Tab, expandable via Enter/Space

---

## Performance Considerations

1. **Virtualization**: For long conversations (>50 turns), virtualize the turn list
2. **Memo**: Memoize `TurnGroup` and `ToolTimeline` to prevent re-renders
3. **Debounce**: Debounce scroll position tracking for auto-scroll logic
4. **CSS Animations**: Use `transform` and `opacity` only for GPU acceleration
5. **Lazy Load**: Tool call details only render when timeline expanded

---

## Summary

This redesign transforms the Chat Panel from a basic message stream into an **orchestration control center** that makes AI work visible, understandable, and trustworthy. Key improvements:

1. **Streaming feels alive** with progressive text reveal and cursor animation
2. **Tool calls are grouped** into conversation turns with collapsible timelines
3. **Subagent work is visible** via sticky floating overlay with activity feed
4. **Phase context is maintained** through colors, styling, and empty state suggestions
5. **Design language is consistent** with the established "Orchestrated Precision" aesthetic

The implementation is modular, allowing for incremental rollout while maintaining backward compatibility with existing message rendering during the transition.
