/**
 * app.js - Main application orchestration
 *
 * On-Device Dreams: Browser-based macOS Screensaver Builder
 * Converts videos to .saver bundles entirely client-side using FFmpeg.wasm and JSZip
 */

'use strict';

import { Transcoder } from './transcoder.js';
import {
  TemplateLoader,
  findBundleRoot,
  stripSignatures,
  rebase,
  createInstaller
} from './bundler.js';
import { patchPlist } from './plist.js';
import { ProgressTracker, UIState, formatBytes } from './ui.js';
import { FileHandler } from './file-handler.js';

// Constants
const TEMPLATE_URL = 'templates/VideoSaverTemplate.saver.zip';
const WARN_SIZE = 500 * 1024 * 1024; // 500 MB

// DOM references
const $ = (id) => document.getElementById(id);
const refs = {
  fileInput: $('file-input'),
  browseBtn: $('browse-btn'),
  dropZone: $('drop-zone'),
  fileMeta: $('file-meta'),
  saverName: $('saver-name'),
  bundleId: $('bundle-id'),
  buildBtn: $('build-btn'),
  progress: $('progress'),
  status: $('status'),
  log: $('log'),
  downloads: $('downloads'),
  bundleLink: $('bundle-link'),
  installerLink: $('installer-link'),
  templateStatus: $('template-status')
};

// State
let selectedFile = null;

// Initialize modules
const transcoder = new Transcoder();
const templateLoader = new TemplateLoader(TEMPLATE_URL);
const progressTracker = new ProgressTracker(refs.progress);
const uiState = new UIState(refs);

// Wire transcoder events to UI
transcoder.on('log', ({ message }) => uiState.appendLog(message));
transcoder.on('progress', ({ ratio }) => progressTracker.updateFromWorker(ratio ?? 0));
transcoder.on('error', (message) => uiState.setStatus(message || 'FFmpeg worker error.', true));

// Initialize file handler
const fileHandler = new FileHandler({
  dropZone: refs.dropZone,
  fileInput: refs.fileInput,
  browseBtn: refs.browseBtn,
  onFileSelected: (file) => {
    selectedFile = file;
    uiState.showFileMetadata(file);
    uiState.clearDownloads();
    uiState.setStatus('Ready to build.');
  },
  onLargeFileWarning: (file) => {
    uiState.appendLog(
      'Large file detected. Remux may be faster if codecs already match.'
    );
  }
});

// Build button handler
refs.buildBtn.addEventListener('click', () => {
  if (!selectedFile) {
    return uiState.setStatus('Select a video first.', true);
  }
  void buildSaver();
});

// Bootstrap on load
void bootstrap().catch((error) => {
  console.error('Initialization failed', error);
});

/**
 * Bootstrap application
 * - Generate random bundle ID
 * - Check template availability
 * - Register service worker
 */
async function bootstrap() {
  // Generate random bundle ID stub
  const stub = Math.random().toString(36).slice(2, 7);
  refs.bundleId.value = `local.videosaver.${stub}`;

  // Check template availability
  try {
    const res = await fetch(TEMPLATE_URL, { method: 'HEAD' });
    if (res.ok) {
      refs.templateStatus.innerHTML = '<span class="prompt">STATUS:</span> Template detected. Ready to build.';
      refs.templateStatus.classList.remove('warning');
    } else {
      markTemplateMissing();
    }
  } catch {
    markTemplateMissing();
  }

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('sw.js')
      .catch((err) => console.warn('Service worker registration failed', err));
  }
}

/**
 * Mark template as missing in UI
 */
function markTemplateMissing() {
  refs.templateStatus.innerHTML =
    '<span class="prompt">STATUS:</span> <span class="warning">Template missing. Place VideoSaverTemplate.saver.zip under /templates/.</span>';
  refs.templateStatus.classList.add('warning');
}

/**
 * Get selected transcode mode
 * @returns {'auto'|'force'|'passthrough'}
 */
function getMode() {
  return document.querySelector('input[name="transcode"]:checked')?.value ?? 'auto';
}

/**
 * Main build workflow
 * Orchestrates all modules to create screensaver bundle
 */
async function buildSaver() {
  uiState.setBusy(true);
  uiState.clearLog();
  uiState.clearDownloads();
  progressTracker.reset();
  progressTracker.set(0);
  uiState.setStatus('Starting build…');

  try {
    // Load template
    uiState.setStatus('Loading template…');
    progressTracker.set(0.05);
    const templateZip = await templateLoader.load();
    const root = findBundleRoot(templateZip);

    if (!root) {
      throw new Error('Template missing .saver root folder.');
    }

    const infoPath = `${root}Contents/Info.plist`;
    const infoFile = templateZip.file(infoPath);

    if (!infoFile) {
      throw new Error('Info.plist not found in template.');
    }

    // Get user inputs
    const saverName = refs.saverName.value.trim()
      .replace(/[^A-Za-z0-9 _.-]+/g, '')
      .trim() || 'MySaver';

    const bundleId = refs.bundleId.value.trim() || `local.videosaver.${Date.now()}`;
    const newRoot = `${saverName}.saver/`;

    // Read video file
    uiState.setStatus('Reading video…');
    progressTracker.set(0.15);

    // Add progress feedback for large files
    const fileSize = selectedFile.size;
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
    uiState.appendLog(`Reading ${sizeMB} MB file into memory...`);

    const sourceBuffer = await selectedFile.arrayBuffer();
    uiState.appendLog(`File loaded into memory (${sizeMB} MB)`);
    progressTracker.set(0.2);

    // Probe video
    uiState.setStatus('Inspecting video…');
    progressTracker.set(0.25);
    const mode = getMode();
    uiState.appendLog(`Mode selected: ${mode}`);
    uiState.appendLog(`Analyzing video streams (this may take a moment for large files)...`);

    const probe = await safeProbe(sourceBuffer);
    progressTracker.set(0.28);

    if (probe) {
      uiState.appendLog(
        `Detected format=${probe.format || 'unknown'} ` +
        `video=${probe.videoCodec || 'unknown'} ` +
        `audio=${probe.audioCodec || 'none'}`
      );
      uiState.appendLog(
        probe.isCompatible
          ? 'Streams already H.264/AAC inside an MP4 container.'
          : probe.copySafe
            ? 'Streams look copy-safe but container needs attention.'
            : 'Stream codecs/container require transcoding.'
      );
    } else {
      uiState.appendLog('Probe unavailable; falling back to safe defaults.');
    }

    // Prepare video (transcode or remux)
    uiState.setStatus('Preparing video…');
    progressTracker.set(0.3);
    const videoPlan = await transcoder.prepareVideo(
      sourceBuffer,
      mode,
      probe,
      progressTracker
    );

    videoPlan.messages.forEach((msg) => uiState.appendLog(msg));
    progressTracker.set(0.82);

    // Update bundle
    uiState.setStatus('Updating bundle…');
    stripSignatures(templateZip, root);
    templateZip.remove(`${root}Contents/Resources/payload.mp4`);
    templateZip.remove(`${root}Contents/Resources/payload.mov`);
    templateZip.file(`${root}Contents/Resources/payload.mp4`, videoPlan.bytes, {
      binary: true,
      unixPermissions: 0o644
    });

    const plist = await infoFile.async('string');
    templateZip.file(
      infoPath,
      patchPlist(plist, {
        CFBundleName: saverName,
        CFBundleIdentifier: bundleId
      })
    );

    // Package downloads
    uiState.setStatus('Packaging downloads…');
    progressTracker.set(0.88);

    const saverZip = await rebase(templateZip, root, newRoot);
    const bundleBlob = await saverZip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      platform: 'UNIX'
    });

    const installerZip = await createInstaller(saverZip, newRoot.slice(0, -1));
    const installerBlob = await installerZip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      platform: 'UNIX'
    });

    // Set download links
    uiState.setDownloads(
      bundleBlob,
      `${saverName}.saver.zip`,
      installerBlob,
      `${saverName}-install.zip`
    );

    uiState.appendLog(`Saved bundle as ${saverName}.saver (${videoPlan.description}).`);
    uiState.appendLog('Install path: ~/Library/Screen Savers/');
    uiState.setStatus('Done! Grab your downloads below.');
    progressTracker.set(1);
  } catch (error) {
    console.error(error);
    uiState.setStatus(error.message || 'Build failed.', true);
  } finally {
    uiState.setBusy(false);
  }
}

/**
 * Safely probe video with error handling
 * @param {ArrayBuffer} buffer - Video buffer
 * @returns {Promise<Object|null>} Probe result or null on failure
 */
async function safeProbe(buffer) {
  try {
    const copy = buffer.slice(0);
    uiState.appendLog('Sending probe request to FFmpeg worker…');
    const result = await transcoder.probe(copy, { name: `probe-${Date.now()}` });
    uiState.appendLog('Probe response received.');
    return result;
  } catch (error) {
    console.warn('Probe failed', error);
    uiState.appendLog(`Probe failed: ${error?.message || error}`);
    return null;
  }
}
