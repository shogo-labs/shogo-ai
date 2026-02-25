/**
 * Agent Screen (Expo Router)
 *
 * Entry point for the agent canvas panel.
 * Reads EXPO_PUBLIC_AGENT_URL from env or lets user type it in.
 */

import React, { useState } from 'react'
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
} from 'react-native'
import { Stack } from 'expo-router'
import AgentDynamicAppPanel from '../components/AgentDynamicAppPanel'

export default function AgentScreen() {
    const [agentUrl, setAgentUrl] = useState<string | null>(
        process.env.EXPO_PUBLIC_AGENT_URL ?? null
    )
    const [inputUrl, setInputUrl] = useState('')

    const handleConnect = () => {
        const url = inputUrl.trim()
        if (url) setAgentUrl(url)
    }

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={styles.container}
        >
            <Stack.Screen
                options={{
                    title: 'Agent Canvas',
                    headerStyle: { backgroundColor: '#111827' },
                    headerTintColor: '#fff',
                    headerTitleStyle: { fontWeight: '600' },
                }}
            />

            {!agentUrl ? (
                <View style={styles.form}>
                    <Text style={styles.heading}>Connect to Agent</Text>
                    <Text style={styles.subheading}>Enter your agent runtime URL</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="http://localhost:8080"
                        value={inputUrl}
                        onChangeText={setInputUrl}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                        onSubmitEditing={handleConnect}
                        returnKeyType="go"
                    />
                    <TouchableOpacity
                        style={[styles.btn, !inputUrl.trim() && styles.btnDisabled]}
                        onPress={handleConnect}
                        disabled={!inputUrl.trim()}
                    >
                        <Text style={styles.btnText}>Connect</Text>
                    </TouchableOpacity>
                </View>
            ) : (
                <AgentDynamicAppPanel agentUrl={agentUrl} />
            )}
        </KeyboardAvoidingView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f9fafb' },
    form: {
        flex: 1,
        justifyContent: 'center',
        padding: 24,
        gap: 12,
    },
    heading: {
        fontSize: 20,
        fontWeight: '600',
        color: '#111827',
        textAlign: 'center',
    },
    subheading: {
        fontSize: 14,
        color: '#9ca3af',
        textAlign: 'center',
        marginBottom: 8,
    },
    input: {
        borderWidth: 1,
        borderColor: '#e5e7eb',
        borderRadius: 10,
        padding: 14,
        fontSize: 16,
        backgroundColor: '#fff',
    },
    btn: {
        backgroundColor: '#3b82f6',
        borderRadius: 10,
        padding: 14,
        alignItems: 'center',
    },
    btnDisabled: { opacity: 0.5 },
    btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
})
