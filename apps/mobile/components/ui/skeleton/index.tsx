// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import React, { forwardRef, useEffect, useRef } from 'react';
import type { VariantProps } from '@gluestack-ui/utils/nativewind-utils';
import { Animated, Easing, Platform, View } from 'react-native';
import { skeletonStyle, skeletonTextStyle } from './styles';

type ISkeletonProps = React.ComponentProps<typeof View> &
  VariantProps<typeof skeletonStyle> & {
    isLoaded?: boolean;
    startColor?: string;
    speed?: number | string;
  };

type ISkeletonTextProps = React.ComponentProps<typeof View> &
  VariantProps<typeof skeletonTextStyle> & {
    _lines?: number;
    isLoaded?: boolean;
    startColor?: string;
  };

const Skeleton = forwardRef<
  React.ComponentRef<typeof Animated.View>,
  ISkeletonProps
>(function Skeleton(
  {
    className,
    variant,
    children,
    startColor = 'bg-background-200',
    isLoaded = false,
    speed = 2,
    ...props
  },
  ref
) {
  // One value for the life of the component; the loop is started in an effect,
  // not on every render (that restarted the pulse each time a parent updated).
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const animationDuration = (0.6 * 10000) / Number(speed); // seconds → ms

  useEffect(() => {
    if (isLoaded) return;
    const easing = Easing.bezier(0.4, 0, 0.6, 1);
    const step = (toValue: number) =>
      Animated.timing(pulseAnim, {
        toValue,
        duration: animationDuration / 2,
        easing,
        useNativeDriver: Platform.OS !== 'web',
      });
    const loop = Animated.loop(Animated.sequence([step(0.75), step(1)]));
    loop.start();
    return () => {
      loop.stop();
      pulseAnim.setValue(1);
    };
  }, [animationDuration, isLoaded, pulseAnim]);

  if (isLoaded) return children;
  return (
    <Animated.View
      style={{ opacity: pulseAnim }}
      className={`${startColor} ${skeletonStyle({
        variant,
        class: className,
      })}`}
      {...props}
      ref={ref}
    />
  );
});

const SkeletonText = forwardRef<
  React.ComponentRef<typeof View>,
  ISkeletonTextProps
>(function SkeletonText(
  {
    className,
    _lines,
    isLoaded = false,
    startColor = 'bg-background-200',
    gap = 2,
    children,
    ...props
  },
  ref
) {
  if (!isLoaded) {
    if (_lines) {
      return (
        <View
          className={`${skeletonTextStyle({
            gap,
          })}`}
          ref={ref}
        >
          {Array.from({ length: _lines }).map((_, index) => (
            <Skeleton
              key={index}
              className={`${startColor} ${skeletonTextStyle({
                class: className,
              })}`}
              {...props}
            />
          ))}
        </View>
      );
    } else {
      return (
        <Skeleton
          className={`${startColor} ${skeletonTextStyle({
            class: className,
          })}`}
          {...props}
          ref={ref}
        />
      );
    }
  } else {
    return children;
  }
});

Skeleton.displayName = 'Skeleton';
SkeletonText.displayName = 'SkeletonText';

export { Skeleton, SkeletonText };
