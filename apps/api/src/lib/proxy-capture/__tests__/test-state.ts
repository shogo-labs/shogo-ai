export interface ProxyCaptureTestState {
  workspace: { trainingDataMode: string } | null
  plan: string
  upserts: any[]
  updates: any[]
  sends: any[]
  fail: boolean
}

export const state: ProxyCaptureTestState = ((globalThis as any).__proxyCaptureTestState ||= {
  workspace: { trainingDataMode: 'default' },
  plan: 'pro',
  upserts: [],
  updates: [],
  sends: [],
  fail: false,
})

export function resetState(): void {
  state.workspace = { trainingDataMode: 'default' }
  state.plan = 'pro'
  state.upserts.length = 0
  state.updates.length = 0
  state.sends.length = 0
  state.fail = false
}
