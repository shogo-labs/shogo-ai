import { afterEach, describe, expect, test } from 'bun:test'
import { getLlmCaptureS3Client, resetS3Client } from '../s3'

const saved = { ...process.env }

afterEach(() => {
  for (const key of ['S3_REGION', 'S3_ENDPOINT', 'S3_LLM_CAPTURES_REGION', 'S3_LLM_CAPTURES_ENDPOINT']) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  resetS3Client()
})

async function endpointOf(): Promise<{ region: string; host: string }> {
  const client = getLlmCaptureS3Client()
  const endpoint = await client.config.endpoint!()
  return { region: await client.config.region(), host: endpoint.hostname }
}

describe('getLlmCaptureS3Client', () => {
  test('keeps captures in the serving region when the shared endpoint points elsewhere', async () => {
    process.env.S3_REGION = 'us-ashburn-1'
    process.env.S3_ENDPOINT = 'https://ns.compat.objectstorage.us-ashburn-1.oraclecloud.com'
    process.env.S3_LLM_CAPTURES_REGION = 'eu-frankfurt-1'
    process.env.S3_LLM_CAPTURES_ENDPOINT = 'https://ns.compat.objectstorage.eu-frankfurt-1.oraclecloud.com'
    resetS3Client()

    expect(await endpointOf()).toEqual({ region: 'eu-frankfurt-1', host: 'ns.compat.objectstorage.eu-frankfurt-1.oraclecloud.com' })
  })

  test('falls back to the shared S3 endpoint when no capture override is set', async () => {
    process.env.S3_REGION = 'us-ashburn-1'
    process.env.S3_ENDPOINT = 'https://ns.compat.objectstorage.us-ashburn-1.oraclecloud.com'
    delete process.env.S3_LLM_CAPTURES_REGION
    delete process.env.S3_LLM_CAPTURES_ENDPOINT
    resetS3Client()

    expect(await endpointOf()).toEqual({ region: 'us-ashburn-1', host: 'ns.compat.objectstorage.us-ashburn-1.oraclecloud.com' })
  })
})
