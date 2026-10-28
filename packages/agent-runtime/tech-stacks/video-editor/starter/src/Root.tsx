import React from 'react';
import { Composition } from 'remotion';
import { COMPOSITIONS } from './compositions';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {COMPOSITIONS.map((entry) => (
        <Composition
          key={entry.id}
          id={entry.id}
          component={entry.component}
          width={entry.width}
          height={entry.height}
          fps={entry.fps}
          durationInFrames={entry.durationInFrames}
        />
      ))}
    </>
  );
};
