/**
 * bundler.js - JSZip operations for screensaver bundle creation
 *
 * Handles:
 * - Template loading with caching
 * - Bundle manipulation (find root, strip signatures, rebase)
 * - Installer script generation
 */

'use strict';

/**
 * Template loader with in-memory caching and inflight request deduplication
 */
export class TemplateLoader {
  constructor(templateUrl) {
    this.url = templateUrl;
    this.cachedBytes = null;
    this.inflight = null;
  }

  /**
   * Load template and return JSZip instance
   * Caches the raw bytes to avoid re-fetching
   * @returns {Promise<JSZip>} JSZip instance of template
   * @throws {Error} If template is missing or fetch fails
   */
  async load() {
    const ensureBytes = async () => {
      const res = await fetch(this.url);
      if (!res.ok) {
        throw new Error(
          'Template missing. Place VideoSaverTemplate.saver.zip under /templates/.'
        );
      }
      const arrayBuffer = await res.arrayBuffer();
      this.cachedBytes = new Uint8Array(arrayBuffer);
      return this.cachedBytes;
    };

    if (!this.cachedBytes) {
      this.inflight ||= ensureBytes().finally(() => {
        this.inflight = null;
      });
      await this.inflight;
    }

    // Return fresh JSZip instance with copy of cached bytes
    return JSZip.loadAsync(this.cachedBytes.slice(0));
  }
}

/**
 * Find the .saver bundle root in a JSZip instance
 * @param {JSZip} zip - JSZip instance
 * @returns {string|null} Root path (e.g., "VideoSaver.saver/") or null if not found
 */
export function findBundleRoot(zip) {
  const roots = new Set();

  Object.keys(zip.files).forEach((path) => {
    const head = path.split('/')[0];
    if (head && head.endsWith('.saver')) {
      roots.add(`${head}/`);
    }
  });

  return roots.size === 1 ? roots.values().next().value : null;
}

/**
 * Strip code signatures from bundle
 * Removes _CodeSignature folders since we're modifying the bundle
 * @param {JSZip} zip - JSZip instance to modify
 * @param {string} root - Bundle root path
 */
export function stripSignatures(zip, root) {
  [
    `${root}Contents/_CodeSignature/`,
    `${root}Contents/_CodeSignature/CodeResources`,
    `${root}Contents/CodeResources`
  ].forEach((path) => zip.remove(path));
}

/**
 * Rebase bundle to new root name
 * Renames the .saver folder while preserving Unix permissions
 * @param {JSZip} zip - Source JSZip instance
 * @param {string} oldRoot - Current root path
 * @param {string} newRoot - New root path
 * @returns {Promise<JSZip>} New JSZip instance with rebased paths
 */
export async function rebase(zip, oldRoot, newRoot) {
  if (oldRoot === newRoot) return zip;

  const clone = new JSZip();

  for (const [path, entry] of Object.entries(zip.files)) {
    const target = path.startsWith(oldRoot)
      ? newRoot + path.slice(oldRoot.length)
      : path;

    if (entry.dir) {
      clone.folder(target);
    } else {
      const data = await entry.async('uint8array');

      // Preserve executable permissions for MacOS binaries
      const isMachBinary =
        target.startsWith(`${newRoot}Contents/MacOS/`) &&
        !target.endsWith('/');

      const permissions = entry.unixPermissions ?? (isMachBinary ? 0o755 : 0o644);

      clone.file(target, data, {
        binary: true,
        unixPermissions: permissions
      });
    }
  }

  return clone;
}

/**
 * Create installer ZIP with install.command script
 * @param {JSZip} bundleZip - Screensaver bundle ZIP
 * @param {string} rootName - Bundle name without .saver extension
 * @returns {Promise<JSZip>} Installer ZIP instance
 */
export async function createInstaller(bundleZip, rootName) {
  const zip = new JSZip();

  // Copy all files from bundle
  for (const [path, entry] of Object.entries(bundleZip.files)) {
    if (entry.dir) {
      zip.folder(path);
    } else {
      const data = await entry.async('uint8array');

      // Preserve executable permissions
      const isMachBinary =
        path.startsWith(`${rootName}.saver/Contents/MacOS/`) &&
        !path.endsWith('/');

      const permissions = entry.unixPermissions ?? (isMachBinary ? 0o755 : 0o644);

      zip.file(path, data, {
        binary: true,
        unixPermissions: permissions
      });
    }
  }

  // Add install script with executable permissions
  zip.file('install.command', installerScript(rootName), {
    unixPermissions: 0o755
  });

  return zip;
}

/**
 * Generate bash installer script
 * @param {string} name - Screensaver name
 * @returns {string} Bash script content
 */
export function installerScript(name) {
  return `#!/usr/bin/env bash
set -euo pipefail
NAME="\${1:-${name}}"
SRC="$(cd "$(dirname "$0")" && pwd)/$NAME"
DST="$HOME/Library/Screen Savers"
mkdir -p "$DST"
cp -R "$SRC" "$DST/"
echo "Installed to: $DST/$NAME"
open "$DST"
`;
}
