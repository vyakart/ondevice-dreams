/**
 * plist.js - Info.plist XML parsing and manipulation
 *
 * Handles parsing and updating macOS Info.plist files (XML format).
 * Used to customize CFBundleName and CFBundleIdentifier in screensaver bundles.
 */

'use strict';

/**
 * Patch an Info.plist XML string with new key-value pairs
 * @param {string} text - Info.plist XML content
 * @param {Object} values - Key-value pairs to update (e.g., {CFBundleName: 'MySaver'})
 * @returns {string} Updated XML string
 * @throws {Error} If XML is malformed or missing required structure
 */
export function patchPlist(text, values) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Invalid Info.plist XML.');
  }

  const dict = doc.querySelector('plist > dict');
  if (!dict) {
    throw new Error('Info.plist missing <dict>.');
  }

  for (const [key, value] of Object.entries(values)) {
    upsertKey(doc, dict, key, value);
  }

  return new XMLSerializer().serializeToString(doc);
}

/**
 * Insert or update a key-value pair in a plist dictionary
 * @param {Document} doc - XML document
 * @param {Element} dict - Dictionary element to update
 * @param {string} key - Plist key (e.g., 'CFBundleName')
 * @param {string} value - Value to set
 */
export function upsertKey(doc, dict, key, value) {
  for (const node of dict.children) {
    if (node.tagName === 'key' && node.textContent === key) {
      const sibling = node.nextElementSibling;
      if (sibling && sibling.tagName === 'string') {
        sibling.textContent = value;
      } else {
        const str = doc.createElement('string');
        str.textContent = value;
        dict.insertBefore(str, sibling);
      }
      return;
    }
  }

  // Key not found, append new key-value pair
  const keyNode = doc.createElement('key');
  keyNode.textContent = key;
  const strNode = doc.createElement('string');
  strNode.textContent = value;
  dict.append(keyNode, strNode);
}
