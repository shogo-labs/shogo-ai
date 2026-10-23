# Higgsfield docs snapshot

Vendor documentation for [Higgsfield](https://higgsfield.ai), committed so the
endpoint ids, parameter enums and output shapes our media code depends on are
reviewable in the repo and checkable in CI — not remembered.

`bun run check:higgsfield-docs` fails when this snapshot and the code disagree.
`.github/workflows/higgsfield-docs-drift.yml` runs `bun run sync:higgsfield-docs --check`
weekly and opens an issue when the vendor's docs have moved on.

## Files

| File | What it is | sha256 |
| --- | --- | --- |
| `llms-full.txt` | The vendor's full documentation export, verbatim | sha256 `2fad4318604b12daa073b74affaf748b07fa6c62d006c5f0e5fdbb57f9ff995b` |
| `catalog.json` | Endpoint ids + schemas derived from `llms-full.txt` | sha256 `8651cce1b16204722ed7fa29d4ee3103037e04376ff63a0c72c592ecd458677b` |

The catalog carries every documented constraint per field — `enum`, `minimum`,
`maximum`, `multipleOf`, `default`, `title`, `minItems`/`maxItems`, `maxLength`
and the item schema of array-of-object fields (`multi_prompt[]`) — because the
generated media catalog and the request builder validate against these numbers
rather than restating them by hand.

## Where they came from

Fetched **2026-10-18**:

```
bun run sync:higgsfield-docs          # fetch llms-full.txt, re-derive catalog.json
```

Equivalent by hand:

```
curl -s https://docs.higgsfield.ai/llms-full.txt            -o docs/vendors/higgsfield/llms-full.txt
bun run derive:higgsfield-catalog
```

Notes:

- `llms-full.txt` is the source of truth here. It carries one section per model
  with an `**Endpoint ID:**` line and a "Complete JSON schema" block; it lists
  83 documented endpoints.
- `catalog.json` is generated, never hand-edited. Regenerate it with the command
  above; the check re-derives it and diffs the two.

## When the vendor changes something

1. Re-fetch `llms-full.txt` with the commands above.
2. `bun run scripts/derive-higgsfield-catalog.ts --write`
3. Update the sha256 values in this file.
4. `bun run check:higgsfield-docs` — it names every model or parameter in our
   catalog the new docs no longer support.

## What the code relies on

- **Async everywhere.** Submit returns `request_id` / `status_url` / `cancel_url`;
  poll `status_url` until the status is terminal. Only `completed` is billable —
  `failed`, `nsfw` and `canceled` are refunded upstream.
- **`/estimate/<endpoint>` is free**, and is the price we capture at submit and
  bill on completion (marked up like every other media charge).
- **Input media must be public URLs.** `POST /files/generate-upload-url` returns
  `public_url`, `upload_url` and `upload_headers`; the headers go on the `PUT`
  verbatim (they carry the retention tag) and the API key must not.
- **Auth** is `Authorization: Key <key>`; `Idempotency-Key` makes a retried
  submit safe.
- **Errors** are FastAPI envelopes: `detail` is a string or a list of
  `{loc, msg, type}`. A 400 carrying "concurrent" is the account concurrency
  limit, not a bad parameter.
