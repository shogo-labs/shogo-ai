import { useEffect, useMemo, useRef, useState } from "react";
import {
  Image as ImageIcon,
  Minus,
  Plus,
  RefreshCw,
  ExternalLink,
} from "lucide-react-native";

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg",
]);

export function isImagePath(path: string): boolean {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTS.has(ext);
}

/**
 * Renders a single image inside an editor tab. Supports zoom in/out, reset,
 * and "open in new tab". The image URL is owned by the caller (Workbench)
 * and revoked on tab close so we don't leak blob: URLs.
 */
export function ImagePreview({
  url,
  name,
  path,
}: {
  url: string;
  name: string;
  path: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setZoom(1);
    setNatural(null);
    setError(null);
  }, [url]);

  const prettySize = useMemo(() => {
    if (!natural) return "";
    return `${natural.w} × ${natural.h}`;
  }, [natural]);

  const isSvg = path.toLowerCase().endsWith(".svg");

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 items-center justify-between gap-2 border-b border-[color:var(--ide-border)] bg-[color:var(--ide-surface)] px-3 text-[12px] text-[color:var(--ide-muted)]">
        <div className="flex items-center gap-2 min-w-0">
          <ImageIcon size={13} className="shrink-0 text-[color:var(--ide-accent-file-icon)]" />
          <span className="truncate text-[color:var(--ide-text)]">{name}</span>
          {prettySize && <span className="shrink-0">· {prettySize}</span>}
        </div>
        <div className="flex items-center gap-1">
          <IconBtn
            title="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.1, +(z - 0.25).toFixed(2)))}
          >
            <Minus size={13} />
          </IconBtn>
          <button
            onClick={() => setZoom(1)}
            className="rounded px-1.5 py-0.5 text-[11px] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
            title="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconBtn
            title="Zoom in"
            onClick={() => setZoom((z) => Math.min(16, +(z + 0.25).toFixed(2)))}
          >
            <Plus size={13} />
          </IconBtn>
          <IconBtn
            title="Reload"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            <RefreshCw size={12} />
          </IconBtn>
          <IconBtn
            title="Open in new tab"
            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink size={12} />
          </IconBtn>
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-auto bg-[color:var(--ide-bg)] [background-image:linear-gradient(45deg,var(--ide-hover-subtle)_25%,transparent_25%),linear-gradient(-45deg,var(--ide-hover-subtle)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--ide-hover-subtle)_75%),linear-gradient(-45deg,transparent_75%,var(--ide-hover-subtle)_75%)] [background-size:16px_16px] [background-position:0_0,0_8px,8px_-8px,-8px_0]">
        {error ? (
          <div className="text-[13px] text-[color:var(--ide-error)]">{error}</div>
        ) : (
          <img
            ref={imgRef}
            key={reloadKey}
            src={url}
            alt={name}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError(`Could not load ${name}`)}
            draggable={false}
            className={[
              "origin-center transition-transform duration-[80ms] ease-linear",
              isSvg ? "max-h-[90%] max-w-[90%]" : "",
              zoom >= 2 ? "[image-rendering:pixelated]" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ transform: `scale(${zoom})` }}
          />
        )}
      </div>
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded p-1 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
    >
      {children}
    </button>
  );
}
