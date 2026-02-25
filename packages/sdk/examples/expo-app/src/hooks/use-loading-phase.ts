/**
 * useLoadingPhase (React Native)
 *
 * Drives a phased loading indicator: initializing → starting → connecting → ready.
 * Pure React hook — identical logic to the web version, no web dependencies.
 */

import { useState, useEffect, useRef } from 'react'

export type LoadingPhase = 'initializing' | 'starting' | 'connecting' | 'ready'

export const PHASE_CONFIG: { id: LoadingPhase; label: string; duration: number }[] = [
    { id: 'initializing', label: 'Initializing environment', duration: 2000 },
    { id: 'starting', label: 'Starting agent runtime', duration: 4000 },
    { id: 'connecting', label: 'Connecting to agent', duration: 3000 },
    { id: 'ready', label: 'Ready', duration: 0 },
]

export function useLoadingPhase(agentUrl: string | null, connected: boolean): LoadingPhase {
    const [phase, setPhase] = useState<LoadingPhase>('initializing')
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

    useEffect(() => {
        if (connected) {
            setPhase('ready')
            return
        }
        if (agentUrl && !connected) {
            setPhase('connecting')
            return
        }

        setPhase('initializing')
        timerRef.current = setTimeout(() => {
            setPhase('starting')
        }, PHASE_CONFIG[0].duration)

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current)
        }
    }, [agentUrl, connected])

    return phase
}
