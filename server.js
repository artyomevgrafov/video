const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const url = require('url');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8081;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.static('public'));
app.use(morgan(':remote-addr :method :url :status :res[content-length] - :response-time ms'));

// Simple route to open player with a url param
app.get('/play', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing ?url=');
  // Prevent open redirect abuse? Basic check
  res.redirect(`/player.html?url=${encodeURIComponent(target)}`);
});

// Proxy streaming route with Range support
app.get('/proxy', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing ?url=');

  let parsed;
  try {
    parsed = new URL(target);
  } catch (err) {
    return res.status(400).send('Invalid URL');
  }

  const options = {
    method: 'GET',
    headers: {}
  };

  // Forward range header for seeking
  if (req.headers.range) options.headers.range = req.headers.range;

  const protocol = parsed.protocol === 'https:' ? https : http;

  const proxyReq = protocol.request(parsed, options, (proxyRes) => {
    // Set headers
    const allowedHeaders = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
    allowedHeaders.forEach((h) => {
      const v = proxyRes.headers[h];
      if (v) res.setHeader(h, v);
    });

    res.statusCode = proxyRes.statusCode;
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('Proxy request error', err.message);
    res.status(502).send('Bad gateway');
  });

  proxyReq.end();
});

// Add a small JSON endpoint to generate share links
app.get('/api/share', (req, res) => {
  const urlParam = req.query.url;
  if (!urlParam) return res.status(400).json({error: 'Missing url'});
  const encoded = encodeURIComponent(urlParam);
  const host = req.get('host');
  const link = `${req.protocol}://${host}/player.html?url=${encoded}`;
  res.json({link});
});

// Diagnostic endpoint - returns requester IP
app.get('/whoami', (req, res) => {
  res.json({ ip: req.ip || req.connection.remoteAddress });
});

// Convert .torrent URL to magnet link
app.get('/api/torrent2magnet', async (req, res) => {
  const torrentUrl = req.query.url;
  if (!torrentUrl) return res.status(400).json({ error: 'Missing url' });

  try {
    // Dynamic import for ESM module
    const bencodeModule = await import('bencode');
    const { decode, encode } = bencodeModule.default;
    
    // Fetch the .torrent file
    const response = await fetch(torrentUrl);
    if (!response.ok) throw new Error('Failed to fetch torrent file');
    
    const buffer = Buffer.from(await response.arrayBuffer());
    const torrent = decode(buffer);
    
    // Calculate info hash
    const infoBuffer = encode(torrent.info);
    const infoHash = crypto.createHash('sha1').update(infoBuffer).digest('hex');
    
    // Helper to convert any buffer-like to string
    const toStr = (val) => {
      if (!val) return '';
      if (typeof val === 'string') return val;
      if (Buffer.isBuffer(val)) return val.toString('utf8');
      if (val instanceof Uint8Array) return Buffer.from(val).toString('utf8');
      return String(val);
    };
    
    // Get torrent name
    const name = toStr(torrent.info.name) || 'Unknown';
    
    // Build magnet URI
    const trackers = [];
    if (torrent['announce-list']) {
      torrent['announce-list'].forEach(tier => {
        tier.forEach(t => trackers.push(toStr(t)));
      });
    } else if (torrent.announce) {
      trackers.push(toStr(torrent.announce));
    }
    
    let magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
    trackers.forEach(tr => {
      magnet += `&tr=${encodeURIComponent(tr)}`;
    });
    
    res.json({ 
      magnet,
      name,
      infoHash
    });
  } catch (err) {
    console.error('Torrent parse error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Streaming helpers ----
let webtorrentClient = null;
const activeStreams = new Map(); // streamId -> { torrent, fileIndex, lastUsed, mp4Path, ffmpegProcess }

async function ensureWebtorrentClient() {
  if (webtorrentClient) return webtorrentClient;
  const mod = await import('webtorrent');
  const WebTorrent = mod.default || mod;
  webtorrentClient = new WebTorrent();
  return webtorrentClient;
}

function makeStreamId(infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`;
}

async function addTorrentForStreaming(magnetURI, opts = {}) {
  console.log('addTorrentForStreaming called', magnetURI);
  const client = await ensureWebtorrentClient();
  return new Promise((resolve, reject) => {
    const torrent = client.add(magnetURI, { path: opts.path || 'downloads' }, () => {
      console.log('torrent metadata ready', torrent.infoHash);
      const idx = torrent.files.findIndex(f => {
        const l = f.name.toLowerCase();
        return l.endsWith('.mp4') || l.endsWith('.webm') || l.endsWith('.avi') || l.endsWith('.mkv');
      });
      const fileIndex = idx >= 0 ? idx : 0;
      const streamId = makeStreamId(torrent.infoHash, fileIndex);
      const file = torrent.files[fileIndex];
      const mp4Path = `/tmp/${streamId}.mp4`;
      const hlsDir = `/tmp/hls_${streamId}`;
      if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir);
      // 1. Створюємо mp4-файл (faststart)
      const ffmpegMp4Args = [
        '-hwaccel', 'auto',
        '-i', 'pipe:0',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-f', 'mp4', mp4Path
      ];
      const ffmpegMp4 = spawn('ffmpeg', ffmpegMp4Args, { stdio: ['pipe', 'ignore', 'inherit'] });
      file.createReadStream().pipe(ffmpegMp4.stdin);
      ffmpegMp4.on('close', (code) => {
        if (code !== 0) {
          reject(new Error('ffmpeg mp4 failed'));
          return;
        }
        // 2. Генеруємо HLS з mp4-файлу для кожної якості
        const variants = [
          { name: '360p', scale: '640:360', bitrate: '800k', audiorate: '96k' },
          { name: '720p', scale: '1280:720', bitrate: '2500k', audiorate: '128k' },
          { name: '1080p', scale: '1920:1080', bitrate: '5000k', audiorate: '192k' }
        ];
        const hlsDirs = variants.map(v => `${hlsDir}_${v.name}`);
        hlsDirs.forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true}); });
        // Генеруємо master playlist
        const masterPlaylist = variants.map((v, i) =>
          `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(v.bitrate)*1.5},RESOLUTION=${v.scale.replace(':','x')},NAME=\"${v.name}\"\n${v.name}/index.m3u8`
        ).join('\n');
        fs.writeFileSync(path.join(hlsDir, 'index.m3u8'), '#EXTM3U\n' + masterPlaylist);

        let done = 0;
        let failed = false;
        variants.forEach((v, i) => {
          const args = [
            '-hwaccel', 'auto',
            '-i', mp4Path,
            '-vf', `scale=${v.scale}`,
            '-c:v', 'libx264',
            '-b:v', v.bitrate,
            '-preset', 'veryfast',
            '-tune', 'zerolatency',
            '-c:a', 'aac',
            '-b:a', v.audiorate,
            '-f', 'hls',
            '-hls_time', '6',
            '-hls_list_size', '10',
            '-hls_flags', 'delete_segments+omit_endlist',
            path.join(hlsDir + '_' + v.name, 'index.m3u8')
          ];
          const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
          ffmpeg.on('close', code => {
            if (code !== 0) failed = true;
            done++;
            if (done === variants.length) {
              if (failed) reject(new Error('ffmpeg hls failed'));
              else {
                activeStreams.set(streamId, { torrent, fileIndex, lastUsed: Date.now(), mp4Path, hlsDir, ffmpegProcess: null });
                console.log('stream registered', streamId, file.name, '->', mp4Path, 'и HLS', hlsDir);
                resolve({ streamId, name: file.name });
              }
            }
          });
        });
      });

      // 2. Генеруємо HLS з mp4-файлу для кожної якості
      const variants = [
        { name: '360p', scale: '640:360', bitrate: '800k', audiorate: '96k' },
        { name: '720p', scale: '1280:720', bitrate: '2500k', audiorate: '128k' },
        { name: '1080p', scale: '1920:1080', bitrate: '5000k', audiorate: '192k' }
      ];
      const hlsDirs = variants.map(v => `${hlsDir}_${v.name}`);
      hlsDirs.forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive:true}); });
      // Генеруємо master playlist
      const masterPlaylist = variants.map((v, i) =>
        `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(v.bitrate)*1.5},RESOLUTION=${v.scale.replace(':','x')},NAME="${v.name}"
${v.name}/index.m3u8`
      ).join('\n');
      fs.writeFileSync(path.join(hlsDir, 'index.m3u8'), '#EXTM3U\n' + masterPlaylist);

      await Promise.all(variants.map((v, i) => new Promise((res, rej) => {
        const args = [
          '-hwaccel', 'auto',
          '-i', mp4Path,
          '-vf', `scale=${v.scale}`,
          '-c:v', 'libx264',
          '-b:v', v.bitrate,
          '-preset', 'veryfast',
          '-tune', 'zerolatency',
          '-c:a', 'aac',
          '-b:a', v.audiorate,
          '-f', 'hls',
          '-hls_time', '6',
          '-hls_list_size', '10',
          '-hls_flags', 'delete_segments+omit_endlist',
          path.join(hlsDir + '_' + v.name, 'index.m3u8')
        ];
        const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
        ffmpeg.on('close', code => code === 0 ? res() : rej(new Error('ffmpeg hls failed')));
      })));

      activeStreams.set(streamId, { torrent, fileIndex, lastUsed: Date.now(), mp4Path, hlsDir, ffmpegProcess: null });
      console.log('stream registered', streamId, file.name, '->', mp4Path, 'и HLS', hlsDir);
      resolve({ streamId, name: file.name });
    // Віддача HLS плейліста і сегментів
    const path = require('path');
    // Віддача HLS сегментів для кожної якості
    app.get('/hls/:id/:quality/:file', (req, res) => {
      const id = req.params.id;
      const quality = req.params.quality;
      const entry = Array.from(activeStreams.entries()).find(([k]) => k.startsWith(id));
      if (!entry) return res.status(404).send('Not found');
      const { hlsDir } = entry[1];
      const filePath = path.join(hlsDir + '_' + quality, req.params.file);
      res.sendFile(filePath);
    });
    // Віддача master playlist (adaptive)
    app.get('/hls/:id.m3u8', (req, res) => {
      const id = req.params.id;
      const entry = Array.from(activeStreams.entries()).find(([k]) => k.startsWith(id));
      if (!entry) return res.status(404).send('Not found');
      const { hlsDir } = entry[1];
      const filePath = path.join(hlsDir, 'index.m3u8');
      res.sendFile(filePath);
    });
    });

    torrent.on('error', (err) => {
      console.error('torrent error event', err && err.message);
      reject(err);
    });
  });
}

// Remove uncared-for streams periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of activeStreams.entries()) {
    if (now - s.lastUsed > 1000*60*10) {
      try { s.torrent.destroy(); } catch(e) {}
      activeStreams.delete(id);
    }
  }
}, 1000*60);

// ---- Push to TV feature ----
// Store current URL to play (in-memory, single TV mode)
let currentPlayUrl = null;
let sseClients = [];

// SSE endpoint for TV to listen for new URLs
app.get('/tv/listen', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current URL immediately if exists
  if (currentPlayUrl) {
    res.write(`data: ${JSON.stringify({ url: currentPlayUrl })}\n\n`);
  }

  sseClients.push(res);
  console.log(`TV client connected. Total: ${sseClients.length}`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
    console.log(`TV client disconnected. Total: ${sseClients.length}`);
  });
});

// Endpoint to push URL to all connected TVs
app.post('/tv/push', express.json(), (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  currentPlayUrl = url;
  console.log(`Pushing URL to ${sseClients.length} TV(s): ${url}`);

  // Broadcast to all SSE clients
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify({ url })}\n\n`);
  });

  res.json({ success: true, clients: sseClients.length });
});

// Get current URL (for polling fallback)
app.get('/tv/current', (req, res) => {
  res.json({ url: currentPlayUrl });
});

// Clear current URL
app.post('/tv/clear', (req, res) => {
  currentPlayUrl = null;
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify({ url: null, action: 'clear' })}\n\n`);
  });
  res.json({ success: true });
});

// Create stream from magnet/torrent URL and return a playable mp4 URL
app.post('/api/torrent2mp4', express.json(), async (req, res) => {
  const { url: inputUrl } = req.body || req.query || {};
  console.log('torrent2mp4 called', inputUrl);
  if (!inputUrl) return res.status(400).json({ error: 'Missing url' });

  try {
    let magnet = inputUrl;
    // If it's a .torrent URL, convert to magnet
    if (inputUrl.endsWith('.torrent')) {
      const r = await fetch(`http://localhost:${PORT}/api/torrent2magnet?url=${encodeURIComponent(inputUrl)}`);
      const data = await r.json();
      if (!data.magnet) return res.status(500).json({ error: 'Failed to convert torrent' });
      magnet = data.magnet;
    }

    const { streamId, name } = await addTorrentForStreaming(magnet);
    const streamUrl = `${req.protocol}://${req.get('host')}/torrent-stream/${encodeURIComponent(streamId)}`;
    res.json({ streamUrl, name, streamId });
  } catch (err) {
    console.error('torrent2mp4 error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve stream by streamId using ffmpeg on-the-fly
// const { spawn } = require('child_process');
app.get('/torrent-stream/:id', async (req, res) => {
  const id = req.params.id;
  const entry = activeStreams.get(id);
  if (!entry) return res.status(404).send('Stream not found');

  entry.lastUsed = Date.now();
  const { mp4Path } = entry;
  const fs = require('fs');
  res.setHeader('Content-Type', 'video/mp4');
  // Віддаємо файл по частинах (progressive download)
  const stream = fs.createReadStream(mp4Path);
  stream.pipe(res);
  stream.on('error', err => {
    console.error('Stream file error:', err.message);
    res.status(500).send('Stream error');
  });
  req.on('close', () => {
    stream.destroy();
  });
});


// --- Torrent to mp4 streaming endpoint ---
// Requires: npm install webtorrent express
// const { spawn } = require('child_process');
let activeTorrents = {};

app.post('/api/torrent2mp4', express.json(), async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  // Use a unique id for this torrent (infoHash or url hash)
  const id = require('crypto').createHash('sha1').update(url).digest('hex');
  const port = 9000 + (parseInt(id.slice(0, 4), 16) % 5000); // avoid conflicts

  // If already running, return mp4 url
  if (activeTorrents[id]) {
    return res.json({
      url: `http://${req.hostname}:${port}/stream/0`,
      port
    });
  }

  // Start a new WebTorrent+ffmpeg proxy for this torrent
  const WebTorrent = require('webtorrent');
  const client = new WebTorrent();
  let server;
  let videoFileIdx = 0;

  client.add(url, torrent => {
    // Find first video file (mp4, mkv, avi, webm)
    const video = torrent.files.find(f => /\.(mp4|mkv|avi|webm)$/i.test(f.name));
    if (!video) {
      res.status(404).json({ error: 'No video files in torrent' });
      client.destroy();
      return;
    }
    videoFileIdx = torrent.files.indexOf(video);

    // Start express server for ffmpeg proxy
    const express2 = require('express');
    const app2 = express2();
    app2.get('/stream/:idx', (req2, res2) => {
      const idx = parseInt(req2.params.idx, 10) || 0;
      const file = torrent.files[idx];
      if (!file) return res2.status(404).send('File not found');
      file.getBuffer((err, buffer) => {
        if (err) return res2.status(500).send('Error reading file');
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
        res2.setHeader('Content-Type', 'video/mp4');
        ffmpeg.stdout.pipe(res2);
        ffmpeg.stderr.on('data', d => process.stderr.write(d));
        ffmpeg.on('close', () => res2.end());
      });
    });
    server = app2.listen(port, () => {
      activeTorrents[id] = { client, server, port };
      res.json({
        url: `http://${req.hostname}:${port}/stream/${videoFileIdx}`,
        port
      });
    });
  });

  client.on('error', err => {
    console.error('WebTorrent error:', err.message);
    res.status(500).json({ error: err.message });
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
