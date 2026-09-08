// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { useEffect, useMemo } from 'react';
import { config } from './config';
import { View, ViewProps, Platform } from 'react-native';
import { OverlayProvider } from '@gluestack-ui/core/overlay/creator';
import { ToastProvider } from '@gluestack-ui/core/toast/creator';
import { useColorScheme, vars } from 'nativewind';
import { useAccentTheme, getAccentVars } from '../../../contexts/accent-theme';

export type ModeType = 'light' | 'dark' | 'system';

/**
 * Native-only ChatGPT iOS surface tokens. Web keeps `config.ts` / global.css
 * so desktop is unchanged. Sourced from ChatGPT iOS 1.2026 App Store shots
 * plus OpenAI product tokens (`#ffffff` / `#000000` canvas, `#212121` raised).
 */
const nativeChatGptSurfaces = {
  light: vars({
    '--color-background': '255 255 255',
    '--color-foreground': '13 13 13',
    '--color-card': '255 255 255',
    '--color-card-foreground': '13 13 13',
    '--color-popover': '255 255 255',
    '--color-popover-foreground': '13 13 13',
    '--color-muted': '244 244 244',
    '--color-muted-foreground': '142 142 142',
    '--color-border': '229 229 229',
    '--color-secondary': '244 244 244',
    '--color-secondary-foreground': '13 13 13',
    '--color-accent': '244 244 244',
    '--color-accent-foreground': '13 13 13',
    '--color-input': '229 229 229',
  }),
  dark: vars({
    '--color-background': '0 0 0',
    '--color-foreground': '236 236 236',
    '--color-card': '33 33 33',
    '--color-card-foreground': '236 236 236',
    '--color-popover': '33 33 33',
    '--color-popover-foreground': '236 236 236',
    '--color-muted': '47 47 47',
    '--color-muted-foreground': '142 142 142',
    '--color-border': '62 62 62',
    '--color-secondary': '47 47 47',
    '--color-secondary-foreground': '236 236 236',
    '--color-accent': '47 47 47',
    '--color-accent-foreground': '236 236 236',
    '--color-input': '62 62 62',
  }),
} as const;

export function GluestackUIProvider({
  mode = 'light',
  ...props
}: {
  mode?: ModeType;
  children?: React.ReactNode;
  style?: ViewProps['style'];
}) {
  const { colorScheme, setColorScheme } = useColorScheme();
  const { accent } = useAccentTheme();

  useEffect(() => {
    setColorScheme(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const resolvedMode = colorScheme === 'dark' ? 'dark' : 'light';
  const accentOverrides = useMemo(
    () => vars(getAccentVars(accent, resolvedMode)),
    [accent, resolvedMode],
  );

  return (
    <View
      style={[
        config[colorScheme!],
        Platform.OS !== 'web' ? nativeChatGptSurfaces[resolvedMode] : null,
        accentOverrides,
        { flex: 1, height: '100%', width: '100%' },
        props.style,
      ]}
    >
      <OverlayProvider>
        <ToastProvider>{props.children}</ToastProvider>
      </OverlayProvider>
    </View>
  );
}
