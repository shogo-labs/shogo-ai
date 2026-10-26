import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const ORBS = [
  { x: 0.2, y: 0.26, size: 520, color: '#6d5efc', drift: 60 },
  { x: 0.82, y: 0.44, size: 420, color: '#22d3ee', drift: -80 },
  { x: 0.42, y: 0.82, size: 360, color: '#f472b6', drift: 40 },
];

/**
 * The starter composition: a vertical launch clip that is already finished
 * enough to ship. Replace the copy, recolour, or swap the layout — the timings
 * are driven by `useCurrentFrame()` so they stay correct at any fps.
 */
export const Main: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();

  const titleIn = spring({ frame: frame - 8, fps, config: { damping: 200, mass: 0.7 } });
  const subtitleIn = spring({ frame: frame - 26, fps, config: { damping: 200 } });
  const badgeIn = spring({ frame: frame - 44, fps, config: { damping: 14, stiffness: 120 } });
  const underline = interpolate(frame, [52, 84], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const outro = interpolate(frame, [durationInFrames - 18, durationInFrames], [1, 0.92], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(160deg, #0b0b12 0%, #141428 55%, #1b1030 100%)',
        transform: `scale(${outro})`,
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      }}
    >
      {ORBS.map((orb, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: orb.x * width - orb.size / 2,
            top: orb.y * height - orb.size / 2,
            width: orb.size,
            height: orb.size,
            borderRadius: '50%',
            background: orb.color,
            opacity: 0.18,
            filter: 'blur(90px)',
            transform: `translateY(${Math.sin((frame / fps) * 1.2 + i) * orb.drift}px)`,
          }}
        />
      ))}

      <AbsoluteFill
        style={{
          padding: 96,
          justifyContent: 'center',
          alignItems: 'flex-start',
          gap: 28,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '18px 30px',
            borderRadius: 999,
            border: '1.5px solid rgba(255,255,255,0.16)',
            background: 'rgba(255,255,255,0.06)',
            color: '#d7d7e0',
            fontSize: 34,
            letterSpacing: 4,
            textTransform: 'uppercase',
            opacity: badgeIn,
            transform: `translateY(${(1 - badgeIn) * -24}px)`,
          }}
        >
          <span style={{ width: 14, height: 14, borderRadius: 999, background: '#6d5efc' }} />
          Made with Remotion
        </div>

        <div
          style={{
            color: '#ffffff',
            fontSize: 148,
            lineHeight: 1.02,
            fontWeight: 800,
            letterSpacing: -4,
            opacity: titleIn,
            transform: `translateY(${(1 - titleIn) * 60}px)`,
          }}
        >
          Your first
          <br />
          video project
        </div>

        <div
          style={{
            width: 260 * underline,
            height: 12,
            borderRadius: 999,
            background: 'linear-gradient(90deg, #6d5efc, #22d3ee)',
          }}
        />

        <div
          style={{
            color: 'rgba(233,233,244,0.78)',
            fontSize: 44,
            lineHeight: 1.35,
            maxWidth: 760,
            opacity: subtitleIn,
            transform: `translateY(${(1 - subtitleIn) * 32}px)`,
          }}
        >
          Edit <code style={{ color: '#ffffff' }}>src/videos/Main.tsx</code> — the canvas preview
          rebuilds on save, and the same file renders to MP4.
        </div>
      </AbsoluteFill>

      <div
        style={{
          position: 'absolute',
          left: 96,
          right: 96,
          bottom: 96,
          display: 'flex',
          justifyContent: 'space-between',
          color: 'rgba(233,233,244,0.45)',
          fontSize: 30,
          letterSpacing: 2,
        }}
      >
        <span>
          {width} × {height}
        </span>
        <span>
          {durationInFrames} frames · {fps} fps
        </span>
      </div>
    </AbsoluteFill>
  );
};
