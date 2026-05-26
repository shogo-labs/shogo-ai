// Stub for test environments — exports only the subset used by
// packages/shogo-worker tests, deliberately NOT re-exporting from
// src/index.ts (which transitively imports @shogo-ai/voice, which has
// no dist build and is unavailable in CI).
export { CloudFileTransport } from '../src/projects/cloud-file-transport.ts';
