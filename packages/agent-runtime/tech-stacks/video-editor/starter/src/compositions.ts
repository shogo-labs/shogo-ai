import React from 'react';
import { Main } from './videos/Main';

export interface CompositionEntry {
  id: string;
  title: string;
  hint: string;
  component: React.ComponentType;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

/**
 * Every composition in this project. `Root.tsx` registers these with Remotion
 * (so `remotion render` and Studio can see them) and `preview.tsx` lists them
 * in the canvas Player — add a composition by adding one entry here.
 */
export const COMPOSITIONS: CompositionEntry[] = [
  {
    id: 'Main',
    title: 'Main',
    hint: 'Vertical launch clip',
    component: Main,
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 150,
  },
];
