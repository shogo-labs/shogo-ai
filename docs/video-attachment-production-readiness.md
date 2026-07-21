# Video Attachment Production Readiness Plan

Generated from the July 2026 video attachment readiness assessment.

## Current State

Video attachments are ready for normal usage and controlled rollout. The current implementation supports common video extensions, MIME fallback by filename, client-side frame extraction and dedupe on web/desktop, LLM video context attachments, original video preservation, and targeted regression coverage.

The feature is not yet fully hardened for a broad 10k+ user launch. The largest remaining risks are operational: server-side media processing, async jobs, upload reliability, audio transcription, quota enforcement, storage lifecycle cleanup, abuse protection, and observability.

## Implemented Guardrails

- Common video MIME types and extensions are centralized in `@shogo-ai/core/video-attachment-contract`.
- Web/desktop clients sample representative frames and add a video context text attachment.
- Original videos are saved into the agent workspace for later inspection.
- The agent runtime now enforces shared server-side video upload limits while persisting attachments:
  - maximum videos per message
  - maximum decoded video bytes per upload
  - rejected uploads are reported in hidden runtime context so the model does not assume missing files were saved

## Phase 1: Server-Side Video Processing

Goal: make video understanding consistent across web, desktop, iOS, and Android.

- Add a backend worker that invokes FFmpeg for metadata extraction.
- Extract representative frames server-side with the same shared limits used by clients.
- Deduplicate extracted frames before model submission.
- Store derived frames and metadata beside the raw video object.
- Return processing status to chat clients.

## Phase 2: Async Upload and Processing Pipeline

Goal: prevent large videos from blocking chat requests or API workers.

- Introduce a durable processing queue with retries, timeouts, and a dead-letter queue.
- Move FFmpeg work outside the main API process.
- Add upload progress, cancellation, retry, and resumable upload support.
- Surface actionable states: uploading, processing, ready, failed, and partially processed.

## Phase 3: Audio Understanding

Goal: make narrated bug reports and walkthroughs understandable.

- Extract audio tracks in the worker.
- Transcribe audio with timestamps.
- Attach transcript text beside visual frames and video metadata.
- Keep transcript failure independent from visual frame success.

## Phase 4: Quotas, Abuse Protection, and Storage Lifecycle

Goal: control cost, abuse, and storage growth at scale.

- Enforce per-user and per-workspace upload quotas server-side.
- Rate limit failed uploads and repeated video processing attempts.
- Validate actual media type, codecs, corrupt files, extreme resolutions, and polyglot files.
- Run FFmpeg in an isolated sandbox with concurrency controls.
- Define retention rules for raw videos, frames, transcripts, failed uploads, deleted workspaces, and orphaned objects.

## Phase 5: Observability and QA

Goal: make failures visible before they become user-wide incidents.

- Track upload success rate, processing success rate, processing latency, payload size, frame count, storage growth, FFmpeg failures, mobile failures, and cost per video message.
- Add dashboards and alerts for queue depth, dead-letter volume, failure spikes, and storage growth.
- Expand QA across iOS simulator, real iPhone, Android emulator, real Android, desktop web, Safari, Chrome, Firefox, slow networks, backgrounding, camera videos, screen recordings, huge videos, corrupt files, and unsupported codecs.

## Production Launch Criteria

- Server-side metadata and frame extraction are available for all platforms.
- Video processing runs asynchronously outside API request handling.
- Upload retries and resumable uploads are implemented for mobile and web.
- Audio transcription is attached when available and fails independently.
- Server-side quotas and rate limits are enforced and observable.
- Storage cleanup jobs cover raw and derived media.
- Dashboards and alerts exist for upload, processing, storage, and model-cost metrics.