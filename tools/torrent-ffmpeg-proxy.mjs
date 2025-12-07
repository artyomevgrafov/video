// ESM: save as .mjs
// Usage: node tools/torrent-ffmpeg-proxy.mjs <torrent-file> <output-dir> <port>
import fs from 'fs';
import path from 'path';
import WebTorrent from 'webtorrent';
import express from 'express';
import { spawn } from 'child_process';

const torrentPath = process.argv[2];
const outputDir = process.argv[3] || './downloads';
const PORT = process.argv[4] || 8090;
if (!torrentPath) {
  console.error('Usage: node tools/torrent-ffmpeg-proxy.mjs <torrent-file> <output-dir> <port>');
  process.exit(1);
}

if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const client = new WebTorrent();
const app = express();
let loadedTorrent = null;

client.add(torrentPath, { path: outputDir }, torrent => {
  loadedTorrent = torrent;
  console.log('Torrent loaded:', torrent.name);
  torrent.files.forEach(file => {
    console.log('File:', file.name, file.length, 'bytes');
  });
  console.log('Ready to stream.');
});

app.get('/files', (req, res) => {
  if (!loadedTorrent) return res.status(503).send('Torrent not loaded');
  res.json(loadedTorrent.files.map(f => ({ name: f.name, length: f.length })));
});

app.get('/stream/:file', (req, res) => {
  if (!loadedTorrent) return res.status(503).send('Torrent not loaded');
  const fname = req.params.file;
  const file = loadedTorrent.files.find(f => f.name === fname);
  if (!file) return res.status(404).send('File not found');

  // ffmpeg proxy: transcode to mp4 with hardware acceleration if available
  file.getBuffer((err, buffer) => {
    if (err) return res.status(500).send('Error reading file');
    const ffmpegArgs = [
      '-hwaccel', 'auto',
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      '-f', 'mp4',
      'pipe:1'
    ];
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpeg.stdin.write(buffer);
    ffmpeg.stdin.end();
    res.setHeader('Content-Type', 'video/mp4');
    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', d => process.stderr.write(d));
    ffmpeg.on('close', () => res.end());
  });
});

app.listen(PORT, () => {
  console.log('FFmpeg proxy server running on port', PORT);
});
