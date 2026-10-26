// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the PDF preview is allowed to frame.
 *
 * The iframe cannot be sandboxed: Chromium refuses to run its built-in PDF
 * viewer inside *any* sandboxed frame, whatever the `allow-*` flags, and shows
 * "This page has been blocked by Chrome" instead (SHO-224). Without a sandbox,
 * framing an http(s) URL directly would execute whatever the server returns on
 * the app's own origin — an uploaded `.pdf` that is really HTML. So only a
 * `blob:` URL typed `application/pdf` ever reaches the iframe: a caller's blob
 * is used as-is, anything else is fetched and re-wrapped with that type, which
 * leaves the browser no document to run.
 */

export interface PdfPreviewSource {
  /** The URL to frame. */
  url: string;
  /** True when this call minted the object URL, so only it may revoke it. */
  owned: boolean;
}

/** Thrown when the bytes could not be fetched; `status` is the HTTP status. */
export class PdfPreviewFetchError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "PdfPreviewFetchError";
    this.status = status;
  }
}

export async function resolvePdfPreviewUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PdfPreviewSource> {
  if (url.startsWith("blob:")) return { url, owned: false };

  const response = await fetchImpl(url, { credentials: "include" });
  if (!response.ok) throw new PdfPreviewFetchError(response.status);

  const bytes = await response.blob();
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })),
    owned: true,
  };
}

/** The line shown in place of the document when the bytes could not be read. */
export function pdfPreviewErrorText(error: unknown, name: string): string {
  if (error instanceof PdfPreviewFetchError) return `Could not open ${name} · ${error.message}`;
  return `Could not open ${name}`;
}
