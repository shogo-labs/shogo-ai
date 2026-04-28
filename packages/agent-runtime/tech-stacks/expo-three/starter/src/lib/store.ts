import { create } from 'zustand'

export type Vec2 = { x: number; y: number }

export interface GameState {
  moveInput: Vec2
  aimInput: Vec2
  playerHp: number
  fps: number
  setMove: (v: Vec2) => void
  setAim: (v: Vec2) => void
  damagePlayer: (n: number) => void
  setFps: (n: number) => void
}

export const useGame = create<GameState>((set) => ({
  moveInput: { x: 0, y: 0 },
  aimInput: { x: 0, y: 0 },
  playerHp: 100,
  fps: 0,
  setMove: (v) => set({ moveInput: v }),
  setAim: (v) => set({ aimInput: v }),
  damagePlayer: (n) => set((s) => ({ playerHp: Math.max(0, s.playerHp - n) })),
  setFps: (n) => set({ fps: n }),
}))
