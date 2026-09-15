import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { slackAgentRoutes } from '../../apps/api/src/routes/slack-agent'

describe('Slack Agent ingress', () => {
  test('acknowledges a signed URL verification challenge', async () => {
    const originalSecret = process.env.SLACK_SIGNING_SECRET
    process.env.SLACK_SIGNING_SECRET = 'test-signing-secret'
    try {
      const app = slackAgentRoutes({ resolveUserId: async () => null })
      const body = JSON.stringify({
        type: 'url_verification',
        challenge: 'challenge-value',
      })
      const timestamp = String(Math.floor(Date.now() / 1000))
      const signature = `v0=${createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
        .update(`v0:${timestamp}:${body}`)
        .digest('hex')}`
      const response = await app.fetch(new Request('http://localhost/integrations/slack/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Slack-Request-Timestamp': timestamp,
          'X-Slack-Signature': signature,
        },
        body,
      }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ challenge: 'challenge-value' })
    } finally {
      if (originalSecret === undefined) delete process.env.SLACK_SIGNING_SECRET
      else process.env.SLACK_SIGNING_SECRET = originalSecret
    }
  })
})
