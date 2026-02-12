---
sidebar_position: 4
title: Email
slug: /sdk/email
---

# SDK Email

The Shogo SDK includes email functionality so your apps can send transactional emails — welcome messages, notifications, password resets, and more.

## Supported providers

- **SMTP** — Connect any SMTP email service (Gmail, Mailgun, SendGrid, etc.)
- **AWS SES** — Amazon Simple Email Service for high-volume sending

## Setup

Configure the email provider when initializing the client:

```typescript
import { createClient } from '@shogo-ai/sdk';

const client = createClient({
  projectId: 'my-app',
  email: {
    provider: 'smtp',
    host: 'smtp.example.com',
    port: 587,
    auth: {
      user: 'your-email@example.com',
      pass: 'your-password',
    },
  },
});
```

## Sending a basic email

```typescript
await client.email.send({
  to: 'customer@example.com',
  subject: 'Welcome to Our App!',
  text: 'Thanks for signing up. We are glad to have you.',
  html: '<h1>Welcome!</h1><p>Thanks for signing up. We are glad to have you.</p>',
});
```

## Using email templates

Define reusable templates and fill them with dynamic data:

```typescript
// Send a welcome email using a template
await client.email.sendTemplate({
  to: 'customer@example.com',
  template: 'welcome',
  data: {
    name: 'Alice',
    appName: 'My App',
    loginUrl: 'https://myapp.shogo.one/login',
  },
});
```

## Sending to multiple recipients

```typescript
await client.email.send({
  to: ['alice@example.com', 'bob@example.com'],
  subject: 'Team Update',
  text: 'Here is the weekly team update...',
});
```

## Email options

| Option | Type | Description |
|--------|------|-------------|
| `to` | `string` or `string[]` | Recipient email address(es) |
| `subject` | `string` | Email subject line |
| `text` | `string` | Plain text body |
| `html` | `string` | HTML body (optional) |
| `from` | `string` | Sender address (optional, uses default) |
| `replyTo` | `string` | Reply-to address (optional) |

## Error handling

```typescript
try {
  await client.email.send({
    to: 'customer@example.com',
    subject: 'Test',
    text: 'Hello!',
  });
  console.log('Email sent successfully');
} catch (error) {
  console.error('Failed to send email:', error.message);
}
```

## Common use cases

### Welcome email after registration

```typescript
// After a user signs up
const user = await client.auth.signUp({ email, password, name });

await client.email.sendTemplate({
  to: user.email,
  template: 'welcome',
  data: { name: user.name },
});
```

### Order confirmation

```typescript
await client.email.sendTemplate({
  to: order.customerEmail,
  template: 'order-confirmation',
  data: {
    orderNumber: order.id,
    items: order.items,
    total: order.total,
  },
});
```

### Notification

```typescript
await client.email.send({
  to: user.email,
  subject: 'New comment on your post',
  text: `${commenter.name} commented on "${post.title}": ${comment.text}`,
});
```
