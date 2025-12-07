const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const url = require("url");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const util = require("util");

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const torrentStream = require("torrent-stream");

// --- Logging setup ---
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "server.log");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const fileLogger = fs.createWriteStream(LOG_FILE, { flags: "a" });

function formatLogArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === "string") return arg;
  return util.inspect(arg, { depth: 5, colors: false });
}

function writeLogLine(level, args) {
  if (!fileLogger || fileLogger.destroyed) return;
  const time = new Date().toISOString();
  const msg = args.map(formatLogArg).join(" ");
  fileLogger.write(`[${time}] [${level.toUpperCase()}] ${msg}\n`);
}

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

["log", "info", "warn", "error"].forEach((level) => {
  console[level] = (...args) => {
    writeLogLine(level, args);
    originalConsole[level](...args);
  };
});

process.on("exit", () => {
  if (fileLogger && !fileLogger.destroyed) {
    fileLogger.end();
  }
});

const httpLogStream = {
  write: (message) => {
    const line = message && message.trim();
    if (line) writeLogLine("http", [line]);
    process.stdout.write(message);
  },
};

// Torrent scrapers - use simple API-based version
let torrentScrapers = null;
try {
  torrentScrapers = require("./scrapers/simple-torrent-search");
  console.log("Torrent scrapers loaded successfully");
} catch (e) {
  console.warn("Torrent scrapers not available:", e.message);
}

// yt-dlp path detection
const YTDLP_PATH = (() => {
  try {
    return execSync("which yt-dlp 2>/dev/null || echo ~/.local/bin/yt-dlp")
      .toString()
      .trim();
  } catch (_) {
    return "yt-dlp";
  }
})();

const app = express();
const PORT = process.env.PORT || 8081;
const HOST = process.env.HOST || "0.0.0.0";

app.disable("etag");

app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use("/downloads", express.static(path.join(__dirname, "downloads")));
app.use(
  morgan(
    ":remote-addr :method :url :status :res[content-length] - :response-time ms",
    { stream: httpLogStream },
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
      if (isStreamActive(existing)) {
        existing.lastUsed = Date.now();
        return res.json({
          streamId,
          name: existing.name,
          streamUrl: `/hls/${streamId}.m3u8`,
        });
      }
      activeStreams.delete(streamId);
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

    // Create fresh HLS directory
    resetDir(hlsDir);

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
      { transcodeVideo: true },
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
  } catch (_) {
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

// ---- Torrent persistence for crash recovery ----
const TORRENT_STATE_FILE = path.join(__dirname, "torrent-state.json");

function saveTorrentState(infoHash, magnetURI, fileIndex, streamId) {
  try {
    let state = {};
    if (fs.existsSync(TORRENT_STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(TORRENT_STATE_FILE, "utf8"));
    }
    state[streamId] = {
      infoHash,
      magnetURI,
      fileIndex,
      streamId,
      savedAt: Date.now(),
    };
    fs.writeFileSync(TORRENT_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Failed to save torrent state:", err.message);
  }
}

function removeTorrentState(streamId) {
  try {
    if (!fs.existsSync(TORRENT_STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(TORRENT_STATE_FILE, "utf8"));
    delete state[streamId];
    fs.writeFileSync(TORRENT_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Failed to remove torrent state:", err.message);
  }
}

function loadTorrentStates() {
  try {
    if (!fs.existsSync(TORRENT_STATE_FILE)) return [];
    const state = JSON.parse(fs.readFileSync(TORRENT_STATE_FILE, "utf8"));
    return Object.values(state);
  } catch (err) {
    console.error("Failed to load torrent states:", err.message);
    return [];
  }
}

function markStreamUsed(entry) {
  if (entry) entry.lastUsed = Date.now();
}

function findStreamByPrefix(partialId) {
  for (const [id, entry] of activeStreams.entries()) {
    if (id.startsWith(partialId)) {
      return { id, entry };
    }
  }
  return null;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function resetDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  ensureDir(dirPath);
}

function setNoCacheHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader(
    "ETag",
    `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  );
  res.setHeader("Last-Modified", new Date().toUTCString());
}

function sendHlsFile(res, filePath) {
  if (!fs.existsSync(filePath))
    return res.status(404).send("Segment not found");
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts") {
    res.type("video/MP2T");
  } else if (ext === ".m3u8") {
    res.type("application/vnd.apple.mpegurl");
  }
  setNoCacheHeaders(res);
  return res.sendFile(filePath, {
    cacheControl: false,
    lastModified: false,
  });
}

function isStreamActive(entry) {
  if (!entry) return false;
  const proc = entry.ffmpegProcess;
  if (Array.isArray(proc)) {
    return proc.some((p) => p && p.exitCode === null && !p.killed);
  }
  return !!(proc && proc.exitCode === null && !proc.killed);
}

function buildHlsArgs(outputPath, baseUrl, opts = {}) {
  const {
    transcodeVideo = false,
    videoEncoder = process.env.HLS_VIDEO_CODEC || "libx264",
    videoBitrate = "2500k",
    transcodeAudio = true,
    audioBitrate = "128k",
    scale,
  } = opts;

  const args = [
    "-y",
    "-hwaccel",
    "auto",
    // Збільшений буфер для стабільності
    "-probesize",
    "50M",
    "-analyzeduration",
    "100M",
    "-fflags",
    "+genpts+discardcorrupt+igndts",
    "-err_detect",
    "ignore_err",
    "-i",
    "pipe:0",
  ];

  if (transcodeVideo) {
    args.push("-c:v", videoEncoder);
    if (!/nvenc|vaapi|qsv/i.test(videoEncoder)) {
      args.push("-preset", "veryfast", "-tune", "zerolatency");
    }
    if (scale) {
      args.push("-vf", `scale=${scale}`);
    }
    if (videoBitrate) args.push("-b:v", videoBitrate);
  } else {
    args.push("-c:v", "copy");
  }

  if (transcodeAudio) {
    args.push("-c:a", "aac", "-ac", "2", "-ar", "44100");
    if (audioBitrate) args.push("-b:a", audioBitrate);
  } else {
    args.push("-c:a", "copy");
  }

  args.push(
    // Збільшений буфер muxer
    "-max_muxing_queue_size",
    "4096",
    "-f",
    "hls",
    // Довші сегменти = менше запитів, стабільніше
    "-hls_time",
    "6",
    // Зберігати всі сегменти
    "-hls_list_size",
    "0",
    // Флаги для стабільності
    "-hls_flags",
    "omit_endlist+append_list+independent_segments",
    // Початковий номер сегменту
    "-start_number",
    "0",
  );

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
  const existing = activeStreams.get(streamId);
  if (existing && isStreamActive(existing)) {
    markStreamUsed(existing);
    return { streamId, name: existing.name || file.name };
  }
  activeStreams.delete(streamId);
  resetDir(hlsDir);
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
    } catch (_) {
      /* ignore */
    }
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
          if (isStreamActive(existing)) {
            existing.lastUsed = Date.now();
            return resolve({ streamId, name: existing.name });
          }
          activeStreams.delete(streamId);
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
            if (activeStreams.has(sid)) {
              const fallbackEntry = activeStreams.get(sid);
              if (isStreamActive(fallbackEntry)) {
                return resolve({
                  streamId: sid,
                  name: fallbackEntry.name,
                });
              }
              activeStreams.delete(sid);
            }
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
                if (isStreamActive(existing)) {
                  return resolve({ streamId: id, name: existing.name });
                }
                activeStreams.delete(id);
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
            if (isStreamActive(existing))
              return resolve({ streamId, name: existing.name });
            activeStreams.delete(streamId);
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
      } catch (_) {
        /* ignore */
      }
      if (s.ffmpegProcess) {
        try {
          if (Array.isArray(s.ffmpegProcess)) {
            s.ffmpegProcess.forEach((p) => {
              try {
                p.kill("SIGTERM");
              } catch (_) {
                /* ignore */
              }
            });
          } else {
            try {
              s.ffmpegProcess.kill("SIGTERM");
            } catch (_) {
              /* ignore */
            }
          }
        } catch (_) {
          /* ignore */
        }
      }
      activeStreams.delete(id);
      removeTorrentState(id); // Clean up persisted state
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

// Restore torrent streams from saved state (after crash/restart)
async function restoreTorrentStreams() {
  const states = loadTorrentStates();
  if (states.length === 0) return;

  console.log(`Found ${states.length} saved torrent state(s) to restore`);

  // Group by infoHash - only restore ONE stream per torrent (the most recent)
  const byInfoHash = new Map();
  for (const state of states) {
    const { infoHash, savedAt } = state;
    if (!infoHash) continue;
    const existing = byInfoHash.get(infoHash);
    if (!existing || savedAt > existing.savedAt) {
      byInfoHash.set(infoHash, state);
    }
  }

  // Remove old states for same torrent
  for (const state of states) {
    const best = byInfoHash.get(state.infoHash);
    if (best && best.streamId !== state.streamId) {
      console.log(`Removing old state for ${state.streamId} (newer: ${best.streamId})`);
      removeTorrentState(state.streamId);
    }
  }

  for (const state of byInfoHash.values()) {
    const { magnetURI, fileIndex, streamId, infoHash } = state;
    if (!magnetURI || !streamId) continue;

    // Check if HLS dir exists and has content
    const hlsDir = `/tmp/hls_${streamId}`;
    if (
      !fs.existsSync(hlsDir) ||
      !fs.existsSync(path.join(hlsDir, "index.m3u8"))
    ) {
      console.log(`Skipping restore for ${streamId} - no HLS data`);
      removeTorrentState(streamId);
      continue;
    }

    // Check if stream is already complete (has #EXT-X-ENDLIST)
    const playlist = fs.readFileSync(path.join(hlsDir, "index.m3u8"), "utf8");
    if (playlist.includes("#EXT-X-ENDLIST")) {
      console.log(`Stream ${streamId} is complete, no need to restore torrent`);
      continue;
    }

    console.log(`Restoring torrent stream: ${streamId}`);

    try {
      // Restart the torrent engine
      const engine = await new Promise((resolve, reject) => {
        const opts = {
          path: path.join(__dirname, "downloads"),
          dht: true,
          verify: false,
          trackers: [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://open.stealth.si:80/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://tracker.bittor.pw:1337/announce",
            "udp://public.popcorn-tracker.org:6969/announce",
            "udp://tracker.dler.org:6969/announce",
            "udp://exodus.desync.com:6969/announce",
          ],
        };

        const e = torrentStream(magnetURI, opts);
        const timeout = setTimeout(() => {
          e.destroy();
          reject(new Error("Torrent restore timeout"));
        }, 60000);

        e.on("ready", () => {
          clearTimeout(timeout);
          torrentEngines.set(e.infoHash, e);
          resolve(e);
        });

        e.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      const selectedFile = engine.files[fileIndex];
      if (!selectedFile) {
        console.error(`File index ${fileIndex} not found in torrent`);
        continue;
      }

      // Deselect all, select target file
      engine.files.forEach((f) => f.deselect());
      selectedFile.select();
      selectedFile.select(0); // highest priority

      // Start ffmpeg for HLS (append mode - continue from where we left)
      const ffmpegArgs = buildHlsArgs(
        path.join(hlsDir, "index.m3u8"),
        `/hls/${streamId}/`,
      );

      const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
        stdio: ["pipe", "ignore", "pipe"],
      });

      if (ffmpeg.stdin) {
        ffmpeg.stdin.on("error", () => {});
      }

      let bytesReceived = 0;
      const fileStream = selectedFile.createReadStream();

      fileStream.on("data", (chunk) => {
        bytesReceived += chunk.length;
        if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
          ffmpeg.stdin.write(chunk);
        }
      });

      fileStream.on("end", () => {
        if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
          ffmpeg.stdin.end();
        }
      });

      // Update active stream entry
      activeStreams.set(streamId, {
        torrent: null,
        engine,
        fileIndex,
        lastUsed: Date.now(),
        mp4Path: null,
        hlsDir,
        ffmpegProcess: ffmpeg,
        name: selectedFile.name,
        magnetURI,
      });

      console.log(
        `Restored torrent stream: ${streamId} - ${selectedFile.name}`,
      );
    } catch (err) {
      console.error(`Failed to restore ${streamId}:`, err.message);
      // Don't remove state - might work on next restart
    }
  }
}

// ---- Push to TV feature ----
// Store current URL to play (in-memory, single TV mode)
let currentPlayUrl = null;
let sseClients = [];
let remoteClients = []; // SSE clients for remote control UI
let playerState = {
  currentTime: 0,
  duration: 0,
  paused: true,
  mediaName: null,
  streamId: null,
};

// Watch progress storage (streamId -> { position, duration, updatedAt })
const watchProgress = new Map();

// TV state persistence
const TV_STATE_FILE = path.join(__dirname, "tv-state.json");

function saveTvState() {
  try {
    if (currentPlayUrl && typeof currentPlayUrl === "object") {
      fs.writeFileSync(TV_STATE_FILE, JSON.stringify(currentPlayUrl, null, 2));
    }
  } catch (err) {
    console.error("Failed to save TV state:", err.message);
  }
}

function loadTvState() {
  try {
    if (fs.existsSync(TV_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(TV_STATE_FILE, "utf8"));
      // Only restore if less than 24 hours old
      if (data.savedAt && Date.now() - data.savedAt < 24 * 60 * 60 * 1000) {
        return data;
      }
    }
  } catch (err) {
    console.error("Failed to load TV state:", err.message);
  }
  return null;
}

// Load TV state on startup
const savedTvState = loadTvState();
if (savedTvState) {
  currentPlayUrl = savedTvState;
  console.log("Restored TV state:", savedTvState.name || savedTvState.url);
}

// SSE endpoint for TV to listen for new URLs
app.get("/tv/listen", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current URL immediately if exists
  if (currentPlayUrl) {
    const payload =
      typeof currentPlayUrl === "object"
        ? currentPlayUrl
        : { url: currentPlayUrl };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
// Find better quality version of a file on disk
function findBetterQuality(filename) {
  const downloadsDir = path.join(__dirname, "downloads");
  if (!fs.existsSync(downloadsDir)) return null;

  // Extract episode info (S01E05, etc)
  const episodeMatch = filename.match(/S(\d+)E(\d+)/i);
  if (!episodeMatch) return null;
  const season = episodeMatch[1];
  const episode = episodeMatch[2];
  const episodePattern = new RegExp(`S${season}E${episode}`, 'i');

  // Quality ranking (higher = better)
  const getQualityScore = (name) => {
    if (/2160p|4K|UHD/i.test(name)) return 100;
    if (/1080p/i.test(name)) return 80;
    if (/720p/i.test(name)) return 60;
    if (/480p/i.test(name)) return 40;
    if (/WEB-DLRip|HDRip|DVDRip/i.test(name)) return 20;
    return 10;
  };

  const currentQuality = getQualityScore(filename);
  let bestMatch = null;
  let bestScore = currentQuality;

  // Search all download folders
  const subdirs = fs.readdirSync(downloadsDir).filter(f =>
    fs.statSync(path.join(downloadsDir, f)).isDirectory()
  );

  for (const subdir of subdirs) {
    const subdirPath = path.join(downloadsDir, subdir);
    const files = fs.readdirSync(subdirPath);

    for (const file of files) {
      if (!episodePattern.test(file)) continue;
      if (!/\.(mp4|mkv|avi|webm)$/i.test(file)) continue;

      const filePath = path.join(subdirPath, file);
      const stats = fs.statSync(filePath);
      const score = getQualityScore(file);

      // Must be better quality AND reasonable size (>50MB)
      if (score > bestScore && stats.size > 50 * 1024 * 1024) {
        bestScore = score;
        bestMatch = {
          path: `/downloads/${subdir}/${file}`,
          fullPath: filePath,
          name: file,
          size: stats.size,
          quality: score
        };
      }
    }
  }

  return bestMatch;
}

app.post("/tv/push", express.json(), (req, res) => {
  let { url, name, episodes, streamId, currentIndex, magnetURI } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });

  // Check if there's a better quality version available
  let betterQuality = null;
  if (name) {
    betterQuality = findBetterQuality(name);
    if (betterQuality) {
      console.log(`Found better quality: ${betterQuality.name} (${(betterQuality.size/1024/1024).toFixed(0)}MB)`);
      // Convert to HLS and push - async, don't wait
      fetch(`http://localhost:${PORT}/api/local2hls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: betterQuality.fullPath, pushToTv: true })
      }).catch(e => console.error("local2hls error:", e));
      return res.json({ success: true, clients: sseClients.length, upgradedQuality: true, upgrading: true });
    }
  }

  // Store full metadata with timestamp
  currentPlayUrl = {
    url,
    name,
    episodes,
    streamId,
    currentIndex,
    magnetURI,
    savedAt: Date.now()
  };
  console.log(`Pushing URL to ${sseClients.length} TV(s): ${url}`);

  // Save to disk for persistence
  saveTvState();

  // Broadcast to all SSE clients with metadata
  const payload = { url, name, episodes, streamId, currentIndex, magnetURI, betterQuality: !!betterQuality };
  sseClients.forEach((client) => {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  });

  res.json({ success: true, clients: sseClients.length, upgradedQuality: !!betterQuality });
});

// Get current URL (for polling fallback)
app.get("/tv/current", (req, res) => {
  if (typeof currentPlayUrl === "object" && currentPlayUrl) {
    res.json(currentPlayUrl);
  } else if (currentPlayUrl) {
    res.json({ url: currentPlayUrl });
  } else {
    res.json({});
  }
});

// ---- Search API ----
// Search YouTube using yt-dlp
app.get("/api/search/youtube", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    const args = [
      "--flat-playlist",
      "--no-warnings",
      "--dump-json",
      "-I",
      "1:15", // Limit to 15 results
      `ytsearch15:${query}`,
    ];

    const proc = spawn(YTDLP_PATH, args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => {
      if (code !== 0) {
        return res.status(500).json({ error: stderr || "Search failed" });
      }

      try {
        const results = stdout
          .trim()
          .split("\n")
          .filter((l) => l)
          .map((line) => {
            try {
              const info = JSON.parse(line);
              return {
                title: info.title,
                url: info.url || info.webpage_url,
                thumbnail: info.thumbnail,
                duration: info.duration,
                channel: info.channel || info.uploader,
                views: info.view_count,
                id: info.id,
              };
            } catch (_) {
              return null;
            }
          })
          .filter((r) => r);

        res.json({ results });
      } catch (e) {
        res.status(500).json({ error: "Failed to parse results" });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search torrents using multiple trackers
app.get("/api/search/torrents", async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    if (!torrentScrapers) {
      return res.json({
        results: [],
        message:
          "Torrent scrapers not initialized. Run: npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth cheerio",
      });
    }

    const source = req.query.source; // yts, 1337x, piratebay, or all
    let results = [];

    // Search based on source
    switch (source) {
      case "yts":
        results = await torrentScrapers.searchYTS(query);
        break;
      case "1337x":
        results = await torrentScrapers.search1337x(query);
        break;
      case "piratebay":
        results = await torrentScrapers.searchPirateBay(query);
        break;
      default:
        // Search all sources
        results = await torrentScrapers.searchAll(query);
    }

    // Results already contain magnet links from API

    res.json({ results });
  } catch (err) {
    console.error("Torrent search error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Clear current URL
app.post("/tv/clear", (req, res) => {
  currentPlayUrl = null;
  sseClients.forEach((client) => {
    client.write(`data: ${JSON.stringify({ url: null, action: "clear" })}\n\n`);
  });
  res.json({ success: true });
});

// Remote control for TV player
app.post("/tv/control", express.json(), (req, res) => {
  const { action, value } = req.body;
  if (!action) return res.status(400).json({ error: "Missing action" });

  const payload = { action, value };
  console.log(`TV control: ${action}`, value !== undefined ? value : "");

  sseClients.forEach((client) => {
    client.write(`data: ${JSON.stringify(payload)}\n\n`);
  });

  res.json({ success: true, clients: sseClients.length });
});

// TV reports its player state (called periodically by TV)
app.post("/tv/state", express.json(), (req, res) => {
  const { currentTime, duration, paused, mediaName, streamId } = req.body;
  playerState = {
    currentTime,
    duration,
    paused,
    mediaName,
    streamId,
    updatedAt: Date.now(),
  };

  // Save watch progress
  if (streamId && currentTime > 5) {
    watchProgress.set(streamId, {
      position: currentTime,
      duration,
      updatedAt: Date.now(),
    });
  }

  // Broadcast to remote clients
  remoteClients.forEach((client) => {
    client.write(`data: ${JSON.stringify(playerState)}\n\n`);
  });

  res.json({ success: true });
});

// Get saved watch progress for a stream
app.get("/tv/progress/:streamId", (req, res) => {
  const progress = watchProgress.get(req.params.streamId);
  res.json(progress || { position: 0 });
});

// SSE endpoint for remote control UI to get player state
app.get("/tv/remote", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify(playerState)}\n\n`);

  remoteClients.push(res);

  req.on("close", () => {
    remoteClients = remoteClients.filter((c) => c !== res);
  });
});

// Create stream from magnet/torrent URL and return a playable mp4 URL
// Torrent engines cache (torrent-stream based, works with regular BitTorrent peers)
const torrentEngines = new Map(); // infoHash -> engine
const backgroundDownloads = new Map(); // streamId -> { betterMagnet, engine, progress, status }

// Smart quality switching - download better quality in background
async function startBackgroundDownload(streamId, betterMagnet, betterName) {
  if (backgroundDownloads.has(streamId)) {
    console.log(`Background download already running for ${streamId}`);
    return;
  }

  console.log(`Starting background download of better quality: ${betterName}`);

  try {
    const engine = await new Promise((resolve, reject) => {
      const opts = {
        path: path.join(__dirname, "downloads"),
        dht: true,
        verify: false,
        trackers: [
          "udp://tracker.opentrackr.org:1337/announce",
          "udp://open.stealth.si:80/announce",
          "udp://tracker.torrent.eu.org:451/announce",
          "udp://exodus.desync.com:6969/announce",
          "udp://tracker.openbittorrent.com:6969/announce",
        ],
      };

      const e = torrentStream(betterMagnet, opts);
      const timeout = setTimeout(() => {
        e.destroy();
        reject(new Error("Background torrent timeout"));
      }, 60000);

      e.on("ready", () => {
        clearTimeout(timeout);
        resolve(e);
      });

      e.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Find first video file
    const videoFile = engine.files.find(f => /\.(mp4|webm|avi|mkv)$/i.test(f.name));
    if (!videoFile) {
      engine.destroy();
      return;
    }

    // Start downloading with low priority
    engine.files.forEach(f => f.deselect());
    videoFile.select();

    const downloadInfo = {
      engine,
      magnet: betterMagnet,
      name: betterName,
      file: videoFile,
      progress: 0,
      status: "downloading",
      startedAt: Date.now()
    };

    backgroundDownloads.set(streamId, downloadInfo);

    // Monitor progress
    const progressInterval = setInterval(() => {
      if (!backgroundDownloads.has(streamId)) {
        clearInterval(progressInterval);
        return;
      }

      const downloaded = engine.swarm.downloaded;
      const total = videoFile.length;
      const progress = Math.round((downloaded / total) * 100);

      downloadInfo.progress = progress;

      // If 30%+ downloaded, we can switch
      if (progress >= 30 && downloadInfo.status === "downloading") {
        downloadInfo.status = "ready";
        console.log(`Background download ready for switch: ${betterName} (${progress}%)`);
      }

      // If complete, mark as done
      if (progress >= 99) {
        downloadInfo.status = "complete";
        clearInterval(progressInterval);
        console.log(`Background download complete: ${betterName}`);
      }
    }, 5000);

  } catch (err) {
    console.error("Background download failed:", err.message);
    backgroundDownloads.delete(streamId);
  }
}

// Get background download status
app.get("/api/background-download/:streamId", (req, res) => {
  const { streamId } = req.params;
  const download = backgroundDownloads.get(streamId);

  if (!download) {
    return res.json({ status: "none" });
  }

  res.json({
    status: download.status,
    progress: download.progress,
    name: download.name,
    canSwitch: download.status === "ready" || download.status === "complete"
  });
});

// Switch to better quality
app.post("/api/switch-quality/:streamId", async (req, res) => {
  const { streamId } = req.params;
  const download = backgroundDownloads.get(streamId);

  if (!download || (download.status !== "ready" && download.status !== "complete")) {
    return res.status(400).json({ error: "Better quality not ready yet" });
  }

  // Return the magnet link for the better quality - client will start new stream
  res.json({
    magnetLink: download.magnet,
    name: download.name,
    progress: download.progress
  });
});

// Smart stream start - picks fastest option and queues better quality in background
app.post("/api/smart-stream", express.json(), async (req, res) => {
  const { options } = req.body;
  // options = [{ magnetLink, name, seeders, quality }] sorted by preference

  if (!options || options.length === 0) {
    return res.status(400).json({ error: "No options provided" });
  }

  // Sort by seeders (most seeders = fastest start)
  const sortedBySeeders = [...options].sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

  // Pick fastest (most seeders) for immediate playback
  const fastest = sortedBySeeders[0];

  // Find best quality option (prefer 1080p, then 720p, etc)
  const qualityOrder = ['4K', '2160p', '1080p', '720p', '480p', '360p'];
  const sortedByQuality = [...options].sort((a, b) => {
    const aIdx = qualityOrder.findIndex(q => (a.quality || a.name || '').includes(q));
    const bIdx = qualityOrder.findIndex(q => (b.quality || b.name || '').includes(q));
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });
  const bestQuality = sortedByQuality[0];

  console.log(`Smart stream: fastest=${fastest.name} (${fastest.seeders} seeds), best=${bestQuality.name}`);

  // Start the fast stream first
  try {
    const streamRes = await fetch(`http://localhost:${PORT}/api/torrent2mp4`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: fastest.magnetLink })
    });
    const streamData = await streamRes.json();

    if (streamData.error) {
      return res.status(500).json({ error: streamData.error });
    }

    // If best quality is different from fastest, start background download
    if (bestQuality.magnetLink !== fastest.magnetLink && (bestQuality.seeders || 0) >= 3) {
      setTimeout(() => {
        startBackgroundDownload(streamData.streamId, bestQuality.magnetLink, bestQuality.name);
      }, 5000); // Wait 5s before starting background download
    }

    res.json({
      ...streamData,
      playingQuality: fastest.quality || 'unknown',
      betterQualityAvailable: bestQuality.magnetLink !== fastest.magnetLink,
      betterQualityName: bestQuality.name
    });

  } catch (err) {
    console.error("Smart stream error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/torrent2mp4", express.json(), async (req, res) => {
  const { url: inputUrl, fileIndex: requestedFileIndex } =
    req.body || req.query || {};
  console.log("torrent2mp4 called", inputUrl, "fileIndex:", requestedFileIndex);
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

    // Extract infoHash from magnet to check for existing engine
    const magnetInfoHash = parseInfoHashFromMagnet(magnet);

    // Check if we already have an engine for this torrent
    let engine = magnetInfoHash ? torrentEngines.get(magnetInfoHash) : null;

    if (engine) {
      console.log("Reusing existing torrent engine for:", magnetInfoHash);
    } else {
      // Use torrent-stream for real BitTorrent DHT/peers
      engine = await new Promise((resolve, reject) => {
        const opts = {
          path: path.join(__dirname, "downloads"),
          dht: true,
          verify: false,
          trackers: [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://open.stealth.si:80/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://tracker.bittor.pw:1337/announce",
            "udp://public.popcorn-tracker.org:6969/announce",
            "udp://tracker.dler.org:6969/announce",
            "udp://exodus.desync.com:6969/announce",
            "udp://open.demonii.com:1337/announce",
            "udp://9.rarbg.com:2810/announce",
            "udp://tracker.openbittorrent.com:6969/announce",
            "udp://opentor.org:2710/announce",
            "udp://tracker.pirateparty.gr:6969/announce",
            "udp://tracker.tiny-vps.com:6969/announce",
            "udp://tracker.cyberia.is:6969/announce",
            "udp://explodie.org:6969/announce",
            "http://tracker.opentrackr.org:1337/announce",
            "http://bt.t-ru.org/ann?magnet",
          ],
        };

        const e = torrentStream(torrentBuffer || magnet, opts);
        const timeout = setTimeout(() => {
          e.destroy();
          reject(
            new Error(
              "Torrent timeout (90s) - no peers found. Try a torrent with more seeders.",
            ),
          );
        }, 90000);

        e.on("ready", () => {
          clearTimeout(timeout);
          console.log(
            "Torrent ready:",
            e.torrent.name,
            "- files:",
            e.files.length,
          );
          // Cache the engine for reuse
          torrentEngines.set(e.infoHash, e);
          resolve(e);
        });

        e.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    }

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

    // Stop any OTHER streams from this same torrent (episode switching)
    for (const [sid, stream] of activeStreams.entries()) {
      if (sid.startsWith(`ts_${engine.infoHash}_`) && sid !== streamId) {
        console.log(`Stopping old episode stream: ${sid}`);
        // Kill ffmpeg process
        if (stream.ffmpegProcess) {
          try {
            stream.ffmpegProcess.kill("SIGKILL");
          } catch (e) { /* ignore */ }
        }
        // Remove from state file
        removeTorrentState(sid);
        activeStreams.delete(sid);
      }
    }

    // Check if already streaming THIS episode
    if (activeStreams.has(streamId)) {
      const existing = activeStreams.get(streamId);
      if (isStreamActive(existing)) {
        // Don't destroy engine - it's cached for reuse
        existing.lastUsed = Date.now();
        return res.json({
          streamId,
          name: existing.name,
          streamUrl: `/hls/${streamId}.m3u8`,
          videoFiles,
        });
      }
      activeStreams.delete(streamId);
    }

    // Create fresh HLS directory
    resetDir(hlsDir);

    // Start streaming: torrent-stream -> buffered pipe -> ffmpeg -> HLS
    // Deselect ALL files first, then select only our file with priority
    engine.files.forEach((f) => f.deselect());
    selectedFile.select();
    // Use critical priority for immediate download
    selectedFile.select(0); // priority 0 = highest

    const ffmpegArgs = buildHlsArgs(
      path.join(hlsDir, "index.m3u8"),
      `/hls/${streamId}/`,
    );

    console.log(
      `Starting torrent stream: ${selectedFile.name}, size: ${selectedFile.length}, fileIndex: ${fileIndex}`,
    );
    console.log(
      "All video files:",
      videoFiles.map((f) => ({ name: f.name, index: f.index })),
    );

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    // Налаштування stdin з обробкою помилок
    if (ffmpeg.stdin) {
      ffmpeg.stdin.on("error", (err) => {
        console.warn(`ffmpeg stdin error (non-fatal): ${err.message}`);
      });
    }

    let bytesReceived = 0;
    let lastLogTime = Date.now();
    let isPaused = false;

    // Check if file is already fully downloaded - read from disk directly
    // Try multiple possible paths
    const possiblePaths = [
      path.join(__dirname, "downloads", engine.torrent.name, selectedFile.name),
      path.join(__dirname, "downloads", engine.torrent.name, selectedFile.path),
      path.join(__dirname, "downloads", selectedFile.path),
    ];

    // Also search in all download subdirectories for matching filename
    const downloadsDir = path.join(__dirname, "downloads");
    if (fs.existsSync(downloadsDir)) {
      const subdirs = fs.readdirSync(downloadsDir).filter(f =>
        fs.statSync(path.join(downloadsDir, f)).isDirectory()
      );
      for (const subdir of subdirs) {
        possiblePaths.push(path.join(downloadsDir, subdir, selectedFile.name));
        // Also check for partial filename match
        const subdirPath = path.join(downloadsDir, subdir);
        const files = fs.readdirSync(subdirPath);
        for (const file of files) {
          if (file.includes(selectedFile.name.split('.')[0]) ||
              selectedFile.name.includes(file.split('.')[0])) {
            possiblePaths.push(path.join(subdirPath, file));
          }
        }
      }
    }

    let fileStream;
    let foundPath = null;

    for (const tryPath of possiblePaths) {
      if (fs.existsSync(tryPath)) {
        const stats = fs.statSync(tryPath);
        // Accept if size matches OR if file is larger than 90% of expected
        if (stats.size === selectedFile.length || stats.size > selectedFile.length * 0.9) {
          foundPath = tryPath;
          console.log(`File found on disk: ${tryPath} (${(stats.size/1024/1024).toFixed(1)}MB)`);
          break;
        }
      }
    }

    if (foundPath) {
      console.log(`Using cached file from disk: ${foundPath}`);
      fileStream = fs.createReadStream(foundPath);
    } else {
      console.log(`File not on disk, using torrent stream for: ${selectedFile.name}`);
      fileStream = selectedFile.createReadStream();
    }

    // Контроль потоку: пауза коли ffmpeg не встигає
    fileStream.on("data", (chunk) => {
      bytesReceived += chunk.length;

      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        const canContinue = ffmpeg.stdin.write(chunk);
        if (!canContinue && !isPaused) {
          isPaused = true;
          fileStream.pause();
        }
      }

      // Логування прогресу кожні 10 секунд
      const now = Date.now();
      if (now - lastLogTime > 10000) {
        const percent = ((bytesReceived / selectedFile.length) * 100).toFixed(
          1,
        );
        console.log(
          `Torrent ${streamId}: ${(bytesReceived / 1024 / 1024).toFixed(1)}MB (${percent}%)`,
        );
        lastLogTime = now;
      }
    });

    // Відновлення потоку коли ffmpeg готовий приймати дані
    if (ffmpeg.stdin) {
      ffmpeg.stdin.on("drain", () => {
        if (isPaused) {
          isPaused = false;
          fileStream.resume();
        }
      });
    }

    fileStream.on("end", () => {
      console.log(
        `Torrent ${streamId}: read complete, ${(bytesReceived / 1024 / 1024).toFixed(1)}MB`,
      );
      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        ffmpeg.stdin.end();
      }
      // Add ENDLIST after ffmpeg finishes (wait a bit for final segments)
      setTimeout(() => {
        const playlistPath = path.join(hlsDir, "index.m3u8");
        if (fs.existsSync(playlistPath)) {
          const content = fs.readFileSync(playlistPath, "utf8");
          if (!content.includes("#EXT-X-ENDLIST")) {
            fs.appendFileSync(playlistPath, "\n#EXT-X-ENDLIST\n");
            console.log(`Added ENDLIST to ${streamId}`);
          }
        }
      }, 3000);
    });

    fileStream.on("error", (err) => {
      console.error(`Torrent file stream error: ${err.message}`);
      // Даємо ffmpeg час обробити буфер перед закриттям
      setTimeout(() => {
        if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
          ffmpeg.stdin.end();
        }
      }, 3000);
    });

    // Log progress after 5 seconds
    setTimeout(() => {
      console.log(
        `Torrent ${streamId}: received ${(bytesReceived / 1024 / 1024).toFixed(2)} MB`,
      );
    }, 5000);

    let ffmpegStarted = false;
    ffmpeg.stderr.on("data", (d) => {
      const msg = d.toString();
      if (msg.includes("Output #0") && !ffmpegStarted) {
        ffmpegStarted = true;
        console.log(`Torrent HLS encoding started for ${streamId}`);
      }
      // Логуємо тільки серйозні помилки
      if (msg.includes("Error") && !msg.includes("discarding")) {
        console.error("ffmpeg error:", msg.trim());
      }
    });

    ffmpeg.on("error", (err) => {
      console.error("ffmpeg spawn error:", err);
    });

    ffmpeg.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(
          `ffmpeg exited with code ${code}, signal ${signal} for ${streamId}`,
        );
      } else {
        console.log(`ffmpeg completed for ${streamId}`);
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
      magnetURI: magnet, // Save for recovery
    });

    // Save torrent state for crash recovery
    saveTorrentState(engine.infoHash, magnet, fileIndex, streamId);

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
      markStreamUsed(entry);
      return sendHlsFile(res, filePath);
    }
  }
  res.status(404).send("Segment not found");
});

app.get("/hls/:id/:file", (req, res) => {
  const id = req.params.id;
  const found = findStreamByPrefix(id);
  if (!found) return res.status(404).send("Not found");
  const { entry } = found;
  markStreamUsed(entry);
  const { hlsDir } = entry;
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
  sendHlsFile(res, filePath);
});
app.get("/hls/:id/:quality/:file", (req, res) => {
  const id = req.params.id;
  const quality = req.params.quality;
  const found = findStreamByPrefix(id);
  if (!found) return res.status(404).send("Not found");
  const { entry } = found;
  markStreamUsed(entry);
  const { hlsDir } = entry;
  const filePath = path.join(hlsDir + "_" + quality, req.params.file);
  return sendHlsFile(res, filePath);
});
// Master adaptive playlist
// Check if a torrent stream is dead (no ffmpeg, incomplete playlist)
function isStreamDead(entry, hlsDir) {
  if (!entry) return false;
  // If it has an active ffmpeg process, it's alive
  if (entry.ffmpegProcess && !entry.ffmpegProcess.killed) return false;
  // Check if playlist is complete
  const playlistPath = path.join(hlsDir, "index.m3u8");
  if (!fs.existsSync(playlistPath)) return true;
  const playlist = fs.readFileSync(playlistPath, "utf8");
  // If complete, not dead - just finished
  if (playlist.includes("#EXT-X-ENDLIST")) return false;
  // Incomplete playlist with no ffmpeg = dead
  return true;
}

// Restart a dead torrent stream
async function restartDeadStream(streamId, entry) {
  const states = loadTorrentStates();
  const state = states.find((s) => s.streamId === streamId);
  if (!state || !state.magnetURI) {
    console.log(`Cannot restart ${streamId} - no saved state`);
    return false;
  }

  console.log(`Restarting dead stream: ${streamId}`);

  try {
    const { magnetURI, fileIndex } = state;
    const hlsDir = `/tmp/hls_${streamId}`;

    // Check if engine already exists
    const infoHash = parseInfoHashFromMagnet(magnetURI);
    let engine = infoHash ? torrentEngines.get(infoHash) : null;

    if (!engine) {
      engine = await new Promise((resolve, reject) => {
        const opts = {
          path: path.join(__dirname, "downloads"),
          dht: true,
          verify: false,
          trackers: [
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://open.stealth.si:80/announce",
            "udp://tracker.torrent.eu.org:451/announce",
            "udp://exodus.desync.com:6969/announce",
          ],
        };

        const e = torrentStream(magnetURI, opts);
        const timeout = setTimeout(() => {
          e.destroy();
          reject(new Error("Torrent restart timeout"));
        }, 30000);

        e.on("ready", () => {
          clearTimeout(timeout);
          torrentEngines.set(e.infoHash, e);
          resolve(e);
        });

        e.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    }

    const selectedFile = engine.files[fileIndex];
    if (!selectedFile) return false;

    engine.files.forEach((f) => f.deselect());
    selectedFile.select();
    selectedFile.select(0);

    const ffmpegArgs = buildHlsArgs(
      path.join(hlsDir, "index.m3u8"),
      `/hls/${streamId}/`,
    );

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    if (ffmpeg.stdin) {
      ffmpeg.stdin.on("error", () => {});
    }

    const fileStream = selectedFile.createReadStream();
    fileStream.on("data", (chunk) => {
      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        ffmpeg.stdin.write(chunk);
      }
    });
    fileStream.on("end", () => {
      if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        ffmpeg.stdin.end();
      }
    });

    // Update entry
    entry.engine = engine;
    entry.ffmpegProcess = ffmpeg;
    entry.magnetURI = magnetURI;
    entry.lastUsed = Date.now();

    console.log(`Restarted stream: ${streamId}`);
    return true;
  } catch (err) {
    console.error(`Failed to restart ${streamId}:`, err.message);
    return false;
  }
}

app.get("/hls/:id.m3u8", async (req, res) => {
  const id = req.params.id;
  const found = findStreamByPrefix(id);
  if (!found) return res.status(404).send("Not found");
  const { id: streamId, entry } = found;
  markStreamUsed(entry);
  const { hlsDir } = entry;
  const filePath = path.join(hlsDir, "index.m3u8");

  // Check if stream is dead and try to restart it
  if (isStreamDead(entry, hlsDir)) {
    console.log(`Stream ${streamId} appears dead, attempting restart...`);
    await restartDeadStream(streamId, entry);
  }

  // Wait for the playlist file to be created (max 30 seconds)
  let attempts = 0;
  while (!fs.existsSync(filePath) && attempts < 60) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    attempts++;
  }

  if (!fs.existsSync(filePath)) {
    return res.status(503).send("Stream not ready yet. Please retry.");
  }
  sendHlsFile(res, filePath);
});

// --- Torrent to mp4 streaming endpoint ---
// (Deprecated duplicate block removed: streaming served via HLS endpoint above)

// ============== PUSH NOTIFICATIONS ==============
const webpush = require("web-push");

// Generate VAPID keys once and store them
const VAPID_KEYS_FILE = path.join(__dirname, "vapid-keys.json");
let vapidKeys;

if (fs.existsSync(VAPID_KEYS_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_KEYS_FILE, "utf8"));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(vapidKeys, null, 2));
  console.log("Generated new VAPID keys");
}

webpush.setVapidDetails(
  "mailto:admin@lanvideo.local",
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// Store push subscriptions
const PUSH_SUBS_FILE = path.join(__dirname, "push-subscriptions.json");
let pushSubscriptions = [];

if (fs.existsSync(PUSH_SUBS_FILE)) {
  try {
    pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, "utf8"));
  } catch (e) {
    pushSubscriptions = [];
  }
}

function savePushSubscriptions() {
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(pushSubscriptions, null, 2));
}

// Get VAPID public key
app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Subscribe to push
app.post("/api/push/subscribe", (req, res) => {
  const subscription = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription" });
  }

  // Check if already subscribed
  const exists = pushSubscriptions.some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    pushSubscriptions.push(subscription);
    savePushSubscriptions();
    console.log("New push subscription added");
  }

  res.json({ success: true });
});

// Unsubscribe from push
app.post("/api/push/unsubscribe", (req, res) => {
  const { endpoint } = req.body;

  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
  savePushSubscriptions();

  res.json({ success: true });
});

// Send push notification to all subscribers
async function sendPushNotification(payload) {
  const notification = JSON.stringify(payload);
  const results = [];

  for (const subscription of pushSubscriptions) {
    try {
      await webpush.sendNotification(subscription, notification);
      results.push({ success: true, endpoint: subscription.endpoint });
    } catch (error) {
      console.error("Push send error:", error.message);

      // Remove invalid subscriptions
      if (error.statusCode === 404 || error.statusCode === 410) {
        pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== subscription.endpoint);
        savePushSubscriptions();
      }

      results.push({ success: false, endpoint: subscription.endpoint, error: error.message });
    }
  }

  return results;
}

// API to trigger push notification (for testing or server events)
app.post("/api/push/send", async (req, res) => {
  const { title, body, data } = req.body;

  if (!title) {
    return res.status(400).json({ error: "Title required" });
  }

  const results = await sendPushNotification({
    title,
    body: body || "",
    data: data || {},
    tag: "lan-video-notification"
  });

  res.json({ sent: results.length, results });
});

// Notify when video is sent to TV
const originalTvPush = "/tv/push";
// Hook into TV push to send notifications
app.use((req, res, next) => {
  if (req.method === "POST" && req.path === "/tv/push") {
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      if (data.success && pushSubscriptions.length > 0) {
        const name = req.body?.name || "Video";
        sendPushNotification({
          title: "Now Playing on TV",
          body: name,
          data: { url: req.body?.url },
          tag: "tv-playing"
        }).catch(e => console.error("Push notification error:", e));
      }
      return originalJson(data);
    };
  }
  next();
});

// ============== AI MEDIA ASSISTANT API ==============

// Get downloaded torrent files
app.get("/api/torrent/files/:infoHash", (req, res) => {
  const downloadDir = path.join(__dirname, "downloads");
  try {
    const dirs = fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : [];
    let files = [];
    for (const dir of dirs) {
      const dirPath = path.join(downloadDir, dir);
      if (fs.statSync(dirPath).isDirectory()) {
        const dirFiles = fs.readdirSync(dirPath);
        const videoFiles = dirFiles.filter(f => /\.(mp4|mkv|avi|webm|mov)$/i.test(f));
        files = videoFiles.map((f, index) => {
          const filePath = path.join(dirPath, f);
          const stats = fs.statSync(filePath);
          return { name: f, index, size: stats.size, exists: true, path: filePath };
        });
        if (files.length > 0) break;
      }
    }
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// Preview torrent files before downloading (from magnet link)
app.post("/api/torrent/preview", express.json(), async (req, res) => {
  const { magnet } = req.body;
  if (!magnet) return res.status(400).json({ error: "Missing magnet" });

  try {
    const infoHash = parseInfoHashFromMagnet(magnet);

    // Check if we already have this torrent engine cached
    let engine = infoHash ? torrentEngines.get(infoHash) : null;

    if (engine) {
      // Already have it - return files immediately
      const videoFiles = engine.files
        .filter(f => /\.(mp4|webm|avi|mkv)$/i.test(f.name))
        .map((f, idx) => ({
          name: f.name,
          size: f.length,
          sizeFormatted: (f.length / 1024 / 1024).toFixed(1) + ' MB',
          index: engine.files.indexOf(f)
        }));
      return res.json({ infoHash: engine.infoHash, name: engine.torrent?.name, files: videoFiles });
    }

    // Create temporary engine just to get file list
    engine = await new Promise((resolve, reject) => {
      const e = torrentStream(magnet, {
        path: path.join(__dirname, "downloads"),
        dht: true,
        trackers: [
          "udp://tracker.opentrackr.org:1337/announce",
          "udp://open.stealth.si:80/announce",
          "udp://tracker.torrent.eu.org:451/announce",
        ]
      });

      const timeout = setTimeout(() => {
        e.destroy();
        reject(new Error("Timeout getting torrent info"));
      }, 30000);

      e.on("ready", () => {
        clearTimeout(timeout);
        // Cache for later use
        torrentEngines.set(e.infoHash, e);
        resolve(e);
      });

      e.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Deselect all files by default
    engine.files.forEach(f => f.deselect());

    const videoFiles = engine.files
      .filter(f => /\.(mp4|webm|avi|mkv)$/i.test(f.name))
      .map((f, idx) => ({
        name: f.name,
        size: f.length,
        sizeFormatted: (f.length / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        index: engine.files.indexOf(f)
      }));

    res.json({
      infoHash: engine.infoHash,
      name: engine.torrent?.name,
      files: videoFiles
    });

  } catch (err) {
    console.error("Torrent preview error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start downloading specific files from torrent
app.post("/api/torrent/download", express.json(), async (req, res) => {
  const { magnet, fileIndexes } = req.body;
  if (!magnet || !fileIndexes || !Array.isArray(fileIndexes)) {
    return res.status(400).json({ error: "Missing magnet or fileIndexes" });
  }

  try {
    const infoHash = parseInfoHashFromMagnet(magnet);
    let engine = infoHash ? torrentEngines.get(infoHash) : null;

    if (!engine) {
      return res.status(400).json({ error: "Torrent not found. Call /api/torrent/preview first" });
    }

    // Deselect all, then select requested files
    engine.files.forEach(f => f.deselect());

    const selectedFiles = [];
    for (const idx of fileIndexes) {
      const file = engine.files[idx];
      if (file) {
        file.select();
        // Create a read stream to actually start downloading
        const stream = file.createReadStream();
        stream.on('error', () => {}); // Ignore errors
        stream.resume(); // Start flowing
        selectedFiles.push({ name: file.name, index: idx, size: file.length });
      }
    }

    console.log(`Starting download of ${selectedFiles.length} files from ${engine.torrent?.name}`);

    res.json({
      success: true,
      infoHash: engine.infoHash,
      downloading: selectedFiles
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get active downloads status + completed downloads from disk
app.get("/api/downloads/status", (req, res) => {
  const downloads = [];
  const seenFolders = new Set();

  // Active torrent downloads
  for (const [infoHash, engine] of torrentEngines.entries()) {
    const torrentName = engine.torrent?.name || infoHash;
    seenFolders.add(torrentName);

    const files = engine.files.filter(f => f.selected).map(f => {
      // Try to get actual file size on disk for accurate progress
      let downloaded = 0;
      try {
        const filePath = path.join(__dirname, "downloads", torrentName, f.name);
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          downloaded = stats.size;
        }
      } catch (e) {
        // Fall back to swarm downloaded
        downloaded = engine.swarm?.downloaded || 0;
      }

      return {
        name: f.name,
        size: f.length,
        downloaded: downloaded,
        progress: f.length > 0 ? Math.min(100, Math.round((downloaded / f.length) * 100)) : 0
      };
    });

    if (files.length > 0) {
      downloads.push({
        infoHash,
        name: torrentName,
        files,
        peers: engine.swarm?.wires?.length || 0,
        downloadSpeed: engine.swarm?.downloadSpeed() || 0,
        active: true
      });
    }
  }

  // Also scan downloads folder for completed downloads
  try {
    const downloadsDir = path.join(__dirname, "downloads");
    if (fs.existsSync(downloadsDir)) {
      const folders = fs.readdirSync(downloadsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !seenFolders.has(d.name));

      for (const folder of folders) {
        const folderPath = path.join(downloadsDir, folder.name);
        const videoExts = ['.mp4', '.mkv', '.avi', '.webm', '.mov'];

        const files = fs.readdirSync(folderPath)
          .filter(f => videoExts.some(ext => f.toLowerCase().endsWith(ext)))
          .map(f => {
            const filePath = path.join(folderPath, f);
            const stats = fs.statSync(filePath);

            return {
              name: f,
              size: stats.size,
              downloaded: stats.size,
              progress: 100,
              path: filePath
            };
          });

        if (files.length > 0) {
          downloads.push({
            infoHash: folder.name, // Use folder name as ID
            name: folder.name,
            files,
            peers: 0,
            downloadSpeed: 0,
            active: false,
            completed: true
          });
        }
      }
    }
  } catch (e) {
    console.error("Error scanning downloads folder:", e);
  }

  res.json(downloads);
});

// Play a file from active torrent
app.post("/api/torrent/play", express.json(), (req, res) => {
  const { infoHash, fileIndex } = req.body;

  if (!infoHash) {
    return res.status(400).json({ error: "Missing infoHash" });
  }

  const engine = torrentEngines.get(infoHash);
  if (!engine) {
    return res.status(404).json({ error: "Torrent not found" });
  }

  const file = engine.files[fileIndex || 0];
  if (!file) {
    return res.status(404).json({ error: "File not found" });
  }

  // Generate HLS stream URL
  const streamId = `ts_${infoHash}_${fileIndex || 0}`;
  const hlsUrl = `/hls/${streamId}.m3u8`;

  res.json({
    success: true,
    streamUrl: hlsUrl,
    fileName: file.name,
    fileSize: file.length
  });
});

// Stop a torrent download
app.post("/api/torrent/stop/:infoHash", (req, res) => {
  const { infoHash } = req.params;
  const engine = torrentEngines.get(infoHash);

  if (!engine) {
    return res.status(404).json({ error: "Torrent not found" });
  }

  try {
    engine.destroy(() => {
      console.log(`Stopped torrent: ${infoHash}`);
    });
    torrentEngines.delete(infoHash);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cleanup watched episode
app.post("/api/cleanup", (req, res) => {
  const { filePath, episodeIndex } = req.body;
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Cleaned up: ${filePath}`);
      res.json({ success: true, deleted: filePath });
    } else {
      res.status(404).json({ error: "File not found" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Prefetch episode
app.post("/api/prefetch", (req, res) => {
  const { infoHash, episodeIndex } = req.body;
  try {
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    console.log(`Prefetching episode ${episodeIndex} for ${infoHash}`);
    const engine = torrentStream(magnet, {
      path: path.join(__dirname, "downloads"),
      trackers: ["udp://tracker.opentrackr.org:1337/announce"]
    });
    engine.on("ready", () => {
      const files = engine.files.filter(f => /\.(mp4|mkv|avi|webm|mov)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
      if (files[episodeIndex]) {
        files[episodeIndex].select();
        console.log(`Prefetch started: ${files[episodeIndex].name}`);
      }
    });
    res.json({ success: true, status: "prefetch_started" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Convert local file to HLS and push to TV
app.post("/api/local2hls", express.json(), async (req, res) => {
  const { filePath, pushToTv = true } = req.body;
  if (!filePath) return res.status(400).json({ error: "Missing filePath" });

  // Resolve full path
  let fullPath = filePath;
  if (filePath.startsWith('/downloads/')) {
    fullPath = path.join(__dirname, filePath);
  }

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: "File not found" });
  }

  // Verify file is valid video with ffprobe
  try {
    const { execSync } = require('child_process');
    const duration = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${fullPath}"`, { timeout: 10000 }).toString().trim();
    if (!duration || isNaN(parseFloat(duration)) || parseFloat(duration) < 10) {
      return res.status(400).json({ error: "File appears corrupted or too short" });
    }
  } catch (e) {
    return res.status(400).json({ error: "Cannot read video file - may be corrupted" });
  }

  const filename = path.basename(fullPath);
  const streamId = `local_${crypto.createHash('md5').update(fullPath).digest('hex').substring(0, 12)}`;
  const hlsDir = `/tmp/hls_${streamId}`;

  // Check if already streaming
  if (activeStreams.has(streamId)) {
    const existing = activeStreams.get(streamId);
    if (isStreamActive(existing)) {
      const streamUrl = `/hls/${streamId}.m3u8`;
      if (pushToTv) {
        sseClients.forEach(client => client.write(`data: ${JSON.stringify({ url: streamUrl, name: filename })}\n\n`));
        console.log(`Pushing local HLS to ${sseClients.length} TV(s): ${streamUrl}`);
      }
      return res.json({ hlsUrl: streamUrl, streamId, name: filename, cached: true });
    }
    // Kill old ffmpeg if still hanging
    if (existing.ffmpegProcess && !existing.ffmpegProcess.killed) {
      try { existing.ffmpegProcess.kill(); } catch(e) {}
    }
    activeStreams.delete(streamId);
  }

  // Clean up old HLS directory if exists
  if (fs.existsSync(hlsDir)) {
    try {
      fs.rmSync(hlsDir, { recursive: true, force: true });
    } catch(e) {
      console.error("Failed to clean HLS dir:", e);
    }
  }

  // Create HLS directory
  resetDir(hlsDir);

  console.log(`Starting local file HLS: ${filename}`);

  const ffmpegArgs = [
    "-y",
    "-threads", "0",  // Use all CPU cores
    "-i", fullPath,
    "-c:v", "copy",
    "-c:a", "aac", "-ac", "2", "-ar", "44100", "-b:a", "128k",
    "-f", "hls",
    "-hls_time", "4",
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments",  // Remove delete_segments to keep all for seeking
    "-hls_segment_filename", path.join(hlsDir, "index%d.ts"),
    path.join(hlsDir, "index.m3u8")
  ];

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "ignore", "pipe"] });

  let stderrData = "";
  ffmpeg.stderr.on("data", d => stderrData += d.toString());

  ffmpeg.on("close", code => {
    console.log(`Local HLS ffmpeg completed for ${streamId}, code: ${code}`);
    if (code !== 0) {
      console.error(`ffmpeg failed for ${streamId}, stderr: ${stderrData.slice(-500)}`);
    }
    // Mark stream as inactive
    if (activeStreams.has(streamId)) {
      activeStreams.get(streamId).finished = true;
    }
  });

  activeStreams.set(streamId, {
    hlsDir,
    ffmpegProcess: ffmpeg,
    name: filename,
    type: "local",
    filePath: fullPath,
    startedAt: Date.now(),
    lastUsed: Date.now()
  });

  // Wait for first segment
  let attempts = 0;
  while (attempts < 30) {
    await new Promise(r => setTimeout(r, 500));
    const m3u8 = path.join(hlsDir, "index.m3u8");
    if (fs.existsSync(m3u8) && fs.readFileSync(m3u8, "utf8").includes(".ts")) {
      break;
    }
    attempts++;
  }

  const streamUrl = `/hls/${streamId}.m3u8`;

  if (pushToTv && sseClients.length > 0) {
    console.log(`Pushing local HLS to ${sseClients.length} TV(s): ${streamUrl}`);
    sseClients.forEach(client => client.write(`data: ${JSON.stringify({ url: streamUrl, name: filename })}\n\n`));
  }

  res.json({ hlsUrl: streamUrl, streamId, name: filename });
});

// Seek local HLS stream - restart ffmpeg from position
app.post("/api/local2hls/seek", express.json(), async (req, res) => {
  const { streamId, position } = req.body;
  if (!streamId || position === undefined) {
    return res.status(400).json({ error: "Missing streamId or position" });
  }

  const stream = activeStreams.get(streamId);
  if (!stream || stream.type !== "local") {
    return res.status(404).json({ error: "Stream not found" });
  }

  // Kill current ffmpeg
  if (stream.ffmpegProcess && !stream.ffmpegProcess.killed) {
    stream.ffmpegProcess.kill();
  }

  // Get original file path from hlsDir name
  const hlsDir = stream.hlsDir;

  // Find original file - stored in stream
  const fullPath = stream.filePath;
  if (!fullPath || !fs.existsSync(fullPath)) {
    return res.status(404).json({ error: "Original file not found" });
  }

  // Clear HLS directory
  resetDir(hlsDir);

  console.log(`Seeking local HLS ${streamId} to ${position}s`);

  // Calculate segment number from position
  const segmentDuration = 4;
  const startSegment = Math.floor(position / segmentDuration);

  const ffmpegArgs = [
    "-y",
    "-ss", String(position),  // Seek to position
    "-threads", "0",
    "-i", fullPath,
    "-c:v", "copy",
    "-c:a", "aac", "-ac", "2", "-ar", "44100", "-b:a", "128k",
    "-f", "hls",
    "-hls_time", "4",
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments",
    "-start_number", String(startSegment),
    "-hls_segment_filename", path.join(hlsDir, "index%d.ts"),
    path.join(hlsDir, "index.m3u8")
  ];

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "ignore", "pipe"] });

  ffmpeg.on("close", code => {
    console.log(`Seek ffmpeg completed for ${streamId}, code: ${code}`);
    if (activeStreams.has(streamId)) {
      activeStreams.get(streamId).finished = true;
    }
  });

  stream.ffmpegProcess = ffmpeg;
  stream.seekPosition = position;

  // Wait for first segment
  let attempts = 0;
  while (attempts < 20) {
    await new Promise(r => setTimeout(r, 300));
    const m3u8 = path.join(hlsDir, "index.m3u8");
    if (fs.existsSync(m3u8) && fs.readFileSync(m3u8, "utf8").includes(".ts")) {
      break;
    }
    attempts++;
  }

  res.json({ success: true, position, streamId });
});

// Get storage stats
app.get("/api/storage/stats", (req, res) => {
  const downloadDir = path.join(__dirname, "downloads");
  const hlsDir = path.join(__dirname, "hls");
  const calcSize = (dir) => {
    let size = 0;
    if (fs.existsSync(dir)) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fp = path.join(dir, item);
        const stat = fs.statSync(fp);
        size += stat.isDirectory() ? calcSize(fp) : stat.size;
      }
    }
    return size;
  };
  try {
    const downloads = calcSize(downloadDir);
    const hls = calcSize(hlsDir);
    res.json({
      downloads, hls, total: downloads + hls,
      formatted: {
        downloads: (downloads / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        hls: (hls / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        total: ((downloads + hls) / 1024 / 1024 / 1024).toFixed(2) + ' GB'
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, HOST, async () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
  // Scan for any leftover HLS directories from previous runs
  scanExistingHlsStreams();
  // Restore any interrupted torrent streams
  await restoreTorrentStreams();
});
