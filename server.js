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

function parseInfoHashFromMagnet(magnetURI) {
  try {
    if (!magnetURI || !magnetURI.startsWith('magnet:?')) return null;
    const u = new URL(magnetURI);
    const xt = u.searchParams.get('xt');
    if (!xt) return null;
    const mHex = xt.match(/urn:btih:([a-f0-9]{40})/i);
    if (mHex) return mHex[1].toLowerCase();
    // Not handling base32-encoded magnet in this helper for now
    return null;
  } catch (e) {
    return null;
  }
}

async function startHlsForTorrent(torrent, fileIndex = 0) {
  const client = await ensureWebtorrentClient();
  // If passed an infoHash or magnet, normalize to a Torrent instance
  if (typeof torrent === 'string') {
    const id = torrent;
    const maybe = client.get(id);
    if (!maybe) throw new Error('Torrent not found in client for startHlsForTorrent');
    torrent = maybe;
  }
  console.log('startHlsForTorrent: torrent param type', typeof torrent, 'infoHash', torrent && torrent.infoHash);
  // Wait for torrent metadata if files aren't loaded yet.
  if (!torrent.files || torrent.files.length === 0) {
    // If torrent supports events, prefer 'once' for readiness.
    if (typeof torrent.once === 'function') {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Timed out waiting for torrent metadata')), 15000);
        torrent.once('ready', () => { clearTimeout(t); resolve(); });
        torrent.once('done', () => { clearTimeout(t); resolve(); });
        torrent.once('infoHash', () => { clearTimeout(t); resolve(); });
        if (torrent.files && torrent.files.length > 0) { clearTimeout(t); resolve(); }
      });
    } else {
      // Poll until metadata is available (fallback for odd Torrent-like objects)
      await new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          if (torrent.files && torrent.files.length > 0) return resolve();
          if (Date.now() - start > 15000) return reject(new Error('Timed out waiting for torrent metadata'));
          setTimeout(check, 250);
        };
        check();
      });
    }
  }
  const file = (torrent.files && torrent.files[fileIndex]) || (torrent.files && torrent.files[0]);
  if (!file) {
    console.error('startHlsForTorrent: no file selected; torrent.files=', torrent.files);
    throw new Error('No file found for HLS');
  }
  const streamId = makeStreamId(torrent.infoHash, fileIndex);
  const mp4Path = `/tmp/${streamId}.mp4`;
  const hlsDir = `/tmp/hls_${streamId}`;
  if (activeStreams.has(streamId)) return { streamId, name: file.name };
  // Multi-bitrate HLS variants
  const variants = [
    { name: '720p', scale: '1280:720', bitrate: '1800k' },
    { name: '480p', scale: '854:480', bitrate: '900k' },
    { name: '360p', scale: '640:360', bitrate: '500k' }
  ];
  // Start ffmpeg for each variant
  variants.forEach(v => {
    const dir = `${hlsDir}_${v.name}`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ffargs = [
      '-hwaccel', 'auto',
      '-i', 'pipe:0',
      '-vf', `scale=${v.scale}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-c:a', 'aac',
      '-b:v', v.bitrate,
      '-b:a', '128k',
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments+omit_endlist',
      '-hls_base_url', `/hls/${streamId}_${v.name}/`,
      path.join(dir, 'index.m3u8')
    ];
    const ff = spawn('ffmpeg', ffargs, { stdio: ['pipe', 'ignore', 'inherit'] });
    const srcStream = file.createReadStream();
    srcStream.pipe(ff.stdin);
    ff.on('error', err => console.error('ffmpeg error', err && err.message));
  });
  // Generate master playlist
  if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir, { recursive: true });
  const masterPlaylist = variants.map(v =>
    `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(v.bitrate)*1.5},RESOLUTION=${v.scale.replace(':','x')},NAME="${v.name}"
/hls/${streamId}_${v.name}/index.m3u8`
  ).join('\n');
  fs.writeFileSync(path.join(hlsDir, 'index.m3u8'), '#EXTM3U\n' + masterPlaylist);
  activeStreams.set(streamId, { torrent, fileIndex, lastUsed: Date.now(), mp4Path, hlsDir, ffmpegProcess: null, name: file.name });
  console.log('Multi-bitrate HLS started for', streamId, file.name, '->', hlsDir);
  return { streamId, name: file.name };
}

async function addTorrentForStreaming(magnetURI, opts = {}) {
  console.log('addTorrentForStreaming called', magnetURI);
  const client = await ensureWebtorrentClient();
  return new Promise(async (resolve, reject) => {
    try {
      const fileIndex = (typeof opts.fileIndex === 'number') ? opts.fileIndex : 0;
      const infoHash = parseInfoHashFromMagnet(magnetURI);
      if (infoHash) {
        const streamId = makeStreamId(infoHash, fileIndex);
        if (activeStreams.has(streamId)) {
          const existing = activeStreams.get(streamId);
          existing.lastUsed = Date.now();
          return resolve({ streamId, name: existing.name });
        }
        const existingTorrent = client.get(infoHash);
        if (existingTorrent) {
          // start hls for this existing torrent and return
              try {
                const r = await startHlsForTorrent(existingTorrent, fileIndex);
                return resolve(r);
              } catch (err) {
                console.error('startHlsForTorrent(existingTorrent) failed:', err && err.message);
                // If failed, attempt to return active stream if available
                const sid = makeStreamId(existingTorrent.infoHash, fileIndex);
                if (activeStreams.has(sid)) return resolve({ streamId: sid, name: activeStreams.get(sid).name });
                return reject(err);
              }
        }
      }

      // Add new torrent if nothing found
      const torrent = client.add(magnetURI, { path: opts.path || 'downloads' }, async () => {
        try {
          console.log('torrent metadata ready', torrent.infoHash);
          const idx = torrent.files.findIndex(f => {
            const l = f.name.toLowerCase();
            return l.endsWith('.mp4') || l.endsWith('.webm') || l.endsWith('.avi') || l.endsWith('.mkv');
          });
          const realFileIndex = idx >= 0 ? idx : 0;
              try {
                const r = await startHlsForTorrent(torrent, realFileIndex);
                return resolve(r);
              } catch (err) {
                console.error('startHlsForTorrent failed, attempting fallback:', err && err.message);
                // Fallback: look for existing active stream
                const id = torrent.infoHash ? makeStreamId(torrent.infoHash, realFileIndex) : null;
                if (id && activeStreams.has(id)) {
                  const existing = activeStreams.get(id);
                  return resolve({ streamId: id, name: existing.name });
                }
                return reject(err);
              }
        } catch (err) {
          reject(err);
        }
      });
      torrent.on('error', (err) => {
        console.error('torrent error event', err && err.message);
        // If duplicate add occurs, just attempt to return the existing stream
        if (err && String(err).includes('Cannot add duplicate torrent')) {
          const infoHash = torrent.infoHash || parseInfoHashFromMagnet(magnetURI);
          if (infoHash) {
            const streamId = makeStreamId(infoHash, fileIndex);
            const existing = activeStreams.get(streamId);
            if (existing) return resolve({ streamId, name: existing.name });
          }
        }
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

// Remove uncared-for streams periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of activeStreams.entries()) {
    if (now - s.lastUsed > 1000*60*10) {
      try { s.torrent.destroy(); } catch(e) {}
      if (s.ffmpegProcess) {
        try {
          if (Array.isArray(s.ffmpegProcess)) {
            s.ffmpegProcess.forEach(p => { try { p.kill('SIGTERM'); } catch(e){} });
          } else {
            try { s.ffmpegProcess.kill('SIGTERM'); } catch(e){}
          }
        } catch(e) {}
      }
      activeStreams.delete(id);
    }
  }
}, 1000*60);

// On startup, scan /tmp for any existing HLS dirs and register them as passive streams
function scanExistingHlsStreams() {
  try {
    const tmpList = fs.readdirSync('/tmp');
    tmpList.forEach((entry) => {
      if (!entry.startsWith('hls_')) return;
      const streamId = entry.slice('hls_'.length);
      const hlsDir = path.join('/tmp', entry);
      if (!fs.existsSync(path.join(hlsDir, 'index.m3u8'))) return;
      if (!activeStreams.has(streamId)) {
        const parts = streamId.split(':');
        const fileIndex = parts.length > 1 ? parseInt(parts[1], 10) : 0;
        activeStreams.set(streamId, { torrent: null, fileIndex, lastUsed: Date.now(), mp4Path: `/tmp/${streamId}.mp4`, hlsDir, ffmpegProcess: null, name: entry });
        console.log('Registered existing HLS stream from disk:', streamId, '->', hlsDir);
      }
    });
  } catch (err) {
    console.error('scanExistingHlsStreams error', err && err.message);
  }
}

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

// Expose TV clients count for the control UI
app.get('/tv/clients', (req, res) => {
  res.json({ clients: sseClients.length });
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
    const streamUrl = `${req.protocol}://${req.get('host')}/hls/${encodeURIComponent(streamId)}.m3u8`;
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
  const { mp4Path, hlsDir } = entry;
  const fs = require('fs');
  // Prefer HLS streaming - redirect to playlist if available
  if (hlsDir && fs.existsSync(path.join(hlsDir, 'index.m3u8'))) {
    return res.redirect(`/hls/${encodeURIComponent(id)}.m3u8`);
  }
  if (!mp4Path || !fs.existsSync(mp4Path)) return res.status(404).send('Stream not ready');
  res.setHeader('Content-Type', 'video/mp4');
  // Progressive mp4 fallback
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

// Debug: list active stream ids
app.get('/debug/streams', (req, res) => {
  res.json({ streams: Array.from(activeStreams.keys()) });
});

// Debug: echo hls id/file and compute entry
app.get('/debug/hls/:id/:file', (req, res) => {
  const id = req.params.id;
  const file = req.params.file;
  const keys = Array.from(activeStreams.keys());
  const entry = keys.find(k => k.startsWith(id));
  const exists = !!entry;
  const hlsDir = exists ? activeStreams.get(entry).hlsDir : undefined;
  const filePath = exists ? path.join(hlsDir, file) : null;
  const fileExists = filePath ? fs.existsSync(filePath) : false;
  res.json({ id, file, keys, entry, filePath, fileExists, exists });
});

// Serve HLS segments and master playlists for active streams
app.get('/hls/:id/:file', (req, res) => {
  const id = req.params.id;
  const entry = Array.from(activeStreams.entries()).find(([k]) => k.startsWith(id));
  if (!entry) return res.status(404).send('Not found');
  const { hlsDir } = entry[1];
  let filePath = path.join(hlsDir, req.params.file);
  if (!fs.existsSync(filePath)) {
    // Fallback: шукаємо у варіантах якості
    const qualities = ['720p', '480p', '360p'];
    for (const q of qualities) {
      const altPath = path.join(hlsDir + '_' + q, req.params.file);
      if (fs.existsSync(altPath)) {
        filePath = altPath;
        break;
      }
    }
  }
  if (!fs.existsSync(filePath)) return res.status(404).send('Segment not found');
  res.sendFile(filePath);
});
app.get('/hls/:id/:quality/:file', (req, res) => {
  const id = req.params.id;
  const quality = req.params.quality;
  const entry = Array.from(activeStreams.entries()).find(([k]) => k.startsWith(id));
  if (!entry) return res.status(404).send('Not found');
  const { hlsDir } = entry[1];
  const filePath = path.join(hlsDir + '_' + quality, req.params.file);
  res.sendFile(filePath);
});
// Master adaptive playlist
app.get('/hls/:id.m3u8', (req, res) => {
  const id = req.params.id;
  const entry = Array.from(activeStreams.entries()).find(([k]) => k.startsWith(id));
  if (!entry) return res.status(404).send('Not found');
  const { hlsDir } = entry[1];
  const filePath = path.join(hlsDir, 'index.m3u8');
  res.sendFile(filePath);
});


// --- Torrent to mp4 streaming endpoint ---
// (Deprecated duplicate block removed: streaming served via HLS endpoint above)

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  // Scan for any leftover HLS directories from previous runs
  scanExistingHlsStreams();
});
