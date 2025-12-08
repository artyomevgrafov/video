/**
 * HLS Streaming Module
 * Handles ffmpeg transcoding to HLS format
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { resetDir, sendHlsFile } = require("./utils");

// Active streams registry
const activeStreams = new Map();

/**
 * Check if stream's ffmpeg process is active
 */
function isStreamActive(entry) {
  if (!entry) return false;
  const proc = entry.ffmpegProcess;
  if (Array.isArray(proc)) {
    return proc.some((p) => p && p.exitCode === null && !p.killed);
  }
  return !!(proc && proc.exitCode === null && !proc.killed);
}

/**
 * Mark stream as recently used
 */
function markStreamUsed(entry) {
  if (entry) entry.lastUsed = Date.now();
}

/**
 * Find stream by ID prefix
 */
function findStreamByPrefix(partialId) {
  for (const [id, entry] of activeStreams.entries()) {
    if (id.startsWith(partialId)) {
      return { id, entry };
    }
  }
  return null;
}

/**
 * Build ffmpeg HLS arguments
 */
function buildHlsArgs(outputPath, baseUrl, opts = {}) {
  const {
    transcodeVideo = false,
    videoEncoder = config.hls.videoCodec,
    videoBitrate = "2500k",
    transcodeAudio = true,
    audioBitrate = "128k",
    scale,
    seekPosition = 0,
  } = opts;

  const args = ["-y", "-hwaccel", "auto"];

  // Seek position (before input for fast seek)
  if (seekPosition > 0) {
    args.push("-ss", String(seekPosition));
  }

  args.push(
    "-probesize", "50M",
    "-analyzeduration", "100M",
    "-fflags", "+genpts+discardcorrupt+igndts",
    "-err_detect", "ignore_err",
    "-i", "pipe:0"
  );

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
    "-max_muxing_queue_size", "4096",
    "-f", "hls",
    "-hls_time", String(config.hls.segmentDuration),
    "-hls_list_size", "0", // Keep all segments
    "-hls_flags", "omit_endlist+append_list+independent_segments",
    "-start_number", "0"
  );

  if (baseUrl) {
    args.push("-hls_base_url", baseUrl);
  }
  args.push(outputPath);
  return args;
}

/**
 * Build ffmpeg args for local file (not piped)
 */
function buildLocalHlsArgs(inputPath, outputPath, opts = {}) {
  const { seekPosition = 0 } = opts;
  const hlsDir = path.dirname(outputPath);

  const args = ["-y"];

  if (seekPosition > 0) {
    args.push("-ss", String(seekPosition));
  }

  args.push(
    "-threads", "0",
    "-i", inputPath,
    // Transcode video with keyframes every 4 seconds for proper segmentation
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
    "-g", "96", // GOP size = 4 sec * 24 fps = 96 frames (keyframe every 4 sec)
    "-keyint_min", "96",
    "-sc_threshold", "0", // Disable scene change detection
    "-c:a", "aac", "-ac", "2", "-ar", "44100", "-b:a", "128k",
    "-f", "hls",
    "-hls_time", String(config.hls.segmentDuration),
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", path.join(hlsDir, "index%d.ts"),
    outputPath
  );

  return args;
}

/**
 * Start HLS stream for a local file
 */
async function startLocalHls(filePath, streamId, hlsDir) {
  // Clean up existing
  if (activeStreams.has(streamId)) {
    const existing = activeStreams.get(streamId);
    if (existing.ffmpegProcess && !existing.ffmpegProcess.killed) {
      try { existing.ffmpegProcess.kill(); } catch (e) {}
    }
    activeStreams.delete(streamId);
  }

  resetDir(hlsDir);

  const filename = path.basename(filePath);
  const outputPath = path.join(hlsDir, "index.m3u8");
  const ffmpegArgs = buildLocalHlsArgs(filePath, outputPath);

  console.log(`[HLS] Starting local stream: ${filename}`);

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderrData = "";
  ffmpeg.stderr.on("data", (d) => (stderrData += d.toString()));

  ffmpeg.on("close", (code) => {
    console.log(`[HLS] ffmpeg completed for ${streamId}, code: ${code}`);
    if (code !== 0) {
      console.error(`[HLS] ffmpeg error: ${stderrData.slice(-500)}`);
    }
    if (activeStreams.has(streamId)) {
      activeStreams.get(streamId).finished = true;
    }
  });

  activeStreams.set(streamId, {
    hlsDir,
    ffmpegProcess: ffmpeg,
    name: filename,
    type: "local",
    filePath,
    startedAt: Date.now(),
    lastUsed: Date.now(),
  });

  // Wait for first segment
  let attempts = 0;
  while (attempts < 30) {
    await new Promise((r) => setTimeout(r, 500));
    const m3u8 = path.join(hlsDir, "index.m3u8");
    if (fs.existsSync(m3u8) && fs.readFileSync(m3u8, "utf8").includes(".ts")) {
      break;
    }
    attempts++;
  }

  return {
    streamId,
    name: filename,
    hlsUrl: `/hls/${streamId}.m3u8`,
  };
}

/**
 * Get stream by ID
 */
function getStream(streamId) {
  return activeStreams.get(streamId);
}

/**
 * Register stream
 */
function registerStream(streamId, data) {
  activeStreams.set(streamId, {
    ...data,
    lastUsed: Date.now(),
  });
}

/**
 * Remove stream
 */
function removeStream(streamId) {
  const entry = activeStreams.get(streamId);
  if (entry) {
    if (entry.ffmpegProcess) {
      try {
        if (Array.isArray(entry.ffmpegProcess)) {
          entry.ffmpegProcess.forEach((p) => {
            try { p.kill("SIGTERM"); } catch (_) {}
          });
        } else {
          entry.ffmpegProcess.kill("SIGTERM");
        }
      } catch (_) {}
    }
    activeStreams.delete(streamId);
  }
}

/**
 * Get all active stream IDs
 */
function getActiveStreamIds() {
  return Array.from(activeStreams.keys());
}

/**
 * Cleanup old streams (called periodically)
 */
function cleanupOldStreams(maxAgeMs = 10 * 60 * 1000) {
  const now = Date.now();
  for (const [id, s] of activeStreams.entries()) {
    if (now - s.lastUsed > maxAgeMs) {
      console.log(`[HLS] Cleaning up old stream: ${id}`);
      removeStream(id);
    }
  }
}

/**
 * Scan /tmp for existing HLS streams on startup
 */
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
        console.log(`[HLS] Registered existing stream: ${streamId}`);
      }
    });
  } catch (err) {
    console.error("[HLS] scanExistingHlsStreams error:", err.message);
  }
}

module.exports = {
  activeStreams,
  isStreamActive,
  markStreamUsed,
  findStreamByPrefix,
  buildHlsArgs,
  buildLocalHlsArgs,
  startLocalHls,
  getStream,
  registerStream,
  removeStream,
  getActiveStreamIds,
  cleanupOldStreams,
  scanExistingHlsStreams,
  sendHlsFile,
};
