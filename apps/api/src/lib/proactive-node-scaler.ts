/**
 * Proactive Node Scaler
 *
 * Monitors node capacity and proactively scales the EKS Auto Scaling Group
 * BEFORE pods go Pending. This eliminates the 2-3 minute delay where the
 * cluster-autoscaler reactively waits for unschedulable pods.
 *
 * The scaler works by:
 * 1. Querying current node allocatable resources via K8s API
 * 2. Estimating how many pods can still fit on existing nodes
 * 3. When the warm pool controller is about to create N pods, checking
 *    if those pods will fit — if not, bumping the ASG desired count first
 * 4. Emitting OTEL metrics for warm pool availability and node headroom
 */

import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
  SetDesiredCapacityCommand,
} from '@aws-sdk/client-auto-scaling'
import { trace, SpanStatusCode, type Span } from '@opentelemetry/api'

const scalerTracer = trace.getTracer('shogo-node-scaler')

const AWS_REGION = process.env.AWS_REGION || process.env.S3_REGION || 'us-east-1'
const EKS_ASG_NAME = process.env.EKS_ASG_NAME || ''
const PROACTIVE_SCALING_ENABLED = process.env.PROACTIVE_SCALING_ENABLED !== 'false'
const KARPENTER_ENABLED = process.env.KARPENTER_ENABLED === 'true'

const NODE_HEADROOM_PODS = parseInt(process.env.NODE_HEADROOM_PODS || '10', 10)
const NODE_MAX_SIZE = parseInt(process.env.NODE_MAX_SIZE || '15', 10)

const POD_CPU_REQUEST_MILLICORES = 200
const POD_MEMORY_REQUEST_MI = 512
const PODS_PER_NODE_ESTIMATE = 10

const SCALE_COOLDOWN_MS = 60_000

interface NodeCapacity {
  name: string
  allocatableCpuMillis: number
  allocatableMemoryMi: number
  allocatablePods: number
  runningPods: number
}

export interface CapacitySummary {
  totalNodes: number
  totalPodSlots: number
  usedPodSlots: number
  availablePodSlots: number
  totalCpuMillis: number
  usedCpuMillis: number
  availableCpuMillis: number
  asgDesired: number
  asgMax: number
}

let asgClient: AutoScalingClient | null = null
let k8sCoreApi: k8s.CoreV1Api | null = null
let lastScaleUpTime = 0

function getAsgClient(): AutoScalingClient {
  if (!asgClient) {
    asgClient = new AutoScalingClient({ region: AWS_REGION })
  }
  return asgClient
}

function getCoreApi(): k8s.CoreV1Api {
  if (!k8sCoreApi) {
    const kc = new k8s.KubeConfig()
    const serviceAccountDir = '/var/run/secrets/kubernetes.io/serviceaccount'
    const caPath = `${serviceAccountDir}/ca.crt`
    const tokenPath = `${serviceAccountDir}/token`

    if (fs.existsSync(caPath) && fs.existsSync(tokenPath)) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
      const token = fs.readFileSync(tokenPath, 'utf8')
      const host = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`
      kc.loadFromOptions({
        clusters: [{ name: 'in-cluster', server: host, skipTLSVerify: true }],
        users: [{ name: 'in-cluster', token }],
        contexts: [{ name: 'in-cluster', cluster: 'in-cluster', user: 'in-cluster' }],
        currentContext: 'in-cluster',
      })
    } else {
      kc.loadFromDefault()
    }
    k8sCoreApi = kc.makeApiClient(k8s.CoreV1Api)
  }
  return k8sCoreApi
}

function parseCpuToMillis(cpu: string): number {
  if (cpu.endsWith('m')) return parseInt(cpu, 10)
  return parseFloat(cpu) * 1000
}

function parseMemoryToMi(mem: string): number {
  if (mem.endsWith('Ki')) return parseInt(mem, 10) / 1024
  if (mem.endsWith('Mi')) return parseInt(mem, 10)
  if (mem.endsWith('Gi')) return parseInt(mem, 10) * 1024
  return parseInt(mem, 10) / (1024 * 1024)
}

async function getNodeCapacities(): Promise<NodeCapacity[]> {
  const api = getCoreApi()
  const { items: nodes } = await api.listNode()
  const capacities: NodeCapacity[] = []

  for (const node of nodes) {
    const name = node.metadata?.name || 'unknown'
    const allocatable = node.status?.allocatable || {}
    const allocatableCpuMillis = parseCpuToMillis(allocatable.cpu || '0')
    const allocatableMemoryMi = parseMemoryToMi(allocatable.memory || '0')
    const allocatablePods = parseInt(allocatable.pods || '58', 10)

    const { items: pods } = await api.listPodForAllNamespaces({
      fieldSelector: `spec.nodeName=${name},status.phase=Running`,
    })

    capacities.push({
      name,
      allocatableCpuMillis,
      allocatableMemoryMi,
      allocatablePods,
      runningPods: pods.length,
    })
  }

  return capacities
}

async function getAsgInfo(): Promise<{ desired: number; max: number; name: string } | null> {
  if (!EKS_ASG_NAME) {
    console.log('[NodeScaler] EKS_ASG_NAME not set, skipping ASG lookup')
    return null
  }

  try {
    const client = getAsgClient()
    const result = await client.send(
      new DescribeAutoScalingGroupsCommand({
        AutoScalingGroupNames: [EKS_ASG_NAME],
      })
    )
    const asg = result.AutoScalingGroups?.[0]
    if (!asg) return null

    return {
      desired: asg.DesiredCapacity || 0,
      max: asg.MaxSize || NODE_MAX_SIZE,
      name: EKS_ASG_NAME,
    }
  } catch (err: any) {
    console.error('[NodeScaler] Failed to get ASG info:', err.message)
    return null
  }
}

/**
 * Get a summary of current cluster capacity.
 */
export async function getCapacitySummary(): Promise<CapacitySummary> {
  const nodes = await getNodeCapacities()
  const asg = await getAsgInfo()

  let totalPodSlots = 0
  let usedPodSlots = 0
  let totalCpuMillis = 0
  let usedCpuMillis = 0

  for (const node of nodes) {
    totalPodSlots += node.allocatablePods
    usedPodSlots += node.runningPods
    totalCpuMillis += node.allocatableCpuMillis
    usedCpuMillis += node.runningPods * POD_CPU_REQUEST_MILLICORES
  }

  return {
    totalNodes: nodes.length,
    totalPodSlots,
    usedPodSlots,
    availablePodSlots: totalPodSlots - usedPodSlots,
    totalCpuMillis,
    usedCpuMillis,
    availableCpuMillis: totalCpuMillis - usedCpuMillis,
    asgDesired: asg?.desired ?? nodes.length,
    asgMax: asg?.max ?? NODE_MAX_SIZE,
  }
}

/**
 * Proactively ensure the cluster has enough capacity for `requiredPods` new pods.
 * If current nodes can't fit them (with headroom), scales the ASG before pods
 * are created, avoiding the 2-3 minute reactive wait.
 *
 * Returns the number of additional nodes requested (0 if no scaling needed).
 */
export async function ensureCapacityForPods(requiredPods: number): Promise<number> {
  if (!PROACTIVE_SCALING_ENABLED || !EKS_ASG_NAME) return 0

  // When Karpenter is active, it handles node provisioning natively (~15s decisions).
  // Skip ASG manipulation to avoid conflicting with Karpenter's scheduling.
  // Capacity monitoring via getCapacitySummary() still works for observability.
  if (KARPENTER_ENABLED) {
    console.log(
      `[NodeScaler] Karpenter enabled — skipping ASG scaling for ${requiredPods} pods (Karpenter handles provisioning)`
    )
    return 0
  }

  return scalerTracer.startActiveSpan('node_scaler.ensure_capacity', async (span: Span) => {
    span.setAttribute('required_pods', requiredPods)

    try {
      const summary = await getCapacitySummary()

      span.setAttribute('current_nodes', summary.totalNodes)
      span.setAttribute('available_pod_slots', summary.availablePodSlots)
      span.setAttribute('asg_desired', summary.asgDesired)
      span.setAttribute('asg_max', summary.asgMax)

      const slotsNeeded = requiredPods + NODE_HEADROOM_PODS
      const deficit = slotsNeeded - summary.availablePodSlots

      if (deficit <= 0) {
        console.log(
          `[NodeScaler] Capacity OK: ${summary.availablePodSlots} slots available, need ${slotsNeeded} (${requiredPods} pods + ${NODE_HEADROOM_PODS} headroom)`
        )
        span.setAttribute('scale_action', 'none')
        span.setStatus({ code: SpanStatusCode.OK })
        span.end()
        return 0
      }

      const additionalNodes = Math.ceil(deficit / PODS_PER_NODE_ESTIMATE)
      const newDesired = Math.min(summary.asgDesired + additionalNodes, summary.asgMax)

      if (newDesired <= summary.asgDesired) {
        console.warn(
          `[NodeScaler] At ASG max (${summary.asgMax}), cannot scale further. Deficit: ${deficit} pod slots`
        )
        span.setAttribute('scale_action', 'at_max')
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'ASG at max capacity' })
        span.end()
        return 0
      }

      if (Date.now() - lastScaleUpTime < SCALE_COOLDOWN_MS) {
        console.log(
          `[NodeScaler] Scale cooldown active (${Math.round((Date.now() - lastScaleUpTime) / 1000)}s since last scale), skipping`
        )
        span.setAttribute('scale_action', 'cooldown')
        span.setStatus({ code: SpanStatusCode.OK })
        span.end()
        return 0
      }

      console.log(
        `[NodeScaler] PROACTIVE SCALE-UP: ${summary.asgDesired} → ${newDesired} nodes ` +
          `(deficit: ${deficit} slots, adding ${newDesired - summary.asgDesired} nodes for ${requiredPods} pods)`
      )

      const client = getAsgClient()
      await client.send(
        new SetDesiredCapacityCommand({
          AutoScalingGroupName: EKS_ASG_NAME,
          DesiredCapacity: newDesired,
          HonorCooldown: false,
        })
      )

      lastScaleUpTime = Date.now()
      const addedNodes = newDesired - summary.asgDesired

      span.setAttribute('scale_action', 'scale_up')
      span.setAttribute('new_desired', newDesired)
      span.setAttribute('nodes_added', addedNodes)
      span.setStatus({ code: SpanStatusCode.OK })
      span.end()

      return addedNodes
    } catch (err: any) {
      console.error('[NodeScaler] Failed to ensure capacity:', err.message)
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
      span.recordException(err)
      span.end()
      return 0
    }
  })
}
