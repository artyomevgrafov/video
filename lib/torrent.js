/**
 * Torrent Streaming Module
 * Handles torrent-stream engine management
 */

const fs = require("fs");
const path = require("path");
const torrentStream = require("torrent-stream");
const config = require("./config");
const { parseInfoHashFromMagnet } = require("./utils");

// Torrent engines cache
const torrentEngines = new Map();

// State persistence
const TORRENT_STATE_FILE = path.join(__dirname, "..", "torrent-state.json");

/**
 * Save torrent state for crash recovery
 */
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
    console.error("[Torrent] Failed to save state:", err.message);
  }
}

/**
 * Remove torrent state
 */
function removeTorrentState(streamId) {
  try {
    if (!fs.existsSync(TORRENT_STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(TORRENT_STATE_FILE, "utf8"));
    delete state[streamId];
    fs.writeFileSync(TORRENT_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[Torrent] Failed to remove state:", err.message);
  }
}

/**
 * Load all saved torrent states
 */
function loadTorrentStates() {
  try {
    if (!fs.existsSync(TORRENT_STATE_FILE)) return [];
    const state = JSON.parse(fs.readFileSync(TORRENT_STATE_FILE, "utf8"));
    return Object.values(state);
  } catch (err) {
    console.error("[Torrent] Failed to load states:", err.message);
    return [];
  }
}

/**
 * Get or create torrent engine from magnet
 */
async function getEngine(magnetURI, opts = {}) {
  const infoHash = parseInfoHashFromMagnet(magnetURI);

  // Check if already have engine
  if (infoHash && torrentEngines.has(infoHash)) {
    console.log("[Torrent] Reusing existing engine:", infoHash);
    return torrentEngines.get(infoHash);
  }

  // Create new engine
  return new Promise((resolve, reject) => {
    const engineOpts = {
      path: path.join(__dirname, "..", config.torrent.downloadPath),
      dht: true,
      verify: false,
      trackers: config.torrent.trackers,
    };

    const engine = torrentStream(opts.torrentBuffer || magnetURI, engineOpts);

    const timeout = setTimeout(() => {
      engine.destroy();
      reject(new Error("Torrent timeout - no peers found"));
    }, config.torrent.timeout);

    engine.on("ready", () => {
      clearTimeout(timeout);
      console.log("[Torrent] Ready:", engine.torrent?.name, "files:", engine.files.length);
      torrentEngines.set(engine.infoHash, engine);
      resolve(engine);
    });

    engine.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Get engine by infoHash
 */
function getEngineByHash(infoHash) {
  return torrentEngines.get(infoHash);
}

/**
 * Get all engines
 */
function getAllEngines() {
  return torrentEngines;
}

/**
 * Destroy engine
 */
function destroyEngine(infoHash) {
  const engine = torrentEngines.get(infoHash);
  if (engine) {
    try {
      engine.destroy();
    } catch (e) {}
    torrentEngines.delete(infoHash);
    console.log("[Torrent] Destroyed engine:", infoHash);
  }
}

/**
 * Get video files from engine
 */
function getVideoFiles(engine) {
  return engine.files
    .filter((f) => /\.(mp4|webm|avi|mkv)$/i.test(f.name))
    .map((f) => ({
      name: f.name,
      size: f.length,
      sizeFormatted: (f.length / 1024 / 1024 / 1024).toFixed(2) + " GB",
      index: engine.files.indexOf(f),
    }));
}

/**
 * Select file for download
 */
function selectFile(engine, fileIndex) {
  // Deselect all first
  engine.files.forEach((f) => f.deselect());

  const file = engine.files[fileIndex];
  if (file) {
    file.select();
    file.select(0); // Highest priority
    return file;
  }
  return null;
}

/**
 * Create read stream for file
 */
function createFileStream(engine, fileIndex) {
  const file = engine.files[fileIndex];
  if (!file) return null;
  return file.createReadStream();
}

/**
 * Check if file exists on disk (completed download)
 */
function findFileOnDisk(engine, fileIndex) {
  const file = engine.files[fileIndex];
  if (!file) return null;

  const downloadsDir = path.join(__dirname, "..", config.torrent.downloadPath);
  const torrentName = engine.torrent?.name || "";

  const possiblePaths = [
    path.join(downloadsDir, torrentName, file.name),
    path.join(downloadsDir, torrentName, file.path),
    path.join(downloadsDir, file.path),
  ];

  // Also search in all subdirectories
  if (fs.existsSync(downloadsDir)) {
    try {
      const subdirs = fs.readdirSync(downloadsDir).filter((f) =>
        fs.statSync(path.join(downloadsDir, f)).isDirectory()
      );
      for (const subdir of subdirs) {
        possiblePaths.push(path.join(downloadsDir, subdir, file.name));
      }
    } catch (e) {}
  }

  for (const tryPath of possiblePaths) {
    if (fs.existsSync(tryPath)) {
      const stats = fs.statSync(tryPath);
      // Accept if size matches or > 90% of expected
      if (stats.size === file.length || stats.size > file.length * 0.9) {
        return tryPath;
      }
    }
  }

  return null;
}

/**
 * Get download status for all torrents
 */
function getDownloadsStatus() {
  const downloads = [];
  const seenFolders = new Set();
  const downloadsDir = path.join(__dirname, "..", config.torrent.downloadPath);

  // Active torrent downloads
  for (const [infoHash, engine] of torrentEngines.entries()) {
    const torrentName = engine.torrent?.name || infoHash;
    seenFolders.add(torrentName);

    const files = engine.files
      .filter((f) => f.selected)
      .map((f) => {
        let downloaded = 0;
        try {
          const filePath = path.join(downloadsDir, torrentName, f.name);
          if (fs.existsSync(filePath)) {
            downloaded = fs.statSync(filePath).size;
          }
        } catch (e) {
          downloaded = engine.swarm?.downloaded || 0;
        }

        return {
          name: f.name,
          size: f.length,
          downloaded,
          progress: f.length > 0 ? Math.min(100, Math.round((downloaded / f.length) * 100)) : 0,
        };
      });

    if (files.length > 0) {
      downloads.push({
        infoHash,
        name: torrentName,
        files,
        peers: engine.swarm?.wires?.length || 0,
        downloadSpeed: engine.swarm?.downloadSpeed() || 0,
        active: true,
      });
    }
  }

  // Completed downloads from disk
  try {
    if (fs.existsSync(downloadsDir)) {
      const folders = fs
        .readdirSync(downloadsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !seenFolders.has(d.name));

      for (const folder of folders) {
        const folderPath = path.join(downloadsDir, folder.name);
        const videoExts = [".mp4", ".mkv", ".avi", ".webm", ".mov"];

        const files = fs
          .readdirSync(folderPath)
          .filter((f) => videoExts.some((ext) => f.toLowerCase().endsWith(ext)))
          .map((f) => {
            const filePath = path.join(folderPath, f);
            const stats = fs.statSync(filePath);
            return {
              name: f,
              size: stats.size,
              downloaded: stats.size,
              progress: 100,
              path: filePath,
            };
          });

        if (files.length > 0) {
          downloads.push({
            infoHash: folder.name,
            name: folder.name,
            files,
            peers: 0,
            downloadSpeed: 0,
            active: false,
            completed: true,
          });
        }
      }
    }
  } catch (e) {
    console.error("[Torrent] Error scanning downloads:", e);
  }

  return downloads;
}

module.exports = {
  torrentEngines,
  saveTorrentState,
  removeTorrentState,
  loadTorrentStates,
  getEngine,
  getEngineByHash,
  getAllEngines,
  destroyEngine,
  getVideoFiles,
  selectFile,
  createFileStream,
  findFileOnDisk,
  getDownloadsStatus,
};
