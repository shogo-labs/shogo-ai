// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Returns JS to inject into the renderer that creates a VM image download overlay.
 * Uses window.shogoDesktop IPC bridge for communication with the main process.
 */
export function getVMDownloadOverlayScript(): string {
  return `
(function() {
  if (document.getElementById('shogo-vm-download-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'shogo-vm-download-overlay';
  overlay.innerHTML = \`
    <div style="
      position: fixed; inset: 0; z-index: 99999;
      background: rgba(0,0,0,0.7); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    ">
      <div style="
        background: #1a1a2e; border: 1px solid #333; border-radius: 16px;
        padding: 40px; max-width: 480px; width: 90%; text-align: center;
        box-shadow: 0 24px 48px rgba(0,0,0,0.4);
      ">
        <div style="font-size: 48px; margin-bottom: 16px;">⚡</div>
        <h2 id="vm-dl-title" style="color: #e0e0e0; font-size: 20px; font-weight: 600; margin: 0 0 12px;">
          VM Environment Setup
        </h2>
        <p id="vm-dl-desc" style="color: #999; font-size: 14px; line-height: 1.5; margin: 0 0 24px;">
          Shogo needs to download the VM environment for secure code execution.<br>
          This is a one-time download (~1.4 GB).
        </p>
        <div id="vm-dl-progress-wrap" style="display: none; margin-bottom: 24px;">
          <div style="
            background: #2a2a3e; border-radius: 8px; height: 8px; overflow: hidden; margin-bottom: 8px;
          ">
            <div id="vm-dl-progress-bar" style="
              background: linear-gradient(90deg, #6366f1, #8b5cf6);
              height: 100%; width: 0%; border-radius: 8px;
              transition: width 0.3s ease;
            "></div>
          </div>
          <div id="vm-dl-progress-text" style="color: #888; font-size: 12px;">
            Preparing download...
          </div>
        </div>
        <div id="vm-dl-error" style="display: none; color: #f87171; font-size: 13px; margin-bottom: 16px;"></div>
        <div id="vm-dl-buttons">
          <button id="vm-dl-start" style="
            background: linear-gradient(135deg, #6366f1, #8b5cf6);
            color: white; border: none; border-radius: 10px;
            padding: 12px 32px; font-size: 15px; font-weight: 600;
            cursor: pointer; margin-right: 12px;
            transition: opacity 0.2s;
          " onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">
            Download
          </button>
          <button id="vm-dl-skip" style="
            background: transparent; color: #888; border: 1px solid #444;
            border-radius: 10px; padding: 12px 24px; font-size: 14px;
            cursor: pointer; transition: border-color 0.2s;
          " onmouseover="this.style.borderColor='#666'" onmouseout="this.style.borderColor='#444'">
            Skip for now
          </button>
        </div>
      </div>
    </div>
  \`;
  document.body.appendChild(overlay);

  const startBtn = document.getElementById('vm-dl-start');
  const skipBtn = document.getElementById('vm-dl-skip');
  const progressWrap = document.getElementById('vm-dl-progress-wrap');
  const progressBar = document.getElementById('vm-dl-progress-bar');
  const progressText = document.getElementById('vm-dl-progress-text');
  const errorDiv = document.getElementById('vm-dl-error');
  const buttonsDiv = document.getElementById('vm-dl-buttons');
  const titleEl = document.getElementById('vm-dl-title');
  const descEl = document.getElementById('vm-dl-desc');

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  if (window.shogoDesktop && window.shogoDesktop.onVMImageDownloadProgress) {
    window.shogoDesktop.onVMImageDownloadProgress(function(progress) {
      progressWrap.style.display = 'block';
      if (progress.stage === 'extracting') {
        progressBar.style.width = '100%';
        progressText.textContent = 'Extracting files...';
      } else {
        progressBar.style.width = progress.percent + '%';
        progressText.textContent = formatBytes(progress.bytesDownloaded) + ' / ' + formatBytes(progress.totalBytes) + ' (' + progress.percent + '%)';
      }
    });
  }

  startBtn.addEventListener('click', async function() {
    startBtn.disabled = true;
    startBtn.style.opacity = '0.5';
    startBtn.textContent = 'Downloading...';
    skipBtn.style.display = 'none';
    progressWrap.style.display = 'block';
    errorDiv.style.display = 'none';

    try {
      const result = await window.shogoDesktop.downloadVMImages();
      if (result && result.success) {
        titleEl.textContent = 'Setup Complete';
        descEl.textContent = 'VM environment is ready. Restarting...';
        buttonsDiv.style.display = 'none';
        progressWrap.style.display = 'none';
        setTimeout(function() { location.reload(); }, 1500);
      } else {
        errorDiv.textContent = 'Download failed: ' + (result && result.error || 'Unknown error');
        errorDiv.style.display = 'block';
        startBtn.disabled = false;
        startBtn.style.opacity = '1';
        startBtn.textContent = 'Retry';
        skipBtn.style.display = 'inline-block';
      }
    } catch (err) {
      errorDiv.textContent = 'Download failed: ' + (err.message || err);
      errorDiv.style.display = 'block';
      startBtn.disabled = false;
      startBtn.style.opacity = '1';
      startBtn.textContent = 'Retry';
      skipBtn.style.display = 'inline-block';
    }
  });

  skipBtn.addEventListener('click', function() {
    window.shogoDesktop.skipVMDownload();
    overlay.remove();
  });
})();
`
}
