const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const url = require("url");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const torrentStream = require("torrent-stream");

// yt-dlp path detection
const YTDLP_PATH = (() => {
  try {
    return execSync("which yt-dlp 2>/dev/null || echo ~/.local/bin/yt-dlp")
      .toString()
      .trim();
  } catch {
    return "yt-dlp";
  }
})();

const app = express();
const PORT = process.env.PORT || 8081;
const HOST = process.env.HOST || "0.0.0.0";

app.use(cors());
app.use(express.static("public"));
app.use(
  morgan(
    ":remote-addr :method :url :status :res[content-length] - :response-time ms",
  ),
);

// Simple route to open player with a url param
app.get("/play", (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");
  // Prevent open redirect abuse? Basic check
  res.redirect(`/player.html?url=${encodeURIComponent(target)}`);
});

// Proxy streaming route with Range support
app.get("/proxy", (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");

  let parsed;
  try {
    parsed = new URL(target);
  } catch (err) {
    return res.status(400).send("Invalid URL");
  }

  const options = {
    method: "GET",
    headers: {},
  };

  // Forward range header for seeking
  if (req.headers.range) options.headers.range = req.headers.range;

  const protocol = parsed.protocol === "https:" ? https : http;

  const proxyReq = protocol.request(parsed, options, (proxyRes) => {
    // Set headers
    const allowedHeaders = [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
    ];
    allowedHeaders.forEach((h) => {
      const v = proxyRes.headers[h];
      if (v) res.setHeader(h, v);
    });

    res.statusCode = proxyRes.statusCode;
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy request error", err.message);
    res.status(502).send("Bad gateway");
  });

  proxyReq.end();
});

// Add a small JSON endpoint to generate share links
app.get("/api/share", (req, res) => {
  const urlParam = req.query.url;
  if (!urlParam) return res.status(400).json({ error: "Missing url" });
  const encoded = encodeURIComponent(urlParam);
  const host = req.get("host");
  const link = `${req.protocol}://${host}/player.html?url=${encoded}`;
  res.json({ link });
});

// Diagnostic endpoint - returns requester IP
app.get("/whoami", (req, res) => {
  res.json({ ip: req.ip || req.connection.remoteAddress });
});

// ---- yt-dlp integration ----
// Extract direct video URL from any supported site (YouTube, TikTok, Twitter, etc.)
const ytdlpCache = new Map(); // url -> { directUrl, title, expires }

app.get("/api/extract", async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) return res.status(400).json({ error: "Missing url" });

  // Check cache (5 min TTL)
  const cached = ytdlpCache.get(inputUrl);
  if (cached && cached.expires > Date.now()) {
    return res.json(cached.data);
  }

  try {
    const result = await extractWithYtdlp(inputUrl);
    ytdlpCache.set(inputUrl, {
      data: result,
      expires: Date.now() + 5 * 60 * 1000,
    });
    res.json(result);
  } catch (err) {
    console.error("yt-dlp error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stream video through yt-dlp (for sites that need cookies/auth)
app.get("/api/stream", async (req, res) => {
  const inputUrl = req.query.url;
  const format = req.query.format || "best[height<=1080]";
  if (!inputUrl) return res.status(400).json({ error: "Missing url" });

  try {
    // Use yt-dlp to pipe video directly
    const args = [
      "-f",
      format,
      "-o",
      "-", // output to stdout
      "--no-warnings",
      "--no-playlist",
      inputUrl,
    ];

    const proc = spawn(YTDLP_PATH, args);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Transfer-Encoding", "chunked");

    proc.stdout.pipe(res);

    proc.stderr.on("data", (d) =>
      console.error("yt-dlp stderr:", d.toString()),
    );
    proc.on("error", (err) => {
      console.error("yt-dlp spawn error:", err);
      if (!res.headersSent) res.status(500).send("Stream error");
    });

    req.on("close", () => proc.kill("SIGTERM"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create HLS stream from any URL via yt-dlp + ffmpeg
app.post("/api/url2hls", express.json(), async (req, res) => {
  const { url: inputUrl } = req.body;
  if (!inputUrl) return res.status(400).json({ error: "Missing url" });

  try {
    // Generate stream ID from URL hash
    const streamId =
      "yt_" +
      crypto.createHash("md5").update(inputUrl).digest("hex").slice(0, 12);
    const hlsDir = `/tmp/hls_${streamId}`;

    // Check if already streaming
    if (activeStreams.has(streamId)) {
      const existing = activeStreams.get(streamId);
      existing.lastUsed = Date.now();
      return res.json({
        streamId,
        name: existing.name,
        streamUrl: `/hls/${streamId}.m3u8`,
      });
    }

    // Get video info first
    let info;
    try {
      info = await extractWithYtdlp(inputUrl);
    } catch (e) {
      // yt-dlp can't extract - return original URL for direct playback on TV
      console.log("yt-dlp extraction failed, using direct URL:", e.message);
      return res.json({ streamUrl: inputUrl, name: "Video", direct: true });
    }

    // Check if yt-dlp can actually stream this (not just metadata)
    // If formats is empty or url equals webpage_url, it's not a real video extraction
    const hasRealVideo =
      info.formats && info.formats.length > 0 && info.url !== info.webpage_url;
    if (!hasRealVideo) {
      console.log(
        "No streamable format found, using direct URL for:",
        inputUrl,
      );
      return res.json({
        streamUrl: inputUrl,
        name: info.title || "Video",
        direct: true,
      });
    }

    // Create HLS directory
    ensureDir(hlsDir);

    // Start yt-dlp | ffmpeg pipeline
    const ytdlp = spawn(YTDLP_PATH, [
      "-f",
      "best[height<=1080]/best",
      "-o",
      "-",
      "--no-warnings",
      "--no-playlist",
      inputUrl,
    ]);

    const ffmpegArgs = buildHlsArgs(
      path.join(hlsDir, "index.m3u8"),
      `/hls/${streamId}/`,
    );
    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "ignore", "inherit"],
    });

    ytdlp.stdout.pipe(ffmpeg.stdin);

    ytdlp.stderr.on("data", (d) => console.log("yt-dlp:", d.toString().trim()));
    ytdlp.on("error", (err) => console.error("yt-dlp error:", err));
    ffmpeg.on("error", (err) => console.error("ffmpeg error:", err));

    // Register stream
    activeStreams.set(streamId, {
      torrent: null,
      fileIndex: 0,
      lastUsed: Date.now(),
      mp4Path: null,
      hlsDir,
      ffmpegProcess: [ytdlp, ffmpeg],
      name: info.title || "Video",
    });

    console.log("HLS stream started:", streamId, info.title);
    res.json({
      streamId,
      name: info.title,
      streamUrl: `/hls/${streamId}.m3u8`,
    });
  } catch (err) {
    console.error("url2hls error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

function extractWithYtdlp(url) {
  return new Promise((resolve, reject) => {
    const args = [
      "-j", // JSON output
      "--no-warnings",
      "--no-playlist",
      "--flat-playlist",
      url,
    ];

    const proc = spawn(YTDLP_PATH, args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(stderr || "yt-dlp failed"));
      }
      try {
        const info = JSON.parse(stdout);
        resolve({
          title: info.title || info.fulltitle || "Video",
          duration: info.duration,
          thumbnail: info.thumbnail,
          url: info.url, // direct URL (may expire)
          formats: (info.formats || []).slice(-5).map((f) => ({
            format_id: f.format_id,
            ext: f.ext,
            resolution: f.resolution || `${f.width}x${f.height}`,
            filesize: f.filesize,
          })),
          extractor: info.extractor,
          webpage_url: info.webpage_url,
        });
      } catch (e) {
        reject(new Error("Failed to parse yt-dlp output"));
      }
    });

    proc.on("error", reject);
  });
}

// Detect URL type for smart UI hints
app.get("/api/detect", async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) return res.status(400).json({ error: "Missing url" });

  const lower = inputUrl.toLowerCase();

  // Quick pattern detection
  if (inputUrl.startsWith("magnet:")) {
    return res.json({
      type: "torrent",
      method: "webtorrent",
      icon: "download",
    });
  }
  if (lower.endsWith(".torrent")) {
    return res.json({
      type: "torrent",
      method: "webtorrent",
      icon: "download",
    });
  }
  if (
    lower.endsWith(".mp4") ||
    lower.endsWith(".webm") ||
    lower.endsWith(".mov")
  ) {
    return res.json({ type: "video", method: "direct", icon: "play" });
  }
  if (lower.endsWith(".m3u8")) {
    return res.json({ type: "stream", method: "hls", icon: "radio" });
  }
  if (/youtube\.com|youtu\.be/.test(lower)) {
    return res.json({
      type: "youtube",
      method: "yt-dlp",
      icon: "youtube",
      site: "YouTube",
    });
  }
  if (/tiktok\.com/.test(lower)) {
    return res.json({
      type: "video",
      method: "yt-dlp",
      icon: "video",
      site: "TikTok",
    });
  }
  if (/twitter\.com|x\.com/.test(lower)) {
    return res.json({
      type: "video",
      method: "yt-dlp",
      icon: "video",
      site: "Twitter/X",
    });
  }
  if (/vimeo\.com/.test(lower)) {
    return res.json({
      type: "video",
      method: "yt-dlp",
      icon: "video",
      site: "Vimeo",
    });
  }
  if (/twitch\.tv/.test(lower)) {
    return res.json({
      type: "stream",
      method: "yt-dlp",
      icon: "tv",
      site: "Twitch",
    });
  }
  if (/instagram\.com/.test(lower)) {
    return res.json({
      type: "video",
      method: "yt-dlp",
      icon: "video",
      site: "Instagram",
    });
  }
  if (/facebook\.com|fb\.watch/.test(lower)) {
    return res.json({
      type: "video",
      method: "yt-dlp",
      icon: "video",
      site: "Facebook",
    });
  }
  if (/reddit\.com/.test(lower)) {
    return res.json({
      type: "video",
      method: "yt-dlp",
      icon: "video",
      site: "Reddit",
    });
  }

  // Try yt-dlp detection for unknown URLs
  try {
    const info = await extractWithYtdlp(inputUrl);
    return res.json({
      type: "video",
      method: "yt-dlp",
      icon: "video",
      site: info.extractor,
      title: info.title,
    });
  } catch {
    // Fallback: treat as website
    return res.json({ type: "website", method: "iframe", icon: "globe" });
  }
});

// Convert .torrent URL to magnet link
app.get("/api/torrent2magnet", async (req, res) => {
  const torrentUrl = req.query.url;
  if (!torrentUrl) return res.status(400).json({ error: "Missing url" });

  try {
    // Dynamic import for ESM module
    const bencodeModule = await import("bencode");
    const { decode, encode } = bencodeModule.default;

    // Fetch the .torrent file
    const response = await fetch(torrentUrl);
    if (!response.ok) throw new Error("Failed to fetch torrent file");

    const buffer = Buffer.from(await response.arrayBuffer());
    const torrent = decode(buffer);

    // Calculate info hash
    const infoBuffer = encode(torrent.info);
    const infoHash = crypto.createHash("sha1").update(infoBuffer).digest("hex");

    // Helper to convert any buffer-like to string
    const toStr = (val) => {
      if (!val) return "";
      if (typeof val === "string") return val;
      if (Buffer.isBuffer(val)) return val.toString("utf8");
      if (val instanceof Uint8Array) return Buffer.from(val).toString("utf8");
      return String(val);
    };

    // Get torrent name
    const name = toStr(torrent.info.name) || "Unknown";

    // Build magnet URI
    const trackers = [];
    if (torrent["announce-list"]) {
      torrent["announce-list"].forEach((tier) => {
        tier.forEach((t) => trackers.push(toStr(t)));
      });
    } else if (torrent.announce) {
      trackers.push(toStr(torrent.announce));
    }

    let magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
    trackers.forEach((tr) => {
      magnet += `&tr=${encodeURIComponent(tr)}`;
    });

    res.json({
      magnet,
      name,
      infoHash,
    });
  } catch (err) {
    console.error("Torrent parse error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Streaming helpers ----
let webtorrentClient = null;
const activeStreams = new Map(); // streamId -> { torrent, fileIndex, lastUsed, mp4Path, ffmpegProcess }

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function buildHlsArgs(outputPath, baseUrl) {
  const args = [
    "-hwaccel",
    "auto",
    "-fflags",
    "+genpts",
    "-i",
    "pipe:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-ar",
    "44100",
    "-max_muxing_queue_size",
    "1024",
    "-f",
    "hls",
    "-hls_time",
    "4",
    "-hls_list_size",
    "10",
    "-hls_flags",
    "delete_segments+omit_endlist",
  ];
  if (baseUrl) {
    args.push("-hls_base_url", baseUrl);
  }
  args.push(outputPath);
  return args;
}

async function ensureWebtorrentClient() {
  if (webtorrentClient) return webtorrentClient;
  const mod = await import("webtorrent");
  const WebTorrent = mod.default || mod;
  webtorrentClient = new WebTorrent();
  return webtorrentClient;
}

function makeStreamId(infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`;
}

function parseInfoHashFromMagnet(magnetURI) {
  try {
    if (!magnetURI || !magnetURI.startsWith("magnet:?")) return null;
    const u = new URL(magnetURI);
    const xt = u.searchParams.get("xt");
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
  if (typeof torrent === "string") {
    const id = torrent;
    const maybe = client.get(id);
    if (!maybe)
      throw new Error("Torrent not found in client for startHlsForTorrent");
    torrent = maybe;
  }
  // Додаткове логування
  console.log(
    "startHlsForTorrent: torrent param type",
    typeof torrent,
    "infoHash",
    torrent && torrent.infoHash,
    "keys:",
    Object.keys(torrent || {}),
  );
  // Очікуємо metadata
  let waited = 0;
  while (
    (!torrent.infoHash || !torrent.files || torrent.files.length === 0) &&
    waited < 15000
  ) {
    await new Promise((r) => setTimeout(r, 250));
    waited += 250;
  }
  if (!torrent.infoHash)
    throw new Error("Torrent infoHash is undefined after waiting");
  if (!torrent.files || torrent.files.length === 0)
    throw new Error("Torrent files not loaded after waiting");
  const file =
    (torrent.files && torrent.files[fileIndex]) ||
    (torrent.files && torrent.files[0]);
  if (!file) {
    console.error(
      "startHlsForTorrent: no file selected; torrent.files=",
      torrent.files,
    );
    throw new Error("No file found for HLS");
  }
  const streamId = makeStreamId(torrent.infoHash, fileIndex);
  const mp4Path = `/tmp/${streamId}.mp4`;
  const hlsDir = `/tmp/hls_${streamId}`;
  if (activeStreams.has(streamId)) return { streamId, name: file.name };
  ensureDir(hlsDir);
  if (typeof file.select === "function") {
    try {
      file.select();
    } catch (err) {
      console.warn("File select failed", err && err.message);
    }
  }
  const ffmpegArgs = buildHlsArgs(
    path.join(hlsDir, "index.m3u8"),
    `/hls/${streamId}/`,
  );
  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["pipe", "ignore", "inherit"],
  });
  const srcStream = file.createReadStream();
  srcStream.pipe(ffmpeg.stdin);
  srcStream.on("error", (err) => {
    console.error("Torrent read error", err && err.message);
    try {
      ffmpeg.kill("SIGTERM");
    } catch (e) {}
  });
  ffmpeg.on("error", (err) =>
    console.error("ffmpeg error", err && err.message),
  );
  activeStreams.set(streamId, {
    torrent,
    fileIndex,
    lastUsed: Date.now(),
    mp4Path,
    hlsDir,
    ffmpegProcess: ffmpeg,
    name: file.name,
  });
  console.log("HLS started for", streamId, file.name, "->", hlsDir);
  return { streamId, name: file.name };
}

async function addTorrentForStreaming(magnetURI, opts = {}) {
  console.log("addTorrentForStreaming called", magnetURI);
  const client = await ensureWebtorrentClient();
  return new Promise(async (resolve, reject) => {
    try {
      const fileIndex = typeof opts.fileIndex === "number" ? opts.fileIndex : 0;
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
            console.error(
              "startHlsForTorrent(existingTorrent) failed:",
              err && err.message,
            );
            // If failed, attempt to return active stream if available
            const sid = makeStreamId(existingTorrent.infoHash, fileIndex);
            if (activeStreams.has(sid))
              return resolve({
                streamId: sid,
                name: activeStreams.get(sid).name,
              });
            return reject(err);
          }
        }
      }

      // Add new torrent if nothing found
      const torrent = client.add(
        magnetURI,
        { path: opts.path || "downloads" },
        async () => {
          try {
            console.log("torrent metadata ready", torrent.infoHash);
            const idx = torrent.files.findIndex((f) => {
              const l = f.name.toLowerCase();
              return (
                l.endsWith(".mp4") ||
                l.endsWith(".webm") ||
                l.endsWith(".avi") ||
                l.endsWith(".mkv")
              );
            });
            const realFileIndex = idx >= 0 ? idx : 0;
            try {
              const r = await startHlsForTorrent(torrent, realFileIndex);
              return resolve(r);
            } catch (err) {
              console.error(
                "startHlsForTorrent failed, attempting fallback:",
                err && err.message,
              );
              // Fallback: look for existing active stream
              const id = torrent.infoHash
                ? makeStreamId(torrent.infoHash, realFileIndex)
                : null;
              if (id && activeStreams.has(id)) {
                const existing = activeStreams.get(id);
                return resolve({ streamId: id, name: existing.name });
              }
              return reject(err);
            }
          } catch (err) {
            reject(err);
          }
        },
      );
      torrent.on("error", (err) => {
        console.error("torrent error event", err && err.message);
        // If duplicate add occurs, just attempt to return the existing stream
        if (err && String(err).includes("Cannot add duplicate torrent")) {
          const infoHash =
            torrent.infoHash || parseInfoHashFromMagnet(magnetURI);
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
    if (now - s.lastUsed > 1000 * 60 * 10) {
      try {
        s.torrent.destroy();
      } catch (e) {}
      if (s.ffmpegProcess) {
        try {
          if (Array.isArray(s.ffmpegProcess)) {
            s.ffmpegProcess.forEach((p) => {
              try {
                p.kill("SIGTERM");
              } catch (e) {}
            });
          } else {
            try {
              s.ffmpegProcess.kill("SIGTERM");
            } catch (e) {}
          }
        } catch (e) {}
      }
      activeStreams.delete(id);
    }
  }
}, 1000 * 60);

// On startup, scan /tmp for any existing HLS dirs and register them as passive streams
function scanExistingHlsStreams() {
  try {
    const tmpList = fs.readdirSync("/tmp");
    tmpList.forEach((entry) => {
      if (!entry.startsWith("hls_")) return;
      const streamId = entry.slice("hls_".length);
      const hlsDir = path.join("/tmp", entry);
      if (!fs.existsSync(path.join(hlsDir, "index.m3u8"))) return;
      if (!activeStreams.has(streamId)) {
        const parts = streamId.split(":");
        const fileIndex = parts.length > 1 ? parseInt(parts[1], 10) : 0;
        activeStreams.set(streamId, {
          torrent: null,
          fileIndex,
          lastUsed: Date.now(),
          mp4Path: `/tmp/${streamId}.mp4`,
          hlsDir,
          ffmpegProcess: null,
          name: entry,
        });
        console.log(
          "Registered existing HLS stream from disk:",
          streamId,
          "->",
          hlsDir,
        );
      }
    });
  } catch (err) {
    console.error("scanExistingHlsStreams error", err && err.message);
  }
}

// ---- Push to TV feature ----
// Store current URL to play (in-memory, single TV mode)
let currentPlayUrl = null;
let sseClients = [];

// SSE endpoint for TV to listen for new URLs
app.get("/tv/listen", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current URL immediately if exists
  if (currentPlayUrl) {
    res.write(`data: ${JSON.stringify({ url: currentPlayUrl })}\n\n`);
  }

  sseClients.push(res);
  console.log(`TV client connected. Total: ${sseClients.length}`);

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
    console.log(`TV client disconnected. Total: ${sseClients.length}`);
  });
});

// Expose TV clients count for the control UI
app.get("/tv/clients", (req, res) => {
  res.json({ clients: sseClients.length });
});

// Endpoint to push URL to all connected TVs
app.post("/tv/push", express.json(), (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });

  currentPlayUrl = url;
  console.log(`Pushing URL to ${sseClients.length} TV(s): ${url}`);

  // Broadcast to all SSE clients
  sseClients.forEach((client) => {
    client.write(`data: ${JSON.stringify({ url })}\n\n`);
  });

  res.json({ success: true, clients: sseClients.length });
});

// Get current URL (for polling fallback)
app.get("/tv/current", (req, res) => {
  res.json({ url: currentPlayUrl });
});

// Clear current URL
app.post("/tv/clear", (req, res) => {
  currentPlayUrl = null;
  sseClients.forEach((client) => {
    client.write(`data: ${JSON.stringify({ url: null, action: "clear" })}\n\n`);
  });
  res.json({ success: true });
});

// Create stream from magnet/torrent URL and return a playable mp4 URL
// Torrent engines cache (torrent-stream based, works with regular BitTorrent peers)
const torrentEngines = new Map(); // infoHash -> engine

app.post("/api/torrent2mp4", express.json(), async (req, res) => {
  const { url: inputUrl } = req.body || req.query || {};
  console.log("torrent2mp4 called", inputUrl);
  if (!inputUrl) return res.status(400).json({ error: "Missing url" });

  try {
    let magnet = inputUrl;
    let torrentBuffer = null;

    // If it's a .torrent URL, download it
    if (inputUrl.toLowerCase().endsWith(".torrent")) {
      const r = await fetch(inputUrl);
      if (!r.ok) throw new Error("Failed to download torrent file");
      torrentBuffer = Buffer.from(await r.arrayBuffer());

      // Also get magnet for caching purposes
      const magnetRes = await fetch(
        `http://localhost:${PORT}/api/torrent2magnet?url=${encodeURIComponent(inputUrl)}`,
      );
      const magnetData = await magnetRes.json();
      if (magnetData.magnet) magnet = magnetData.magnet;
    }

    // Use torrent-stream for real BitTorrent DHT/peers
    const engine = await new Promise((resolve, reject) => {
      const opts = {
        path: path.join(__dirname, "downloads"),
        trackers: [
          "udp://tracker.opentrackr.org:1337/announce",
          "udp://open.stealth.si:80/announce",
          "udp://tracker.torrent.eu.org:451/announce",
          "udp://tracker.bittor.pw:1337/announce",
          "udp://public.popcorn-tracker.org:6969/announce",
          "udp://tracker.dler.org:6969/announce",
          "udp://exodus.desync.com:6969",
          "udp://open.demonii.com:1337/announce",
        ],
      };

      const e = torrentStream(torrentBuffer || magnet, opts);
      const timeout = setTimeout(() => {
        e.destroy();
        reject(new Error("Torrent timeout (60s) - no peers found"));
      }, 60000);

      e.on("ready", () => {
        clearTimeout(timeout);
        console.log(
          "Torrent ready:",
          e.torrent.name,
          "- files:",
          e.files.length,
        );
        resolve(e);
      });

      e.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Find video files
    const videoFiles = engine.files
      .filter((f) => /\.(mp4|webm|avi|mkv)$/i.test(f.name))
      .map((f, idx) => ({
        name: f.name,
        length: f.length,
        index: engine.files.indexOf(f),
        path: f.path,
      }));

    if (videoFiles.length === 0) {
      engine.destroy();
      throw new Error("No video files found in torrent");
    }

    // Select file
    const fileIndex =
      typeof req.body.fileIndex === "number"
        ? req.body.fileIndex
        : videoFiles[0].index;

    const selectedFile = engine.files[fileIndex];
    if (!selectedFile) {
      engine.destroy();
      throw new Error("Invalid file index");
    }

    // Create stream ID
    const streamId = `ts_${engine.infoHash}_${fileIndex}`;
    const hlsDir = `/tmp/hls_${streamId}`;

    // Check if already streaming
    if (activeStreams.has(streamId)) {
      engine.destroy(); // Don't need duplicate engine
      const existing = activeStreams.get(streamId);
      existing.lastUsed = Date.now();
      return res.json({
        streamId,
        name: existing.name,
        streamUrl: `/hls/${streamId}.m3u8`,
        videoFiles,
      });
    }

    // Create HLS directory
    ensureDir(hlsDir);

    // Start streaming: torrent-stream -> ffmpeg -> HLS
    selectedFile.select(); // Prioritize this file
    const fileStream = selectedFile.createReadStream();

    const ffmpegArgs = buildHlsArgs(
      path.join(hlsDir, "index.m3u8"),
      `/hls/${streamId}/`,
    );
    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    fileStream.pipe(ffmpeg.stdin);
    fileStream.on("error", (err) => {
      console.error("Torrent file stream error", err && err.message);
      try {
        ffmpeg.kill("SIGTERM");
      } catch (e) {}
    });

    ffmpeg.stderr.on("data", (d) => {
      const msg = d.toString();
      if (msg.includes("Error") || msg.includes("error")) {
        console.error("ffmpeg:", msg.trim());
      }
    });

    // Store engine and stream info
    torrentEngines.set(engine.infoHash, engine);
    activeStreams.set(streamId, {
      torrent: null,
      engine,
      fileIndex,
      lastUsed: Date.now(),
      mp4Path: null,
      hlsDir,
      ffmpegProcess: ffmpeg,
      name: selectedFile.name,
    });

    console.log("Torrent HLS stream started:", streamId, selectedFile.name);

    res.json({
      streamId,
      name: selectedFile.name,
      streamUrl: `/hls/${streamId}.m3u8`,
      videoFiles,
    });
  } catch (err) {
    console.error("torrent2mp4 error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve stream by streamId using ffmpeg on-the-fly
// const { spawn } = require('child_process');
app.get("/torrent-stream/:id", async (req, res) => {
  const id = req.params.id;
  const entry = activeStreams.get(id);
  if (!entry) return res.status(404).send("Stream not found");

  entry.lastUsed = Date.now();
  const { mp4Path, hlsDir } = entry;
  const fs = require("fs");
  // Prefer HLS streaming - redirect to playlist if available
  if (hlsDir && fs.existsSync(path.join(hlsDir, "index.m3u8"))) {
    return res.redirect(`/hls/${encodeURIComponent(id)}.m3u8`);
  }
  if (!mp4Path || !fs.existsSync(mp4Path))
    return res.status(404).send("Stream not ready");
  res.setHeader("Content-Type", "video/mp4");
  // Progressive mp4 fallback
  const stream = fs.createReadStream(mp4Path);
  stream.pipe(res);
  stream.on("error", (err) => {
    console.error("Stream file error:", err.message);
    res.status(500).send("Stream error");
  });
  req.on("close", () => {
    stream.destroy();
  });
});

// Debug: list active stream ids
app.get("/debug/streams", (req, res) => {
  res.json({ streams: Array.from(activeStreams.keys()) });
});

// Debug: echo hls id/file and compute entry
app.get("/debug/hls/:id/:file", (req, res) => {
  const id = req.params.id;
  const file = req.params.file;
  const keys = Array.from(activeStreams.keys());
  const entry = keys.find((k) => k.startsWith(id));
  const exists = !!entry;
  const hlsDir = exists ? activeStreams.get(entry).hlsDir : undefined;
  const filePath = exists ? path.join(hlsDir, file) : null;
  const fileExists = filePath ? fs.existsSync(filePath) : false;
  res.json({ id, file, keys, entry, filePath, fileExists, exists });
});

// Serve HLS segments and master playlists for active streams
// Direct segment access (when playlist has relative paths)
app.get("/hls/:file(index\\d+\\.ts)", (req, res) => {
  const file = req.params.file;
  // Find any active stream that has this segment
  for (const [streamId, entry] of activeStreams.entries()) {
    const filePath = path.join(entry.hlsDir, file);
    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath);
    }
  }
  res.status(404).send("Segment not found");
});

app.get("/hls/:id/:file", (req, res) => {
  const id = req.params.id;
  const entry = Array.from(activeStreams.entries()).find(([k]) =>
    k.startsWith(id),
  );
  if (!entry) return res.status(404).send("Not found");
  const { hlsDir } = entry[1];
  let filePath = path.join(hlsDir, req.params.file);
  if (!fs.existsSync(filePath)) {
    // Fallback: шукаємо у варіантах якості
    const qualities = ["720p", "480p", "360p"];
    for (const q of qualities) {
      const altPath = path.join(hlsDir + "_" + q, req.params.file);
      if (fs.existsSync(altPath)) {
        filePath = altPath;
        break;
      }
    }
  }
  if (!fs.existsSync(filePath))
    return res.status(404).send("Segment not found");
  res.sendFile(filePath);
});
app.get("/hls/:id/:quality/:file", (req, res) => {
  const id = req.params.id;
  const quality = req.params.quality;
  const entry = Array.from(activeStreams.entries()).find(([k]) =>
    k.startsWith(id),
  );
  if (!entry) return res.status(404).send("Not found");
  const { hlsDir } = entry[1];
  const filePath = path.join(hlsDir + "_" + quality, req.params.file);
  res.sendFile(filePath);
});
// Master adaptive playlist
app.get("/hls/:id.m3u8", (req, res) => {
  const id = req.params.id;
  const entry = Array.from(activeStreams.entries()).find(([k]) =>
    k.startsWith(id),
  );
  if (!entry) return res.status(404).send("Not found");
  const { hlsDir } = entry[1];
  const filePath = path.join(hlsDir, "index.m3u8");
  res.sendFile(filePath);
});

// --- Torrent to mp4 streaming endpoint ---
// (Deprecated duplicate block removed: streaming served via HLS endpoint above)

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  // Scan for any leftover HLS directories from previous runs
  scanExistingHlsStreams();
});
