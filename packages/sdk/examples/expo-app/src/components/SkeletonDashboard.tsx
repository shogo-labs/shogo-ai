/**
 * SkeletonDashboard (React Native)
 *
 * Faint ghost dashboard layout shown behind the loading indicator.
 * Uses Animated API for a smooth pulsing opacity effect.
 *
 * Web equivalent: SkeletonDashboard in AgentDynamicAppPanel.tsx
 * Web used: <Skeleton> (shadcn/ui) with opacity-[0.04]
 * RN uses:  Animated.View blocks with looping opacity animation
 */

import React, { useEffect, useRef } from 'react'
import { View, Animated, StyleSheet } from 'react-native'

function SkeletonBlock({ style }: { style?: any }) {
    const opacity = useRef(new Animated.Value(0.3)).current

    useEffect(() => {
        const anim = Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, { toValue: 0.55, duration: 1200, useNativeDriver: true }),
                Animated.timing(opacity, { toValue: 0.3, duration: 1200, useNativeDriver: true }),
            ])
        )
        anim.start()
        return () => anim.stop()
    }, [opacity])

    return <Animated.View style={[styles.block, style, { opacity }]} />
}

export default function SkeletonDashboard() {
    return (
        <View style={styles.container}>
            {/* 3 top stat cards */}
            <View style={styles.row}>
                <SkeletonBlock style={styles.card} />
                <SkeletonBlock style={styles.card} />
                <SkeletonBlock style={styles.card} />
            </View>

            {/* List + sidebar */}
            <View style={styles.row}>
                <View style={styles.listCol}>
                    <SkeletonBlock style={styles.listHeader} />
                    <SkeletonBlock style={styles.listItem} />
                    <SkeletonBlock style={styles.listItem} />
                    <SkeletonBlock style={styles.listItem} />
                    <SkeletonBlock style={[styles.listItem, { width: '75%' }]} />
                </View>
                <View style={styles.sideCol}>
                    <SkeletonBlock style={styles.sideHeader} />
                    <SkeletonBlock style={styles.sideBlock} />
                </View>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        ...StyleSheet.absoluteFillObject,
        padding: 24,
        opacity: 0.06,
    },
    block: {
        backgroundColor: '#888',
        borderRadius: 8,
    },
    row: {
        flexDirection: 'row',
        gap: 16,
        marginBottom: 24,
    },
    card: { flex: 1, height: 80, borderRadius: 12 },
    listCol: { flex: 2, gap: 12 },
    sideCol: { flex: 1, gap: 12 },
    listHeader: { height: 20, width: 128, borderRadius: 6 },
    listItem: { height: 48, width: '100%', borderRadius: 8 },
    sideHeader: { height: 20, width: 96, borderRadius: 6 },
    sideBlock: { height: 160, width: '100%', borderRadius: 8 },
})
