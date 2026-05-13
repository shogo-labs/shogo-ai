<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# @shogo-ai/email

Multi-provider transactional email with sane templates baked in.

| Provider | Peer dep |
| --- | --- |
| AWS SES | `@aws-sdk/client-ses` |
| SMTP (any) | `nodemailer` |
| OCI Email Delivery | `nodemailer` (uses OCI's SMTP interface) |

Provider drivers are dynamically `import()`-ed, so you only install
the peer matching your chosen provider.

## Quickstart

```ts
import { createEmailServerFromEnv } from '@shogo-ai/email/server'

// Auto-selects based on env (EMAIL_PROVIDER=ses|smtp|oci)
const email = await createEmailServerFromEnv()
await email.sendTemplate('welcome', { to: 'a@b.com', data: { name: 'Ada' } })
```

## License

MIT — see [LICENSE](./LICENSE).
