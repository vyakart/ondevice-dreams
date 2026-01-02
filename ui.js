/**
 * ui.js - UI state management and DOM manipulation
 *
 * Manages all UI updates including:
 * - Progress tracking with worker window mapping
 * - Status messages and logging
 * - Download link management
 * - Form state (busy/idle)
 */

'use strict';

/**
 * Progress tracker with support for mapping worker progress to a window
 * Ensures monotonic progress (never goes backwards)
 */
export class ProgressTracker {
  constructor(progressElement) {
    this.node = progressElement;
    this.current = 0;
    this.workerWindow = null;
  }

  reset() {
    this.current = 0;
    this.workerWindow = null;
    this.node.value = 0;
  }

  set(value) {
    const next = this._clamp(value);
    if (next > this.current) {
      this.current = next;
      this.node.value = this.current;
    }
  }

  /**
   * Start mapping worker progress to a window [base, base+span]
   * @param {number} base - Starting point (0-1)
   * @param {number} span - Window size (0-1)
   */
  startWorker(base, span) {
    this.workerWindow = {
      base: this._clamp(base),
      span: this._clamp(span)
    };
  }

  /**
   * Stop worker window mapping
   * @param {number} nextValue - Optional next progress value to set
   */
  stopWorker(nextValue) {
    this.workerWindow = null;
    if (typeof nextValue === 'number') {
      this.set(nextValue);
    }
  }

  /**
   * Update progress from worker event (ratio 0-1)
   * Maps to current worker window if active
   */
  updateFromWorker(ratio) {
    if (!this.workerWindow) return;

    const value = this.workerWindow.base +
                  this.workerWindow.span * this._clamp(ratio ?? 0);

    if (value > this.current) {
      this.current = value;
      this.node.value = this.current;
    }
  }

  _clamp(value) {
    return Math.max(0, Math.min(1, value));
  }
}

/**
 * UI state manager - handles all DOM updates
 */
export class UIState {
  constructor(refs) {
    this.refs = refs;
    this.bundleURL = null;
    this.installerURL = null;
  }

  /**
   * Update status message
   * @param {string} message - Status text
   * @param {boolean} isError - Whether this is an error message
   */
  setStatus(message, isError = false) {
    this.refs.status.textContent = message;
    this.refs.status.classList.toggle('error', isError);
  }

  /**
   * Append timestamped log entry
   * @param {string} message - Log message
   */
  appendLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    this.refs.log.textContent += `[${timestamp}] ${message}\n`;
    this.refs.log.scrollTop = this.refs.log.scrollHeight;
  }

  /**
   * Clear all log entries
   */
  clearLog() {
    this.refs.log.textContent = '';
  }

  /**
   * Show file metadata (name and size)
   * @param {File} file - Selected file
   */
  showFileMetadata(file) {
    this.refs.fileMeta.textContent = `${file.name} • ${formatBytes(file.size)}`;
  }

  /**
   * Create download links for bundle and installer
   * @param {Blob} bundleBlob - Screensaver bundle ZIP
   * @param {string} bundleName - Bundle filename
   * @param {Blob} installerBlob - Installer ZIP
   * @param {string} installerName - Installer filename
   */
  setDownloads(bundleBlob, bundleName, installerBlob, installerName) {
    this.clearDownloads();

    this.bundleURL = URL.createObjectURL(bundleBlob);
    this.installerURL = URL.createObjectURL(installerBlob);

    Object.assign(this.refs.bundleLink, {
      href: this.bundleURL,
      download: bundleName
    });

    Object.assign(this.refs.installerLink, {
      href: this.installerURL,
      download: installerName
    });

    this.refs.downloads.hidden = false;
  }

  /**
   * Clear download links and revoke blob URLs
   */
  clearDownloads() {
    this.refs.downloads.hidden = true;

    if (this.bundleURL) {
      URL.revokeObjectURL(this.bundleURL);
      this.bundleURL = null;
    }

    if (this.installerURL) {
      URL.revokeObjectURL(this.installerURL);
      this.installerURL = null;
    }

    this.refs.bundleLink.removeAttribute('href');
    this.refs.installerLink.removeAttribute('href');
  }

  /**
   * Set form busy state (disable inputs during build)
   * @param {boolean} state - true to disable, false to enable
   */
  setBusy(state) {
    this.refs.buildBtn.disabled = state;
    this.refs.browseBtn.disabled = state;
    this.refs.saverName.disabled = state;
    this.refs.bundleId.disabled = state;

    document.querySelectorAll('input[name="transcode"]').forEach((node) => {
      node.disabled = state;
    });
  }
}

/**
 * Format bytes as human-readable size
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size (e.g., "1.5 MB")
 */
export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const pow = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    sizes.length - 1
  );
  const val = bytes / 1024 ** pow;
  return `${val.toFixed(val >= 10 || pow === 0 ? 0 : 1)} ${sizes[pow]}`;
}

/**
 * Sanitize user input for filenames
 * @param {string} value - User input
 * @returns {string} Sanitized string (alphanumeric, spaces, dots, dashes, underscores)
 */
export function sanitize(value) {
  return (value || '').replace(/[^A-Za-z0-9 _.-]+/g, '').trim();
}
