#!/usr/bin/env node
/**
 * Development server with CORS headers for FFmpeg.wasm
 * Enables SharedArrayBuffer support for local testing
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8888;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
};

const server = http.createServer((req, res) => {
  // Set CORS headers for SharedArrayBuffer (FFmpeg.wasm requirement)
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  let filePath = '.' + req.url;
  if (filePath === './') {
    filePath = './index.html';
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found\n');
      } else {
        res.writeHead(500);
        res.end('Server Error: ' + error.code + '\n');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  ONDEVICE-DREAMS Dev Server                            ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log(`🚀 Server running at: http://localhost:${PORT}/`);
  console.log('📡 CORS Headers: ENABLED (SharedArrayBuffer support)');
  console.log('⚡ FFmpeg.wasm: READY\n');
  console.log('Press Ctrl+C to stop\n');
});
