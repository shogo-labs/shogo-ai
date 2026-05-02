import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react'

export type Vec2 = { x: number; y: number }

// Per-frame inputs live in refs (not React state) so `useFrame` can read them
// without re-rendering the scene every tick. HP is the only field a UI panel
// (HUD) needs to subscribe to, so it stays in React state.
export interface GameContextValue {
  moveInput: MutableRefObject<Vec2>
  aimInput: MutableRefObject<Vec2>
  playerHp: number
  damagePlayer: (n: number) => void
}

const GameContext = createContext<GameContextValue | null>(null)

export function GameProvider({ children }: { children: ReactNode }) {
  const moveInput = useRef<Vec2>({ x: 0, y: 0 })
  const aimInput = useRef<Vec2>({ x: 0, y: 0 })
  const [playerHp, setPlayerHp] = useState(100)

  const damagePlayer = useCallback((n: number) => {
    setPlayerHp((hp) => Math.max(0, hp - n))
  }, [])

  const value = useMemo<GameContextValue>(
    () => ({ moveInput, aimInput, playerHp, damagePlayer }),
    [playerHp, damagePlayer],
  )

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>
}

export function useGame(): GameContextValue {
  const ctx = useContext(GameContext)
  if (!ctx) {
    throw new Error('useGame must be used inside <GameProvider>')
  }
  return ctx
}
