// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Read-only previews for binary and media files. The IDE editor tabs and the
 * workspace agent file viewer both mount these, so the path-to-preview choice
 * lives here once. Callers own the URL (usually a blob URL) and revoke it.
 */
import { Suspense, lazy } from "react";
import { ImagePreview, isImagePath } from "./ImagePreview";
import {
  AudioPreview,
  FontPreview,
  PdfPreview,
  VideoPreview,
  isAudioPath,
  isFontPath,
  isPdfPath,
  isVideoPath,
} from "./MediaPreview";
import { SqlitePreview } from "./SqlitePreview";
import { isSlidesPath, isDocumentPath } from "./slides-viewer-protocol";

/** Office renderer hosts stay out of the main bundle: office files are rare. */
const SlidesPreview = lazy(() =>
  import("./SlidesPreview").then((module) => ({ default: module.SlidesPreview })),
);
const DocumentPreview = lazy(() =>
  import("./OfficePreview").then((module) => ({
    default: (props: { url: string; name: string; path: string; onError?: (message: string) => void }) =>
      <module.OfficePreview kind="document" {...props} />,
  })),
);

/** SQLite database files are binary, but we render them in a read-only
 *  SQLite preview (tables + sample rows) instead of refusing to open. */
const SQLITE_EXTENSIONS = new Set(["db", "sqlite", "sqlite3"]);
function isSqlitePath(path: string): boolean {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  return SQLITE_EXTENSIONS.has(ext);
}

/** Preview "languages" — pseudo-Monaco-language tags stashed on an OpenFile
 *  to tell the editor which preview component to mount. Any file whose
 *  language matches one of these is opened via svc.readFileUrl() (not
 *  readFile()) and its OpenFile.content holds a URL rather than text. */
export type PreviewLanguage = "image" | "sqlite" | "pdf" | "audio" | "video" | "font" | "slides" | "document";

export const PREVIEW_LANGUAGES: ReadonlySet<string> = new Set<PreviewLanguage>([
  "image", "sqlite", "pdf", "audio", "video", "font", "slides", "document",
]);

export function isPreviewLanguage(language: string | null | undefined): language is PreviewLanguage {
  return !!language && PREVIEW_LANGUAGES.has(language);
}

export function previewLanguageFor(path: string): PreviewLanguage | null {
  if (isImagePath(path)) return "image";
  if (isSqlitePath(path)) return "sqlite";
  if (isPdfPath(path)) return "pdf";
  if (isAudioPath(path)) return "audio";
  if (isVideoPath(path)) return "video";
  if (isFontPath(path)) return "font";
  if (isSlidesPath(path)) return "slides";
  if (isDocumentPath(path)) return "document";
  return null;
}

export interface FilePreviewProps {
  kind: PreviewLanguage;
  url: string;
  name: string;
  path: string;
  /** A renderer that failed, so the host can fall back to text or a download. */
  onError?: (message: string) => void;
}

/** Mounts the preview component for `kind`. */
export function FilePreview({ kind, url, name, path, onError }: FilePreviewProps) {
  switch (kind) {
    case "image":
      return <ImagePreview url={url} name={name} path={path} />;
    case "sqlite":
      return <SqlitePreview url={url} name={name} path={path} />;
    case "pdf":
      return <PdfPreview url={url} name={name} path={path} />;
    case "audio":
      return <AudioPreview url={url} name={name} path={path} />;
    case "video":
      return <VideoPreview url={url} name={name} path={path} />;
    case "font":
      return <FontPreview url={url} name={name} path={path} />;
    case "slides":
      return (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--ide-muted)]">
              Loading {name}…
            </div>
          }
        >
          <SlidesPreview url={url} name={name} path={path} onError={onError} />
        </Suspense>
      );
    case "document":
      return (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--ide-muted)]">
              Loading {name}…
            </div>
          }
        >
          <DocumentPreview url={url} name={name} path={path} onError={onError} />
        </Suspense>
      );
  }
}
