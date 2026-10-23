import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Player } from '@remotion/player';
import { COMPOSITIONS, type CompositionEntry } from './compositions';

/**
 * The canvas preview: the project's compositions played with @remotion/player.
 *
 * This file is only the preview shell — `remotion render` and `remotion studio`
 * read `src/index.ts` → `Root.tsx` instead, so the MP4 you render is exactly
 * what plays here. Do not put video logic in this file; put it in a
 * composition under `src/videos/` and add it to `src/compositions.ts`.
 */
function Preview() {
  const [activeId, setActiveId] = useState(COMPOSITIONS[0]?.id ?? '');
  const active: CompositionEntry | undefined = useMemo(
    () => COMPOSITIONS.find((entry) => entry.id === activeId) ?? COMPOSITIONS[0],
    [activeId],
  );

  if (!active) {
    return (
      <div style={{ padding: 48, color: '#8d8d99' }}>
        No compositions yet — add one to <code>src/compositions.ts</code>.
      </div>
    );
  }

  const seconds = (active.durationInFrames / active.fps).toFixed(1);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        padding: '24px clamp(16px, 3vw, 40px) 32px',
      }}
    >
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <div style={{ fontSize: 13, letterSpacing: 1.6, textTransform: 'uppercase', color: '#8d8d99' }}>
          Composition
        </div>
        {COMPOSITIONS.map((entry) => {
          const selected = entry.id === active.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setActiveId(entry.id)}
              style={{
                font: 'inherit',
                fontSize: 14,
                cursor: 'pointer',
                borderRadius: 999,
                padding: '8px 16px',
                color: selected ? '#ffffff' : '#b9b9c6',
                background: selected ? '#6d5efc' : 'transparent',
                border: `1px solid ${selected ? '#6d5efc' : '#26262f'}`,
              }}
            >
              {entry.title}
            </button>
          );
        })}
        <div style={{ marginLeft: 'auto', fontSize: 13, color: '#8d8d99' }}>
          {active.width} × {active.height} · {active.fps} fps · {seconds}s · {active.hint}
        </div>
      </header>

      <div
        style={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: 0,
        }}
      >
        <div
          style={{
            width: `min(100%, calc((100vh - 190px) * ${active.width / active.height}))`,
            aspectRatio: `${active.width} / ${active.height}`,
            borderRadius: 16,
            overflow: 'hidden',
            border: '1px solid #26262f',
            background: '#000000',
            boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
          }}
        >
          <Player
            key={active.id}
            component={active.component}
            durationInFrames={active.durationInFrames}
            compositionWidth={active.width}
            compositionHeight={active.height}
            fps={active.fps}
            controls
            loop
            autoPlay
            acknowledgeRemotionLicense
            style={{ width: '100%', height: '100%' }}
          />
        </div>
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');
createRoot(container).render(<Preview />);
