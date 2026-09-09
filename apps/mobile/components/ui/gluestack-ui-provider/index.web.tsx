// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
'use client';
import React, { useEffect, useLayoutEffect } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { config } from './config';
import { OverlayProvider } from '@gluestack-ui/core/overlay/creator';
import { ToastProvider } from '@gluestack-ui/core/toast/creator';
import { setFlushStyles } from '@gluestack-ui/utils/nativewind-utils';
import { script } from './script';
import { useResolvedTheme } from '../../../contexts/theme';
import { CHATGPT_PHONE_SURFACE_VARS } from '../../../lib/chatgpt-phone-surfaces';
import { WEB_PHONE_MAX_WIDTH } from '../../../lib/native-phone-layout';

export type ModeType = 'light' | 'dark' | 'system';

const variableStyleTagId = 'nativewind-style';
const createStyle = (styleTagId: string) => {
  const style = document.createElement('style');
  style.id = styleTagId;
  style.appendChild(document.createTextNode(''));
  return style;
};

export const useSafeLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function GluestackUIProvider({
  mode = 'light',
  ...props
}: {
  mode?: ModeType;
  children?: React.ReactNode;
}) {
  const { width } = useWindowDimensions()
  const resolvedTheme = useResolvedTheme()
  const isPhoneWeb = width <= WEB_PHONE_MAX_WIDTH

  let cssVariablesWithMode = ``;
  Object.keys(config).forEach((configKey) => {
    cssVariablesWithMode +=
      configKey === 'dark' ? `\n .dark {\n ` : `\n:root {\n`;
    const cssVariables = Object.keys(
      config[configKey as keyof typeof config]
    ).reduce((acc: string, curr: string) => {
      acc += `${curr}:${config[configKey as keyof typeof config][curr]}; `;
      return acc;
    }, '');
    cssVariablesWithMode += `${cssVariables} \n}`;
  });

  setFlushStyles(cssVariablesWithMode);

  const handleMediaQuery = React.useCallback((e: MediaQueryListEvent) => {
    script(e.matches ? 'dark' : 'light');
  }, []);

  useSafeLayoutEffect(() => {
    if (mode !== 'system') {
      const documentElement = document.documentElement;
      if (documentElement) {
        documentElement.classList.add(mode);
        documentElement.classList.remove(mode === 'light' ? 'dark' : 'light');
        documentElement.style.colorScheme = mode;
      }
    }
  }, [mode]);

  useSafeLayoutEffect(() => {
    if (mode !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    media.addListener(handleMediaQuery);

    return () => media.removeListener(handleMediaQuery);
  }, [handleMediaQuery]);

  useSafeLayoutEffect(() => {
    if (typeof window !== 'undefined') {
      const documentElement = document.documentElement;
      if (documentElement) {
        const head = documentElement.querySelector('head');
        let style = head?.querySelector(`[id='${variableStyleTagId}']`);
        if (!style) {
          style = createStyle(variableStyleTagId);
          style.innerHTML = cssVariablesWithMode;
          if (head) head.appendChild(style);
        }
      }
    }
  }, []);

  const providerContent = (
    <>
      <script
        suppressHydrationWarning
        dangerouslySetInnerHTML={{
          __html: `(${script.toString()})('${mode}')`,
        }}
      />
      <OverlayProvider>
        <ToastProvider>{props.children}</ToastProvider>
      </OverlayProvider>
    </>
  );

  if (!isPhoneWeb) return providerContent

  return (
    <View
      style={[
        CHATGPT_PHONE_SURFACE_VARS[resolvedTheme],
        { flex: 1, height: '100%', width: '100%' },
      ]}
    >
      {providerContent}
    </View>
  );
}
