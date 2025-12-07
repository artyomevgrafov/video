#!/usr/bin/env node
// Usage: node inspect-torrent.js <url>
const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');

(async () => {
  const url = process.argv[2];
  if (!url) return console.error('Usage: node inspect-torrent.js <url>');

  // Dynamic import for ESM module
  const bencodeModule = await import('bencode');
  const { decode } = bencodeModule.default;

  const parsed = new URL(url);
  const protocol = parsed.protocol === 'https:' ? https : http;

  protocol.get(url, (res) => {
    if (res.statusCode !== 200) {
      console.error('Failed to fetch:', res.statusCode);
      return;
    }
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const torrent = decode(buffer);
        const info = torrent.info;
        const name = info.name ? Buffer.isBuffer(info.name) ? info.name.toString('utf8') : String(info.name) : 'Unknown';
        const files = info.files ? info.files.map(f => Buffer.isBuffer(f.path[0]) ? f.path[0].toString('utf8') : String(f.path[0])) : [];
        const length = info.length || (info.files ? info.files.reduce((a, f) => a + f.length, 0) : 0);
        const infoBuffer = bencodeModule.default.encode(info);
        const infoHash = crypto.createHash('sha1').update(infoBuffer).digest('hex');
        console.log('Name:', name);
        console.log('InfoHash:', infoHash);
        console.log('Total size:', length, 'bytes');
        if (files.length) {
          console.log('Files:');
          files.forEach(f => console.log('  -', f));
        }
      } catch (err) {
        console.error('Error parsing torrent:', err.message);
      }
    });
  }).on('error', err => {
    console.error('Request error:', err.message);
  });
})();
