/**
 * transcoder.js - FFmpeg worker bridge and video processing
 *
 * Handles:
 * - Worker communication with promise-based API
 * - Video probing (codec/format detection)
 * - Transcoding (H.264/AAC encoding)
 * - Remuxing (stream copy to MP4)
 * - Auto/force/passthrough mode orchestration
 */

'use strict';

/**
 * FFmpeg transcoder with event emitter for logs and progress
 */
export class Transcoder {
  constructor(workerPath = 'ffmpeg-worker.js') {
    this.worker = new Worker(workerPath);
    this.pending = new Map();
    this.requestId = 0;
    this.listeners = new Map([
      ['log', []],
      ['progress', []],
      ['error', []]
    ]);

    this._initWorker();
  }

  /**
   * Initialize worker message handlers
   * @private
   */
  _initWorker() {
    this.worker.onmessage = ({ data }) => {
      const { id, type, payload } = data;

      if (type === 'progress') {
        this._emit('progress', payload);
        return;
      }

      if (type === 'log') {
        this._emit('log', payload);
        return;
      }

      const job = this.pending.get(id);
      if (!job) {
        if (type === 'error') {
          this._emit('error', payload?.message);
        }
        return;
      }

      this.pending.delete(id);

      if (type === 'result') {
        job.resolve(payload);
      } else {
        job.reject(new Error(payload?.message || 'FFmpeg worker error.'));
      }
    };

    this.worker.onerror = (error) => {
      console.error(error);
      this._failPending(error?.message || 'FFmpeg worker crashed.');
      this._emit('error', 'FFmpeg worker crashed. See console.');
    };

    this.worker.onmessageerror = (event) => {
      console.error('FFmpeg worker message error', event);
      this._failPending('FFmpeg worker communication error.');
      this._emit('error', 'FFmpeg worker communication error.');
    };
  }

  /**
   * Subscribe to events
   * @param {'log'|'progress'|'error'} event - Event type
   * @param {Function} callback - Event handler
   */
  on(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).push(callback);
    }
  }

  /**
   * Unsubscribe from events
   * @param {'log'|'progress'|'error'} event - Event type
   * @param {Function} callback - Event handler to remove
   */
  off(event, callback) {
    if (this.listeners.has(event)) {
      const callbacks = this.listeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index !== -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  /**
   * Emit event to all subscribers
   * @private
   */
  _emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach((callback) => callback(data));
    }
  }

  /**
   * Fail all pending requests
   * @private
   */
  _failPending(message) {
    if (this.pending.size === 0) return;

    for (const { reject } of this.pending.values()) {
      reject(new Error(message || 'FFmpeg worker crashed.'));
    }

    this.pending.clear();
  }

  /**
   * Send message to worker and return promise
   * @private
   */
  _call(action, payload, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      this.pending.set(id, { resolve, reject });

      try {
        this.worker.postMessage({ id, action, payload }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Probe video file for codec and format information
   * @param {ArrayBuffer} buffer - Video file buffer
   * @param {Object} options - Probe options
   * @returns {Promise<Object>} Probe result with codec/format info
   */
  async probe(buffer, options = {}) {
    const copy = buffer.slice(0);
    const payload = {
      ...options,
      buffer: copy,
      name: options.name || `probe-${Date.now()}`
    };
    return this._call('probe', payload, [copy]);
  }

  /**
   * Transcode video to H.264/AAC
   * @param {ArrayBuffer} buffer - Source video buffer
   * @param {Object} options - Transcode options
   * @returns {Promise<Object>} Result with buffer property
   */
  async transcode(buffer, options = {}) {
    const copy = buffer.slice(0);
    const { name, hasAudio, ...rest } = options;
    const payload = {
      ...rest,
      name: name || `transcode-${Date.now()}`,
      buffer: copy
    };

    if (hasAudio === false) {
      payload.hasAudio = false;
    }

    return this._call('transcode', payload, [copy]);
  }

  /**
   * Remux video (stream copy to MP4 container)
   * @param {ArrayBuffer} buffer - Source video buffer
   * @param {Object} options - Remux options
   * @returns {Promise<Object>} Result with buffer property
   */
  async remux(buffer, options = {}) {
    const copy = buffer.slice(0);
    const { name, hasAudio, ...rest } = options;
    const payload = {
      ...rest,
      name: name || `remux-${Date.now()}`,
      buffer: copy
    };

    if (hasAudio === false) {
      payload.hasAudio = false;
    }

    return this._call('remux', payload, [copy]);
  }

  /**
   * Prepare video with auto/force/passthrough logic
   * Handles audio detection retry on failure
   * @param {ArrayBuffer} sourceBuffer - Source video buffer
   * @param {'auto'|'force'|'passthrough'} mode - Processing mode
   * @param {Object|null} probe - Probe result (can be null)
   * @param {Object} progressTracker - Progress tracker instance
   * @returns {Promise<Object>} Result with bytes, description, messages
   */
  async prepareVideo(sourceBuffer, mode, probe, progressTracker) {
    const notes = [];
    const copy = () => sourceBuffer.slice(0);
    const hasAudioKnown = probe?.hasAudio;

    this._emit('log', {
      message: `Worker plan: audioKnown=${hasAudioKnown === undefined ? 'unknown' : hasAudioKnown}`
    });

    const runTranscode = async (reason) => {
      notes.push(reason);
      this._emit('log', { message: reason });

      progressTracker.startWorker(0.33, 0.5);

      try {
        const result = await this.transcode(copy(), {
          hasAudio: hasAudioKnown === false ? false : undefined
        });

        return {
          bytes: new Uint8Array(result.buffer),
          description: hasAudioKnown === false
            ? 'transcoded (video only)'
            : 'transcoded to H.264/AAC'
        };
      } catch (error) {
        const msg = error?.message || '';
        const audioUnknown =
          hasAudioKnown !== false && /match.*streams|specifie/i.test(msg);

        if (!audioUnknown) throw error;

        // Retry without audio
        notes.push('Audio track missing; retrying transcode without audio.');
        const fallback = await this.transcode(copy(), { hasAudio: false });

        return {
          bytes: new Uint8Array(fallback.buffer),
          description: 'transcoded to H.264 (silent)'
        };
      } finally {
        progressTracker.stopWorker(0.82);
      }
    };

    const runRemux = async (reason) => {
      notes.push(reason);
      this._emit('log', { message: reason });

      progressTracker.startWorker(0.33, 0.35);

      try {
        const response = await this.remux(copy(), {
          hasAudio: hasAudioKnown === false ? false : undefined
        });

        return {
          bytes: new Uint8Array(response.buffer),
          description: 'stream-copied MP4 container'
        };
      } finally {
        progressTracker.stopWorker(0.7);
      }
    };

    let outcome;

    if (mode === 'force') {
      outcome = await runTranscode('Force mode engaged: transcoding to H.264/AAC.');
    } else if (mode === 'passthrough') {
      if (!probe) {
        outcome = await runTranscode(
          'Passthrough requested but probe unavailable; transcoding for safety.'
        );
      } else if (probe.copySafe && probe.containerOK) {
        outcome = await runRemux(
          'Passthrough: refreshing MP4 container without re-encoding.'
        );
      } else if (probe.copySafe) {
        outcome = await runRemux(
          'Passthrough: codecs compatible; rewrapping streams into MP4.'
        );
      } else {
        outcome = await runTranscode(
          'Passthrough requested but codecs/container incompatible. Transcoding instead.'
        );
      }
    } else {
      // Auto mode
      if (!probe) {
        outcome = await runTranscode(
          'Auto mode: probe failed, falling back to transcoding.'
        );
      } else if (probe.isCompatible) {
        outcome = await runRemux(
          'Auto mode: already H.264/AAC MP4; remuxing for faststart.'
        );
      } else if (probe.copySafe) {
        outcome = await runRemux(
          'Auto mode: codecs compatible but container mismatch; remuxing.'
        );
      } else {
        outcome = await runTranscode(
          'Auto mode: codecs incompatible; transcoding to H.264/AAC.'
        );
      }
    }

    return {
      ...outcome,
      messages: notes
    };
  }
}
