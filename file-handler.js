/**
 * file-handler.js - File selection and drag-and-drop handling
 *
 * Manages video file input through:
 * - Drag-and-drop with visual feedback
 * - Browse button integration
 * - File validation
 */

'use strict';

const WARN_SIZE = 500 * 1024 * 1024; // 500 MB

/**
 * File handler for video selection
 */
export class FileHandler {
  constructor(options = {}) {
    this.onFileSelected = options.onFileSelected || (() => {});
    this.dropZone = options.dropZone;
    this.fileInput = options.fileInput;
    this.browseBtn = options.browseBtn;
    this.onLargeFileWarning = options.onLargeFileWarning || (() => {});

    this._init();
  }

  /**
   * Wire up event listeners
   * @private
   */
  _init() {
    if (!this.dropZone || !this.fileInput || !this.browseBtn) {
      throw new Error('FileHandler requires dropZone, fileInput, and browseBtn elements');
    }

    // Browse button triggers file input
    this.browseBtn.addEventListener('click', () => {
      this.fileInput.click();
    });

    // File input change handler
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files.length) {
        this._handleFile(this.fileInput.files[0]);
      }
    });

    // Drag-and-drop handlers
    this.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      this.dropZone.classList.add('dragover');
    });

    this.dropZone.addEventListener('dragleave', () => {
      this.dropZone.classList.remove('dragover');
    });

    this.dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      this.dropZone.classList.remove('dragover');

      const file = event.dataTransfer?.files?.[0];
      if (!file) return;

      // Sync file input with dropped file
      this.fileInput.files = event.dataTransfer.files;
      this._handleFile(file);
    });
  }

  /**
   * Handle selected file
   * @private
   * @param {File} file - Selected file
   */
  _handleFile(file) {
    // Validate MIME type (video/*)
    if (!file.type.startsWith('video/')) {
      console.warn('Selected file is not a video:', file.type);
    }

    // Warn on large files
    if (file.size > WARN_SIZE) {
      this.onLargeFileWarning(file);
    }

    // Emit callback
    this.onFileSelected(file);
  }

  /**
   * Get currently selected file
   * @returns {File|null}
   */
  getSelectedFile() {
    return this.fileInput.files[0] || null;
  }
}
