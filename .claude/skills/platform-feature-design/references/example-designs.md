# Example: Notification System Design

## Starting Point (from Discovery)

**Session**: `notifications`
**Intent**: Add a notification system for alerting users about events

**Requirements**:
| ID | Priority | Description |
|----|----------|-------------|
| req-001 | must | Create notifications for various event types |
| req-002 | must | Mark notifications as read/unread |
| req-003 | should | Support notification preferences per user |
| req-004 | could | Batch notifications to reduce noise |

## Entity Extraction Process

**Step 1: Identify nouns**
- Notification, event, user, preferences

**Step 2: Classify each**

| Concept | Classification | Rationale |
|---------|---------------|-----------|
| Notification | Entity | Has lifecycle (created → read), queried independently |
| NotificationPreference | Entity | Queried separately from user, can be updated |
| Event type | Enum | Fixed set of known events |
| User | Reference only | Exists in another schema, just reference by ID |

## Conceptual Model

```
Notification
├── id: string (identifier)
├── userId: string (external reference)
├── type: enum (info, warning, action_required)
├── title: string
├── message: string
├── isRead: boolean
├── createdAt: number
└── readAt: number (optional)

NotificationPreference
├── id: string (identifier)
├── userId: string (external reference)
├── eventType: string
├── enabled: boolean
└── channel: enum (in_app, email, none)
```

## Coverage Check

| Requirement | Schema Element(s) | Status |
|-------------|-------------------|--------|
| req-001 | Notification entity with type enum | ✅ |
| req-002 | Notification.isRead, readAt | ✅ |
| req-003 | NotificationPreference entity | ✅ |
| req-004 | (Implementation concern, not schema) | N/A |

## Design Decisions Recorded

```
Question: Should preferences be embedded in User or separate entity?
Decision: Separate NotificationPreference entity
Rationale: Preferences are queried independently when deciding whether to send notification
```

```
Question: How to reference users from another schema?
Decision: Store userId as string, not MST reference
Rationale: User entity lives in auth schema, cross-schema references add complexity
```

## Key Takeaways

1. **Not everything needs an entity** - Event types became an enum, not an entity
2. **Cross-schema references** - Sometimes a string ID is simpler than MST reference
3. **Coverage gaps are OK** - req-004 is implementation logic, not data structure
4. **Record decisions** - Document why you made structural choices
