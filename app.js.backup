'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => document.querySelectorAll(sel);
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
    templateStatus: $('template-status'),
  };

  const TEMPLATE_URL = 'templates/VideoSaverTemplate.saver.zip';
  const WARN_SIZE = 500 * 1024 * 1024;

  let selectedFile = null;
  let bundleURL = null;
  let installerURL = null;

  const progress = createProgressTracker(refs.progress);
  const workerBridge = createWorkerBridge(new Worker('ffmpeg-worker.js'), {
    onLog: ({ message }) => appendLog(message),
    onProgress: ({ ratio }) => progress.updateFromWorker(ratio ?? 0),
    onError: (message) => setStatus(message || 'FFmpeg worker error.', true),
  });
  const loadTemplate = createTemplateLoader(TEMPLATE_URL);

  wireUI();
  void bootstrap().catch((error) => console.error('Initialisation failed', error));

  function wireUI() {
    refs.browseBtn.addEventListener('click', () => refs.fileInput.click());
    refs.fileInput.addEventListener('change', () => {
      if (refs.fileInput.files.length) onFileSelected(refs.fileInput.files[0]);
    });
    refs.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      refs.dropZone.classList.add('dragover');
    });
    refs.dropZone.addEventListener('dragleave', () => refs.dropZone.classList.remove('dragover'));
    refs.dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      refs.dropZone.classList.remove('dragover');
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      refs.fileInput.files = event.dataTransfer.files;
      onFileSelected(file);
    });
    refs.buildBtn.addEventListener('click', () => {
      if (!selectedFile) return setStatus('Select a video first.', true);
      void buildSaver();
    });
  }

  async function bootstrap() {
    const stub = Math.random().toString(36).slice(2, 7);
    refs.bundleId.value = `local.videosaver.${stub}`;

    try {
      const res = await fetch(TEMPLATE_URL, { method: 'HEAD' });
      if (res.ok) {
        refs.templateStatus.textContent = 'Template detected. Ready to build.';
        refs.templateStatus.classList.remove('warning');
      } else {
        markTemplateMissing();
      }
    } catch {
      markTemplateMissing();
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed', err));
    }
  }

  function markTemplateMissing() {
    refs.templateStatus.textContent = 'Template missing. Place VideoSaverTemplate.saver.zip under /templates/.';
    refs.templateStatus.classList.add('warning');
  }

  function onFileSelected(file) {
    selectedFile = file;
    refs.fileMeta.textContent = `${file.name} • ${formatBytes(file.size)}`;
    if (file.size > WARN_SIZE) appendLog('Large file detected. Remux may be faster if codecs already match.');
    clearDownloads();
    setStatus('Ready to build.');
  }

  async function buildSaver() {
    setBusy(true);
    clearLog();
    clearDownloads();
    progress.reset();
    setProgress(0);
    setStatus('Starting build…');

    try {
      setStatus('Loading template…');
      setProgress(0.05);
      const templateZip = await loadTemplate();
      const root = findBundleRoot(templateZip);
      if (!root) throw new Error('Template missing .saver root folder.');

      const infoPath = `${root}Contents/Info.plist`;
      const infoFile = templateZip.file(infoPath);
      if (!infoFile) throw new Error('Info.plist not found in template.');

      const saverName = sanitize(refs.saverName.value) || 'MySaver';
      const bundleId = refs.bundleId.value.trim() || `local.videosaver.${Date.now()}`;
      const newRoot = `${saverName}.saver/`;

      setStatus('Reading video…');
      setProgress(0.15);
      const sourceBuffer = await selectedFile.arrayBuffer();

      setStatus('Inspecting video…');
      setProgress(0.25);
      const mode = getMode();
      appendLog(`Mode selected: ${mode}`);
      const probe = await safeProbe(sourceBuffer, workerBridge);
      if (probe) {
        appendLog(
          `Detected format=${probe.format || 'unknown'} video=${probe.videoCodec || 'unknown'} audio=${probe.audioCodec || 'none'}`
        );
        appendLog(
          probe.isCompatible
            ? 'Streams already H.264/AAC inside an MP4 container.'
            : probe.copySafe
              ? 'Streams look copy-safe but container needs attention.'
              : 'Stream codecs/container require transcoding.'
        );
      } else {
        appendLog('Probe unavailable; falling back to safe defaults.');
      }

      setStatus('Preparing video…');
      setProgress(0.3);
      const videoPlan = await prepareVideo(sourceBuffer, mode, probe, workerBridge, progress);
      videoPlan.messages.forEach(appendLog);
      setProgress(0.82);

      setStatus('Updating bundle…');
      stripSignatures(templateZip, root);
      templateZip.remove(`${root}Contents/Resources/payload.mp4`);
      templateZip.remove(`${root}Contents/Resources/payload.mov`);
      templateZip.file(`${root}Contents/Resources/payload.mp4`, videoPlan.bytes, {
        binary: true,
        unixPermissions: 0o644,
      });
      const plist = await infoFile.async('string');
      templateZip.file(infoPath, patchPlist(plist, { CFBundleName: saverName, CFBundleIdentifier: bundleId }));

      setStatus('Packaging downloads…');
      setProgress(0.88);
      const saverZip = await rebase(templateZip, root, newRoot);
      const bundleBlob = await saverZip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        platform: 'UNIX',
      });
      const installerZip = await createInstaller(saverZip, newRoot.slice(0, -1));
      const installerBlob = await installerZip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        platform: 'UNIX',
      });

      setDownloads(bundleBlob, `${saverName}.saver.zip`, installerBlob, `${saverName}-install.zip`);
      appendLog(`Saved bundle as ${saverName}.saver (${videoPlan.description}).`);
      appendLog('Install path: ~/Library/Screen Savers/');
      setStatus('Done! Grab your downloads below.');
      setProgress(1);
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Build failed.', true);
    } finally {
      setBusy(false);
    }
  }

  async function safeProbe(buffer, bridge) {
    try {
      const copy = buffer.slice(0);
      appendLog('Sending probe request to FFmpeg worker…');
      const result = await bridge.probe(copy, { name: `probe-${Date.now()}` });
      appendLog('Probe response received.');
      return result;
    } catch (error) {
      console.warn('Probe failed', error);
      appendLog(`Probe failed: ${error?.message || error}`);
      return null;
    }
  }

  async function prepareVideo(sourceBuffer, mode, probe, bridge, progressHandle) {
    const notes = [];
    const copy = () => sourceBuffer.slice(0);
    const hasAudioKnown = probe?.hasAudio;
    appendLog(`Worker plan: audioKnown=${hasAudioKnown === undefined ? 'unknown' : hasAudioKnown}`);

    const runTranscode = async (reason) => {
      notes.push(reason);
      appendLog(reason);
      progressHandle.startWorker(0.33, 0.5);
      try {
        const result = await bridge.transcode(copy(), {
          hasAudio: hasAudioKnown === false ? false : undefined,
        });
        return {
          bytes: new Uint8Array(result.buffer),
          description: hasAudioKnown === false ? 'transcoded (video only)' : 'transcoded to H.264/AAC',
        };
      } catch (error) {
        const msg = error?.message || '';
        const audioUnknown = hasAudioKnown !== false && /match.*streams|specifie/i.test(msg);
        if (!audioUnknown) throw error;
        notes.push('Audio track missing; retrying transcode without audio.');
        const fallback = await bridge.transcode(copy(), { hasAudio: false });
        return {
          bytes: new Uint8Array(fallback.buffer),
          description: 'transcoded to H.264 (silent)',
        };
      } finally {
        progressHandle.stopWorker(0.82);
      }
    };

    const runRemux = async (reason) => {
      notes.push(reason);
      appendLog(reason);
      progressHandle.startWorker(0.33, 0.35);
      try {
        const response = await bridge.remux(copy(), {
          hasAudio: hasAudioKnown === false ? false : undefined,
        });
        return {
          bytes: new Uint8Array(response.buffer),
          description: 'stream-copied MP4 container',
        };
      } finally {
        progressHandle.stopWorker(0.7);
      }
    };

    let outcome;
    if (mode === 'force') {
      outcome = await runTranscode('Force mode engaged: transcoding to H.264/AAC.');
    } else if (mode === 'passthrough') {
      if (!probe) {
        outcome = await runTranscode('Passthrough requested but probe unavailable; transcoding for safety.');
      } else if (probe.copySafe && probe.containerOK) {
        outcome = await runRemux('Passthrough: refreshing MP4 container without re-encoding.');
      } else if (probe.copySafe) {
        outcome = await runRemux('Passthrough: codecs compatible; rewrapping streams into MP4.');
      } else {
        outcome = await runTranscode('Passthrough requested but codecs/container incompatible. Transcoding instead.');
      }
    } else {
      if (!probe) {
        outcome = await runTranscode('Auto mode: probe failed, falling back to transcoding.');
      } else if (probe.isCompatible) {
        outcome = await runRemux('Auto mode: already H.264/AAC MP4; remuxing for faststart.');
      } else if (probe.copySafe) {
        outcome = await runRemux('Auto mode: codecs compatible but container mismatch; remuxing.');
      } else {
        outcome = await runTranscode('Auto mode: codecs incompatible; transcoding to H.264/AAC.');
      }
    }

    return {
      ...outcome,
      messages: notes,
    };
  }

  function stripSignatures(zip, root) {
    [
      `${root}Contents/_CodeSignature/`,
      `${root}Contents/_CodeSignature/CodeResources`,
      `${root}Contents/CodeResources`,
    ].forEach((path) => zip.remove(path));
  }

  function setDownloads(bundleBlob, bundleName, installerBlob, installerName) {
    clearDownloads();
    bundleURL = URL.createObjectURL(bundleBlob);
    installerURL = URL.createObjectURL(installerBlob);
    Object.assign(refs.bundleLink, { href: bundleURL, download: bundleName });
    Object.assign(refs.installerLink, { href: installerURL, download: installerName });
    refs.downloads.hidden = false;
  }

  function clearDownloads() {
    refs.downloads.hidden = true;
    if (bundleURL) URL.revokeObjectURL(bundleURL);
    if (installerURL) URL.revokeObjectURL(installerURL);
    bundleURL = null;
    installerURL = null;
    refs.bundleLink.removeAttribute('href');
    refs.installerLink.removeAttribute('href');
  }

  function setBusy(state) {
    refs.buildBtn.disabled = state;
    refs.browseBtn.disabled = state;
    $$('input[name="transcode"]').forEach((node) => {
      node.disabled = state;
    });
    refs.saverName.disabled = state;
    refs.bundleId.disabled = state;
  }

  function setProgress(value) {
    progress.set(value);
  }

  function setStatus(message, error = false) {
    refs.status.textContent = message;
    refs.status.classList.toggle('error', error);
  }

  function appendLog(message) {
    refs.log.textContent += `[${new Date().toLocaleTimeString()}] ${message}\n`;
    refs.log.scrollTop = refs.log.scrollHeight;
  }

  function clearLog() {
    refs.log.textContent = '';
  }

  function getMode() {
    return document.querySelector('input[name="transcode"]:checked')?.value ?? 'auto';
  }

  function sanitize(value) {
    return (value || '').replace(/[^A-Za-z0-9 _.-]+/g, '').trim();
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const pow = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
    const val = bytes / 1024 ** pow;
    return `${val.toFixed(val >= 10 || pow === 0 ? 0 : 1)} ${sizes[pow]}`;
  }

  function createTemplateLoader(url) {
    let cachedBytes = null;
    let inflight = null;
    return async () => {
      const ensureBytes = async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Template missing. Place VideoSaverTemplate.saver.zip under /templates/.');
        const arrayBuffer = await res.arrayBuffer();
        cachedBytes = new Uint8Array(arrayBuffer);
        return cachedBytes;
      };
      if (!cachedBytes) {
        inflight ||= ensureBytes().finally(() => {
          inflight = null;
        });
        await inflight;
      }
      return JSZip.loadAsync(cachedBytes.slice(0));
    };
  }

  function createWorkerBridge(worker, callbacks = {}) {
    const pending = new Map();
    let requestId = 0;

    const failPending = (message) => {
      if (pending.size === 0) return;
      for (const { reject } of pending.values()) reject(new Error(message || 'FFmpeg worker crashed.'));
      pending.clear();
    };

    worker.onmessage = ({ data }) => {
      const { id, type, payload } = data;
      if (type === 'progress') {
        callbacks.onProgress?.(payload);
        return;
      }
      if (type === 'log') {
        callbacks.onLog?.(payload);
        return;
      }
      const job = pending.get(id);
      if (!job) {
        if (type === 'error') callbacks.onError?.(payload?.message);
        return;
      }
      pending.delete(id);
      if (type === 'result') job.resolve(payload);
      else job.reject(new Error(payload?.message || 'FFmpeg worker error.'));
    };

    worker.onerror = (error) => {
      console.error(error);
      failPending(error?.message || 'FFmpeg worker crashed.');
      callbacks.onError?.('FFmpeg worker crashed. See console.');
    };

    worker.onmessageerror = (event) => {
      console.error('FFmpeg worker message error', event);
      failPending('FFmpeg worker communication error.');
      callbacks.onError?.('FFmpeg worker communication error.');
    };

    const call = (action, payload, transfer = []) =>
      new Promise((resolve, reject) => {
        const id = requestId++;
        pending.set(id, { resolve, reject });
        try {
          worker.postMessage({ id, action, payload }, transfer);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });

    return {
      probe(buffer, options = {}) {
        const copy = buffer;
        const payload = { ...options, buffer: copy };
        return call('probe', payload, [copy]);
      },
      transcode(buffer, options = {}) {
        const copy = buffer;
        const { name, hasAudio, ...rest } = options;
        const payload = { ...rest, name: name || `transcode-${Date.now()}`, buffer: copy };
        if (hasAudio === false) payload.hasAudio = false;
        return call('transcode', payload, [copy]);
      },
      remux(buffer, options = {}) {
        const copy = buffer;
        const { name, hasAudio, ...rest } = options;
        const payload = { ...rest, name: name || `remux-${Date.now()}`, buffer: copy };
        if (hasAudio === false) payload.hasAudio = false;
        return call('remux', payload, [copy]);
      },
    };
  }

  function createProgressTracker(node) {
    let current = 0;
    let workerWindow = null;
    const clamp = (value) => Math.max(0, Math.min(1, value));
    return {
      reset() {
        current = 0;
        workerWindow = null;
        node.value = 0;
      },
      set(value) {
        const next = clamp(value);
        if (next > current) {
          current = next;
          node.value = current;
        }
      },
      startWorker(base, span) {
        workerWindow = { base: clamp(base), span: clamp(span) };
      },
      stopWorker(nextValue) {
        workerWindow = null;
        if (typeof nextValue === 'number') this.set(nextValue);
      },
      updateFromWorker(ratio) {
        if (!workerWindow) return;
        const value = workerWindow.base + workerWindow.span * clamp(ratio ?? 0);
        if (value > current) {
          current = value;
          node.value = current;
        }
      },
    };
  }

  function patchPlist(text, values) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Invalid Info.plist XML.');
    const dict = doc.querySelector('plist > dict');
    if (!dict) throw new Error('Info.plist missing <dict>.');
    for (const [key, value] of Object.entries(values)) upsertKey(doc, dict, key, value);
    return new XMLSerializer().serializeToString(doc);
  }

  function upsertKey(doc, dict, key, value) {
    for (const node of dict.children) {
      if (node.tagName === 'key' && node.textContent === key) {
        const sibling = node.nextElementSibling;
        if (sibling && sibling.tagName === 'string') sibling.textContent = value;
        else {
          const str = doc.createElement('string');
          str.textContent = value;
          dict.insertBefore(str, sibling);
        }
        return;
      }
    }
    const keyNode = doc.createElement('key');
    keyNode.textContent = key;
    const strNode = doc.createElement('string');
    strNode.textContent = value;
    dict.append(keyNode, strNode);
  }

  function findBundleRoot(zip) {
    const roots = new Set();
    Object.keys(zip.files).forEach((path) => {
      const head = path.split('/')[0];
      if (head && head.endsWith('.saver')) roots.add(`${head}/`);
    });
    return roots.size === 1 ? roots.values().next().value : null;
  }

  async function rebase(zip, oldRoot, newRoot) {
    if (oldRoot === newRoot) return zip;
    const clone = new JSZip();
    for (const [path, entry] of Object.entries(zip.files)) {
      const target = path.startsWith(oldRoot) ? newRoot + path.slice(oldRoot.length) : path;
      if (entry.dir) {
        clone.folder(target);
      } else {
        const data = await entry.async('uint8array');
        const isMachBinary =
          target.startsWith(`${newRoot}Contents/MacOS/`) && !target.endsWith('/');
        const permissions = entry.unixPermissions ?? (isMachBinary ? 0o755 : 0o644);
        clone.file(target, data, { binary: true, unixPermissions: permissions });
      }
    }
    return clone;
  }

  async function createInstaller(bundleZip, rootName) {
    const zip = new JSZip();
    for (const [path, entry] of Object.entries(bundleZip.files)) {
      if (entry.dir) {
        zip.folder(path);
      } else {
        const data = await entry.async('uint8array');
        const isMachBinary = path.startsWith(`${rootName}.saver/Contents/MacOS/`) && !path.endsWith('/');
        const permissions = entry.unixPermissions ?? (isMachBinary ? 0o755 : 0o644);
        zip.file(path, data, { binary: true, unixPermissions: permissions });
      }
    }
    zip.file('install.command', installerScript(rootName), { unixPermissions: 0o755 });
    return zip;
  }

  const installerScript = (name) => `#!/usr/bin/env bash
set -euo pipefail
NAME="\${1:-${name}}"
SRC="$(cd "$(dirname "$0")" && pwd)/$NAME"
DST="$HOME/Library/Screen Savers"
mkdir -p "$DST"
cp -R "$SRC" "$DST/"
echo "Installed to: $DST/$NAME"
open "$DST"
`;
})();
