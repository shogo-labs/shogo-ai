#!/usr/bin/env bun
/**
 * Seed script to populate studio-chat with mock chat sessions and messages.
 *
 * Usage: bun scripts/seed-chat-sessions.ts
 *
 * Requires: DATABASE_URL environment variable (postgres connection string)
 */

import { randomUUID } from "crypto";
import { join } from "node:path";
import { loadSchema, domain } from "@shogo/state-api";
import {
  initializePostgresBackend,
  isPostgresAvailable,
  getGlobalBackendRegistry,
} from "../packages/mcp/src/postgres-init";

// Schemas path
const SCHEMAS_PATH = join(import.meta.dir, "../.schemas");

// Mock sessions from ChatSessionPicker.tsx
const mockChatSessions = [
  { id: "session-1", name: "Feature Planning", messageCount: 45, updatedAt: Date.now() - 1000 * 60 * 5 },
  { id: "session-2", name: "Bug Fix Discussion", messageCount: 12, updatedAt: Date.now() - 1000 * 60 * 15 },
  { id: "session-3", name: "API Design Review", messageCount: 28, updatedAt: Date.now() - 1000 * 60 * 30 },
  { id: "session-4", name: "Database Schema", messageCount: 67, updatedAt: Date.now() - 1000 * 60 * 60 },
  { id: "session-5", name: "Auth Implementation", messageCount: 34, updatedAt: Date.now() - 1000 * 60 * 60 * 2 },
  { id: "session-6", name: "UI Component Library", messageCount: 89, updatedAt: Date.now() - 1000 * 60 * 60 * 3 },
  { id: "session-7", name: "Performance Optimization", messageCount: 23, updatedAt: Date.now() - 1000 * 60 * 60 * 5 },
  { id: "session-8", name: "Testing Strategy", messageCount: 41, updatedAt: Date.now() - 1000 * 60 * 60 * 8 },
  { id: "session-9", name: "Deployment Pipeline", messageCount: 56, updatedAt: Date.now() - 1000 * 60 * 60 * 12 },
  { id: "session-10", name: "Code Review Notes", messageCount: 18, updatedAt: Date.now() - 1000 * 60 * 60 * 24 },
  { id: "session-11", name: "Sprint Planning", messageCount: 72, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 2 },
  { id: "session-12", name: "Architecture Discussion", messageCount: 95, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 2 },
  { id: "session-13", name: "Error Handling", messageCount: 31, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 3 },
  { id: "session-14", name: "State Management", messageCount: 48, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 4 },
  { id: "session-15", name: "Refactoring Plan", messageCount: 27, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 5 },
  { id: "session-16", name: "Documentation", messageCount: 15, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 6 },
  { id: "session-17", name: "Security Audit", messageCount: 63, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 7 },
  { id: "session-18", name: "Migration Strategy", messageCount: 82, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 10 },
  { id: "session-19", name: "Logging Setup", messageCount: 19, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 12 },
  { id: "session-20", name: "Caching Layer", messageCount: 37, updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 14 },
];

// Sample message templates for generating fake messages
const userMessages = [
  "Can you help me understand how this works?",
  "What's the best approach here?",
  "I'm seeing an error when I try to run this",
  "Let's refactor this section",
  "Can you review this implementation?",
  "What do you think about this approach?",
  "How should we handle this edge case?",
  "Can you explain the architecture?",
];

const assistantMessages = [
  "I'll analyze that for you. Based on the code...",
  "Here's what I'd recommend...",
  "Let me look into that error. It appears to be...",
  "Good idea! We can improve this by...",
  "The implementation looks solid. A few suggestions...",
  "That's a reasonable approach. Here's how I'd structure it...",
  "For that edge case, we should consider...",
  "The architecture follows a layered pattern where...",
];

// Generate ChatSession records matching studio-chat schema
function generateChatSessions() {
  return mockChatSessions.map((mock) => ({
    id: randomUUID(),
    name: mock.name,
    inferredName: mock.name,
    contextType: "feature" as const,
    contextId: "testbed-session",
    createdAt: mock.updatedAt - 1000 * 60 * 60,
    lastActiveAt: mock.updatedAt,
    _messageCount: mock.messageCount,
  }));
}

// Generate ChatMessage records for a session
function generateMessagesForSession(
  sessionId: string,
  messageCount: number,
  lastActiveAt: number
) {
  const messages = [];
  const timeSpan = 1000 * 60 * 60;
  const interval = timeSpan / messageCount;

  for (let i = 0; i < messageCount; i++) {
    const isUser = i % 2 === 0;
    const templateIndex = Math.floor(Math.random() * userMessages.length);

    messages.push({
      id: randomUUID(),
      session: sessionId,
      role: isUser ? "user" : "assistant",
      content: isUser ? userMessages[templateIndex] : assistantMessages[templateIndex],
      createdAt: lastActiveAt - timeSpan + i * interval,
    });
  }

  return messages;
}

async function main() {
  console.log("Initializing PostgreSQL backend...");
  await initializePostgresBackend();

  if (!isPostgresAvailable()) {
    console.error("PostgreSQL not available. Set DATABASE_URL environment variable.");
    process.exit(1);
  }

  console.log("Loading studio-chat schema...");
  const { enhanced } = await loadSchema("studio-chat", SCHEMAS_PATH);

  const d = domain({
    name: "studio-chat",
    from: enhanced,
  });

  const store = d.createStore({
    services: {
      backendRegistry: getGlobalBackendRegistry(),
    },
    context: {
      schemaName: "studio-chat",
      location: SCHEMAS_PATH,
    },
  });

  const sessions = generateChatSessions();
  let totalMessages = 0;

  // Clear existing seed data first
  console.log("\nClearing existing seed data...");
  const sessionNames = mockChatSessions.map((s) => s.name);

  for (const name of sessionNames) {
    const existing = await store.chatSessionCollection
      .query()
      .where({ name })
      .first();

    if (existing) {
      // Delete messages for this session
      const msgs = await store.chatMessageCollection
        .query()
        .where({ session: existing.id })
        .toArray();

      for (const msg of msgs) {
        await store.chatMessageCollection.deleteOne(msg.id);
      }

      await store.chatSessionCollection.deleteOne(existing.id);
      console.log(`  Deleted: ${name}`);
    }
  }

  console.log("\nCreating chat sessions...\n");

  for (const session of sessions) {
    const { _messageCount, ...sessionData } = session;

    console.log(`  Creating: ${sessionData.name} (${_messageCount} messages)`);

    // Create session
    await store.chatSessionCollection.insertOne(sessionData);

    // Create messages for this session
    const messages = generateMessagesForSession(
      sessionData.id,
      _messageCount,
      session.lastActiveAt
    );

    for (const msg of messages) {
      await store.chatMessageCollection.insertOne(msg);
    }

    totalMessages += messages.length;
  }

  console.log(`\n✓ Created ${sessions.length} sessions with ${totalMessages} messages`);

  process.exit(0);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
