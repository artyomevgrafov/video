#!/usr/bin/env node
// Usage: node torrent-proxy.js <torrent-file> <output-dir>
const fs = require('fs');
const path = require('path');
const WebTorrent = require('webtorrent');

const torrentPath = process.argv[2];
const outputDir = process.argv[3] || './downloads';
if (!torrentPath) return console.error('Usage: node torrent-proxy.js <torrent-file> <output-dir>');

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const client = new WebTorrent();

client.add(torrentPath, { path: outputDir }, torrent => {
  console.log('Torrent loaded:', torrent.name);
  torrent.files.forEach(file => {
    // Decode file name if needed
    let fname = file.name;
    if (/^\d+(,\d+)*$/.test(fname.replace(/\./g, ','))) {
      // If name is like 69,48,49,... decode
      fname = fname.split(',').map(n => String.fromCharCode(Number(n))).join('');
      console.log('Decoded file name:', fname);
    }
    console.log('File:', fname, file.length, 'bytes');
  });
  console.log('Ready to stream.');
});

client.on('error', err => {
  console.error('WebTorrent error:', err.message);
});
