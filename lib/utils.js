/**
 * Shared utilities
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Ensure directory exists
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Reset directory (delete and recreate)
 */
function resetDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  ensureDir(dirPath);
}

/**
 * Set no-cache headers
 */
function setNoCacheHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("ETag", `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  res.setHeader("Last-Modified", new Date().toUTCString());
}

/**
 * Send HLS file with proper headers
 */
function sendHlsFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Segment not found");
  }
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

/**
 * Parse infoHash from magnet URI
 */
function parseInfoHashFromMagnet(magnetURI) {
  try {
    if (!magnetURI || !magnetURI.startsWith("magnet:?")) return null;
    const u = new URL(magnetURI);
    const xt = u.searchParams.get("xt");
    if (!xt) return null;
    const mHex = xt.match(/urn:btih:([a-f0-9]{40})/i);
    if (mHex) return mHex[1].toLowerCase();
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Generate stream ID from infoHash and fileIndex
 */
function makeStreamId(infoHash, fileIndex) {
  return `${infoHash}:${fileIndex}`;
}

/**
 * Generate hash-based ID
 */
function hashId(str, prefix = "") {
  const hash = crypto.createHash("md5").update(str).digest("hex").slice(0, 12);
  return prefix ? `${prefix}_${hash}` : hash;
}

module.exports = {
  ensureDir,
  resetDir,
  setNoCacheHeaders,
  sendHlsFile,
  parseInfoHashFromMagnet,
  makeStreamId,
  hashId,
};
