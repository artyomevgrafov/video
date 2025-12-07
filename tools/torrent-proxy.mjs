// ESM: save as .mjs
// Usage: node tools/torrent-proxy.mjs <torrent-file> <output-dir>
import fs from 'fs';
import path from 'path';
import WebTorrent from 'webtorrent';

const torrentPath = process.argv[2];
const outputDir = process.argv[3] || './downloads';
if (!torrentPath) {
  console.error('Usage: node tools/torrent-proxy.mjs <torrent-file> <output-dir>');
  process.exit(1);
}

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const client = new WebTorrent();

client.add(torrentPath, { path: outputDir }, torrent => {
  console.log('Torrent loaded:', torrent.name);
  torrent.files.forEach(file => {
    let fname = file.name;
    // Try to decode names like 69,48,49,...
    if (/^(\d+,)+\d+$/.test(fname.replace(/\./g, ','))) {
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
