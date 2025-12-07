/**
 * LAN Video Streaming Server - Clean Version
 * Modular architecture with toggleable features
 */

const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Load modules
const config = require("./lib/config");
const utils = require("./lib/utils");
const hls = require("./lib/hls");
const tv = require("./lib/tv");
const torrent = require("./lib/torrent");

// --- Logging setup ---
const LOG_DIR = path.join(__dirname, config.logging.dir);
const LOG_FILE = path.join(LOG_DIR, "server.log");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const fileLogger = config.logging.enabled
  ? fs.createWriteStream(LOG_FILE, { flags: "a" })
  : null;

function writeLogLine(level, args) {
  if (!fileLogger || fileLogger.destroyed) return;
  const time = new Date().toISOString();
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  fileLogger.write(`[${time}] [${level.toUpperCase()}] ${msg}\n`);
}

if (config.logging.enabled) {
  ["log", "info", "warn", "error"].forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      writeLogLine(level, args);
      original(...args);
    };
  });
}

// --- Express setup ---
const app = express();
const { port: PORT, host: HOST } = config.core;

app.disable("etag");
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use("/downloads", express.static(path.join(__dirname, "downloads")));

if (config.logging.httpLogging) {
  app.use(morgan(":method :url :status :response-time ms"));
}

// --- Torrent scrapers (optional) ---
let torrentScrapers = null;
if (config.features.search) {
  try {
    torrentScrapers = require("./scrapers/simple-torrent-search");
    console.log("Torrent scrapers loaded");
  } catch (e) {
    console.warn("Torrent scrapers not available");
  }
}

// --- yt-dlp path ---
const YTDLP_PATH = (() => {
  try {
    return execSync("which yt-dlp 2>/dev/null || echo ~/.local/bin/yt-dlp").toString().trim();
  } catch (_) {
    return "yt-dlp";
  }
})();

// ============================================================
// CORE ROUTES (always enabled)
// ============================================================

app.get("/play", (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");
  res.redirect(`/player.html?url=${encodeURIComponent(target)}`);
});

app.get("/whoami", (req, res) => {
  res.json({ ip: req.ip || req.connection.remoteAddress });
});

app.get("/api/share", (req, res) => {
  const urlParam = req.query.url;
  if (!urlParam) return res.status(400).json({ error: "Missing url" });
  const host = req.get("host");
  const link = `${req.protocol}://${host}/player.html?url=${encodeURIComponent(urlParam)}`;
  res.json({ link });
});

// ============================================================
// TV PUSH/CONTROL (toggleable)
// ============================================================

if (config.features.tvPush) {
  tv.init();

  app.get("/tv/listen", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    tv.addClient(res);
    req.on("close", () => tv.removeClient(res));
  });

  app.get("/tv/clients", (req, res) => {
    res.json({ clients: tv.getClientCount() });
  });

  app.post("/tv/push", (req, res) => {
    const { url, name, episodes, streamId, currentIndex, magnetURI } = req.body;
    if (!url) return res.status(400).json({ error: "Missing url" });
    const result = tv.pushUrl({ url, name, episodes, streamId, currentIndex, magnetURI });
    res.json(result);
  });

  app.get("/tv/current", (req, res) => {
    const current = tv.getCurrentUrl();
    res.json(current || {});
  });

  app.post("/tv/clear", (req, res) => {
    tv.clear();
    res.json({ success: true });
  });

  app.post("/tv/control", (req, res) => {
    const { action, value } = req.body;
    if (!action) return res.status(400).json({ error: "Missing action" });
    const result = tv.sendControl(action, value);
    res.json(result);
  });

  app.post("/tv/state", (req, res) => {
    tv.updateState(req.body);
    res.json({ success: true });
  });

  app.get("/tv/progress/:streamId", (req, res) => {
    res.json(tv.getProgress(req.params.streamId));
  });

  app.get("/tv/remote", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    tv.addRemoteClient(res);
    req.on("close", () => tv.removeRemoteClient(res));
  });

  console.log("[Feature] TV Push enabled");
}

// ============================================================
// HLS STREAMING (toggleable)
// ============================================================

if (config.features.hls) {
  // Serve HLS segments
  app.get("/hls/:file(index\\d+\\.ts)", (req, res) => {
    const file = req.params.file;
    for (const [streamId, entry] of hls.activeStreams.entries()) {
      const filePath = path.join(entry.hlsDir, file);
      if (fs.existsSync(filePath)) {
        hls.markStreamUsed(entry);
        return hls.sendHlsFile(res, filePath);
      }
    }
    res.status(404).send("Segment not found");
  });

  app.get("/hls/:id/:file", (req, res) => {
    const found = hls.findStreamByPrefix(req.params.id);
    if (!found) return res.status(404).send("Not found");
    hls.markStreamUsed(found.entry);
    const filePath = path.join(found.entry.hlsDir, req.params.file);
    if (!fs.existsSync(filePath)) return res.status(404).send("Segment not found");
    hls.sendHlsFile(res, filePath);
  });

  app.get("/hls/:id.m3u8", async (req, res) => {
    const found = hls.findStreamByPrefix(req.params.id);
    if (!found) return res.status(404).send("Not found");
    hls.markStreamUsed(found.entry);
    const filePath = path.join(found.entry.hlsDir, "index.m3u8");

    // Wait for playlist
    let attempts = 0;
    while (!fs.existsSync(filePath) && attempts < 60) {
      await new Promise((r) => setTimeout(r, 500));
      attempts++;
    }

    if (!fs.existsSync(filePath)) {
      return res.status(503).send("Stream not ready");
    }
    hls.sendHlsFile(res, filePath);
  });

  // Local file to HLS
  app.post("/api/local2hls", async (req, res) => {
    const { filePath: inputPath, pushToTv = true } = req.body;
    if (!inputPath) return res.status(400).json({ error: "Missing filePath" });

    let fullPath = inputPath;
    if (inputPath.startsWith("/downloads/")) {
      fullPath = path.join(__dirname, inputPath);
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "File not found" });
    }

    // Validate video file
    try {
      const duration = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${fullPath}"`,
        { timeout: 10000 }
      ).toString().trim();
      if (!duration || isNaN(parseFloat(duration)) || parseFloat(duration) < 10) {
        return res.status(400).json({ error: "File appears corrupted" });
      }
    } catch (e) {
      return res.status(400).json({ error: "Cannot read video file" });
    }

    const streamId = `local_${utils.hashId(fullPath)}`;
    const hlsDir = `/tmp/hls_${streamId}`;

    // Check existing
    const existing = hls.getStream(streamId);
    if (existing && hls.isStreamActive(existing)) {
      const streamUrl = `/hls/${streamId}.m3u8`;
      if (pushToTv && config.features.tvPush) {
        tv.broadcast({ url: streamUrl, name: path.basename(fullPath) });
      }
      return res.json({ hlsUrl: streamUrl, streamId, name: path.basename(fullPath), cached: true });
    }

    const result = await hls.startLocalHls(fullPath, streamId, hlsDir);

    if (pushToTv && config.features.tvPush && tv.getClientCount() > 0) {
      tv.broadcast({ url: result.hlsUrl, name: result.name });
    }

    res.json(result);
  });

  // Seek local HLS - restart ffmpeg from position
  app.post("/api/local2hls/seek", async (req, res) => {
    const { streamId, position } = req.body;
    if (!streamId || position === undefined) {
      return res.status(400).json({ error: "Missing streamId or position" });
    }

    const stream = hls.getStream(streamId);
    if (!stream || stream.type !== "local") {
      return res.status(404).json({ error: "Stream not found" });
    }

    const fullPath = stream.filePath;
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ error: "Original file not found" });
    }

    // Kill current ffmpeg
    if (stream.ffmpegProcess && !stream.ffmpegProcess.killed) {
      stream.ffmpegProcess.kill();
    }

    const hlsDir = stream.hlsDir;
    utils.resetDir(hlsDir);

    console.log(`[HLS] Seeking ${streamId} to ${position}s`);

    const segmentDuration = 4;
    const startSegment = Math.floor(position / segmentDuration);

    // Use transcoding for seek (copy doesn't work well with seek)
    const ffmpegArgs = [
      "-y",
      "-ss", String(position),
      "-threads", "0",
      "-i", fullPath,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
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

    ffmpeg.on("close", (code) => {
      console.log(`[HLS] Seek ffmpeg completed: ${streamId}, code: ${code}`);
    });

    stream.ffmpegProcess = ffmpeg;
    stream.seekPosition = position;

    // Wait for first segment
    let attempts = 0;
    while (attempts < 20) {
      await new Promise((r) => setTimeout(r, 300));
      const m3u8 = path.join(hlsDir, "index.m3u8");
      if (fs.existsSync(m3u8) && fs.readFileSync(m3u8, "utf8").includes(".ts")) {
        break;
      }
      attempts++;
    }

    res.json({ success: true, position, streamId });
  });

  // Debug endpoints
  app.get("/debug/streams", (req, res) => {
    res.json({ streams: hls.getActiveStreamIds() });
  });

  // Cleanup old streams periodically
  setInterval(() => hls.cleanupOldStreams(), 60 * 1000);

  console.log("[Feature] HLS Streaming enabled");
}

// ============================================================
// TORRENT STREAMING (toggleable)
// ============================================================

if (config.features.torrents) {
  // Preview torrent files
  app.post("/api/torrent/preview", async (req, res) => {
    const { magnet } = req.body;
    if (!magnet) return res.status(400).json({ error: "Missing magnet" });

    try {
      const engine = await torrent.getEngine(magnet);
      const videoFiles = torrent.getVideoFiles(engine);
      res.json({
        infoHash: engine.infoHash,
        name: engine.torrent?.name,
        files: videoFiles,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download specific files
  app.post("/api/torrent/download", async (req, res) => {
    const { magnet, fileIndexes } = req.body;
    if (!magnet || !fileIndexes) {
      return res.status(400).json({ error: "Missing magnet or fileIndexes" });
    }

    const infoHash = utils.parseInfoHashFromMagnet(magnet);
    const engine = torrent.getEngineByHash(infoHash);
    if (!engine) {
      return res.status(400).json({ error: "Call /api/torrent/preview first" });
    }

    const selectedFiles = [];
    engine.files.forEach((f) => f.deselect());

    for (const idx of fileIndexes) {
      const file = engine.files[idx];
      if (file) {
        file.select();
        const stream = file.createReadStream();
        stream.on("error", () => {});
        stream.resume();
        selectedFiles.push({ name: file.name, index: idx, size: file.length });
      }
    }

    console.log(`[Torrent] Starting download of ${selectedFiles.length} files`);
    res.json({ success: true, infoHash: engine.infoHash, downloading: selectedFiles });
  });

  // Download status
  app.get("/api/downloads/status", (req, res) => {
    res.json(torrent.getDownloadsStatus());
  });

  // Stop download
  app.post("/api/torrent/stop/:infoHash", (req, res) => {
    const { infoHash } = req.params;
    if (!torrent.getEngineByHash(infoHash)) {
      return res.status(404).json({ error: "Torrent not found" });
    }
    torrent.destroyEngine(infoHash);
    res.json({ success: true });
  });

  // Stream torrent to HLS
  app.post("/api/torrent2mp4", async (req, res) => {
    const { url: magnetUrl, fileIndex: requestedFileIndex } = req.body;
    if (!magnetUrl) return res.status(400).json({ error: "Missing url" });

    try {
      const engine = await torrent.getEngine(magnetUrl);
      const videoFiles = torrent.getVideoFiles(engine);

      if (videoFiles.length === 0) {
        throw new Error("No video files in torrent");
      }

      const fileIndex = typeof requestedFileIndex === "number" ? requestedFileIndex : videoFiles[0].index;
      const selectedFile = engine.files[fileIndex];
      if (!selectedFile) throw new Error("Invalid file index");

      const streamId = `ts_${engine.infoHash}_${fileIndex}`;
      const hlsDir = `/tmp/hls_${streamId}`;

      // Check existing
      const existing = hls.getStream(streamId);
      if (existing && hls.isStreamActive(existing)) {
        existing.lastUsed = Date.now();
        return res.json({
          streamId,
          name: existing.name,
          streamUrl: `/hls/${streamId}.m3u8`,
          videoFiles,
        });
      }

      // Setup HLS
      utils.resetDir(hlsDir);
      torrent.selectFile(engine, fileIndex);

      // Check if file is on disk
      const diskPath = torrent.findFileOnDisk(engine, fileIndex);

      const ffmpegArgs = hls.buildHlsArgs(
        path.join(hlsDir, "index.m3u8"),
        `/hls/${streamId}/`
      );

      console.log(`[Torrent] Starting HLS: ${selectedFile.name}`);

      const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
        stdio: ["pipe", "ignore", "pipe"],
      });

      ffmpeg.stdin.on("error", () => {});

      // Use disk file if available, otherwise torrent stream
      let fileStream;
      if (diskPath) {
        console.log(`[Torrent] Using cached file: ${diskPath}`);
        fileStream = fs.createReadStream(diskPath);
      } else {
        fileStream = selectedFile.createReadStream();
      }

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

      fileStream.on("error", (err) => {
        console.error(`[Torrent] Stream error: ${err.message}`);
        setTimeout(() => {
          if (ffmpeg.stdin && !ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
        }, 3000);
      });

      ffmpeg.on("close", (code) => {
        console.log(`[Torrent] ffmpeg completed: ${streamId}, code: ${code}`);
      });

      hls.registerStream(streamId, {
        engine,
        fileIndex,
        hlsDir,
        ffmpegProcess: ffmpeg,
        name: selectedFile.name,
        magnetURI: magnetUrl,
      });

      torrent.saveTorrentState(engine.infoHash, magnetUrl, fileIndex, streamId);

      res.json({
        streamId,
        name: selectedFile.name,
        streamUrl: `/hls/${streamId}.m3u8`,
        videoFiles,
      });
    } catch (err) {
      console.error("[Torrent] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log("[Feature] Torrent Streaming enabled");
}

// ============================================================
// SEARCH APIs (toggleable)
// ============================================================

if (config.features.search && torrentScrapers) {
  app.get("/api/search/torrents", async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Missing query" });

    try {
      const source = req.query.source;
      let results = [];

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
          results = await torrentScrapers.searchAll(query);
      }

      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log("[Feature] Search APIs enabled");
}

// ============================================================
// yt-dlp integration (toggleable)
// ============================================================

if (config.features.ytdlp) {
  function extractWithYtdlp(url) {
    return new Promise((resolve, reject) => {
      const proc = spawn(YTDLP_PATH, ["-j", "--no-warnings", "--no-playlist", url]);
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d) => (stdout += d));
      proc.stderr.on("data", (d) => (stderr += d));

      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(stderr || "yt-dlp failed"));
        try {
          const info = JSON.parse(stdout);
          resolve({
            title: info.title || "Video",
            duration: info.duration,
            thumbnail: info.thumbnail,
            url: info.url,
            extractor: info.extractor,
          });
        } catch (e) {
          reject(new Error("Failed to parse yt-dlp output"));
        }
      });
    });
  }

  app.get("/api/extract", async (req, res) => {
    const inputUrl = req.query.url;
    if (!inputUrl) return res.status(400).json({ error: "Missing url" });

    try {
      const result = await extractWithYtdlp(inputUrl);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/detect", async (req, res) => {
    const inputUrl = req.query.url;
    if (!inputUrl) return res.status(400).json({ error: "Missing url" });

    const lower = inputUrl.toLowerCase();

    if (inputUrl.startsWith("magnet:"))
      return res.json({ type: "torrent", method: "webtorrent" });
    if (lower.endsWith(".mp4") || lower.endsWith(".webm"))
      return res.json({ type: "video", method: "direct" });
    if (lower.endsWith(".m3u8"))
      return res.json({ type: "stream", method: "hls" });
    if (/youtube\.com|youtu\.be/.test(lower))
      return res.json({ type: "youtube", method: "yt-dlp" });

    try {
      const info = await extractWithYtdlp(inputUrl);
      return res.json({ type: "video", method: "yt-dlp", title: info.title });
    } catch (_) {
      return res.json({ type: "website", method: "iframe" });
    }
  });

  console.log("[Feature] yt-dlp integration enabled");
}

// ============================================================
// STORAGE & UTILITY APIs
// ============================================================

// Storage stats
app.get("/api/storage/stats", (req, res) => {
  const downloadDir = path.join(__dirname, "downloads");

  const calcSize = (dir) => {
    let size = 0;
    if (fs.existsSync(dir)) {
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const fp = path.join(dir, item);
          const stat = fs.statSync(fp);
          size += stat.isDirectory() ? calcSize(fp) : stat.size;
        }
      } catch (e) {}
    }
    return size;
  };

  try {
    const downloads = calcSize(downloadDir);
    const hlsSize = calcSize("/tmp");
    res.json({
      downloads,
      hls: hlsSize,
      total: downloads + hlsSize,
      formatted: {
        downloads: (downloads / 1024 / 1024 / 1024).toFixed(2) + " GB",
        hls: (hlsSize / 1024 / 1024 / 1024).toFixed(2) + " GB",
        total: ((downloads + hlsSize) / 1024 / 1024 / 1024).toFixed(2) + " GB",
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy endpoint
app.get("/proxy", (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");

  let parsed;
  try {
    parsed = new URL(target);
  } catch (err) {
    return res.status(400).send("Invalid URL");
  }

  const http = require("http");
  const https = require("https");
  const protocol = parsed.protocol === "https:" ? https : http;

  const options = { method: "GET", headers: {} };
  if (req.headers.range) options.headers.range = req.headers.range;

  const proxyReq = protocol.request(parsed, options, (proxyRes) => {
    ["content-type", "content-length", "accept-ranges", "content-range"].forEach((h) => {
      if (proxyRes.headers[h]) res.setHeader(h, proxyRes.headers[h]);
    });
    res.statusCode = proxyRes.statusCode;
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message);
    res.status(502).send("Bad gateway");
  });

  proxyReq.end();
});

// Torrent to magnet converter
app.get("/api/torrent2magnet", async (req, res) => {
  const torrentUrl = req.query.url;
  if (!torrentUrl) return res.status(400).json({ error: "Missing url" });

  try {
    const bencodeModule = await import("bencode");
    const { decode, encode } = bencodeModule.default;

    const response = await fetch(torrentUrl);
    if (!response.ok) throw new Error("Failed to fetch torrent file");

    const buffer = Buffer.from(await response.arrayBuffer());
    const torrentData = decode(buffer);

    const infoBuffer = encode(torrentData.info);
    const infoHash = crypto.createHash("sha1").update(infoBuffer).digest("hex");

    const toStr = (val) => {
      if (!val) return "";
      if (typeof val === "string") return val;
      if (Buffer.isBuffer(val)) return val.toString("utf8");
      if (val instanceof Uint8Array) return Buffer.from(val).toString("utf8");
      return String(val);
    };

    const name = toStr(torrentData.info.name) || "Unknown";
    const trackers = [];

    if (torrentData["announce-list"]) {
      torrentData["announce-list"].forEach((tier) => {
        tier.forEach((t) => trackers.push(toStr(t)));
      });
    } else if (torrentData.announce) {
      trackers.push(toStr(torrentData.announce));
    }

    let magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
    trackers.forEach((tr) => {
      magnet += `&tr=${encodeURIComponent(tr)}`;
    });

    res.json({ magnet, name, infoHash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, HOST, () => {
  console.log(`\n=================================`);
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log(`=================================\n`);

  // Initialize modules
  if (config.features.hls) {
    hls.scanExistingHlsStreams();
  }

  // Show enabled features
  console.log("Enabled features:");
  Object.entries(config.features).forEach(([key, enabled]) => {
    console.log(`  ${key}: ${enabled ? "ON" : "OFF"}`);
  });
});
