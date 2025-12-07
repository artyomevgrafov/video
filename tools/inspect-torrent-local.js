#!/usr/bin/env node
// Usage: node inspect-torrent-local.js <file>
const fs = require('fs');
const crypto = require('crypto');

(async () => {
  const file = process.argv[2];
  if (!file) return console.error('Usage: node inspect-torrent-local.js <file>');

  // Dynamic import for ESM module
  const bencodeModule = await import('bencode');
  const { decode } = bencodeModule.default;

  try {
    const buffer = fs.readFileSync(file);
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
})();
