/**
 * Every always-on Knative Service (min-scale >= 1) in a deployed overlay must
 * set `autoscaling.knative.dev/target-burst-capacity: "0"`.
 *
 * Without it the activator stays in the request path whenever capacity is
 * below the default burst capacity (e.g. a fresh api revision at min-scale 2).
 * Streams proxied through it get the activator's ~5-min request cap, and one
 * still open when the revision is GC'd pins that revision in the activator's
 * concurrency reporter forever: an "Error while getting revision" log line per
 * second per dead revision plus a memory leak until the activator OOMs.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, parseAllDocuments } from 'yaml'

const root = resolve(import.meta.dir, '../../../..')
const OVERLAYS = ['staging', 'production-us', 'production-eu']

function knativeServices(overlay: string) {
  const dir = resolve(root, 'k8s/overlays', overlay)
  const kustomization = parse(readFileSync(resolve(dir, 'kustomization.yaml'), 'utf-8'))
  const out: { file: string; name: string; annotations: Record<string, string> }[] = []
  for (const file of kustomization.resources as string[]) {
    for (const doc of parseAllDocuments(readFileSync(resolve(dir, file), 'utf-8'))) {
      const obj = doc.toJS()
      if (obj?.kind !== 'Service' || !String(obj.apiVersion).startsWith('serving.knative.dev/')) continue
      out.push({ file: `${overlay}/${file}`, name: obj.metadata.name, annotations: obj.spec?.template?.metadata?.annotations ?? {} })
    }
  }
  return out
}

describe('Knative activator stays off the path of always-on services', () => {
  for (const overlay of OVERLAYS) {
    test(overlay, () => {
      const services = knativeServices(overlay)
      expect(services.map((s) => s.name)).toContain('api')
      for (const s of services) {
        const minScale = Number(s.annotations['autoscaling.knative.dev/min-scale'] ?? 0)
        if (minScale < 1) continue
        expect(s.annotations['autoscaling.knative.dev/target-burst-capacity'], `${s.file} (${s.name})`).toBe('0')
      }
    })
  }
})
