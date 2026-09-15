import {
  MODEL_CATALOG,
  calculateLiveSessionCost,
  getAvailableModels,
  getModelKind,
  isLiveModel,
} from '../index'

describe('GPT-Live model catalog', () => {
  test('describes gpt-live-1 as a live model with per-minute pricing', () => {
    expect(MODEL_CATALOG['gpt-live-1'].kind).toBe('live')
    expect(getModelKind('gpt-live-1')).toBe('live')
    expect(isLiveModel('gpt-live-1')).toBe(true)
    expect(calculateLiveSessionCost('gpt-live-1', 90)).toBeCloseTo(0.075)
  })

  test('default model lists keep live models out of chat pickers', () => {
    expect(getAvailableModels().some((model) => model.id === 'gpt-live-1')).toBe(false)
    expect(getAvailableModels({ kind: 'live' }).map((model) => model.id)).toContain('gpt-live-1')
  })
})
