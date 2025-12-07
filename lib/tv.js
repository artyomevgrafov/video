/**
 * TV Push/Control Module
 * Handles SSE connections, remote control, and state management
 */

const fs = require("fs");
const path = require("path");

// SSE clients
let sseClients = [];
let remoteClients = [];

// Current play state
let currentPlayUrl = null;
let playerState = {
  currentTime: 0,
  duration: 0,
  paused: true,
  mediaName: null,
  streamId: null,
};

// Watch progress storage
const watchProgress = new Map();

// State persistence file
const TV_STATE_FILE = path.join(__dirname, "..", "tv-state.json");

/**
 * Save TV state to disk
 */
function saveTvState() {
  try {
    if (currentPlayUrl && typeof currentPlayUrl === "object") {
      fs.writeFileSync(TV_STATE_FILE, JSON.stringify(currentPlayUrl, null, 2));
    }
  } catch (err) {
    console.error("[TV] Failed to save state:", err.message);
  }
}

/**
 * Load TV state from disk
 */
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
    console.error("[TV] Failed to load state:", err.message);
  }
  return null;
}

/**
 * Initialize TV state on startup
 */
function init() {
  const saved = loadTvState();
  if (saved) {
    currentPlayUrl = saved;
    console.log("[TV] Restored state:", saved.name || saved.url);
  }
}

/**
 * Get connected TV client count
 */
function getClientCount() {
  return sseClients.length;
}

/**
 * Add SSE client (TV)
 */
function addClient(res) {
  sseClients.push(res);
  console.log(`[TV] Client connected. Total: ${sseClients.length}`);

  // Send current URL immediately if exists
  if (currentPlayUrl) {
    const payload = typeof currentPlayUrl === "object" ? currentPlayUrl : { url: currentPlayUrl };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

/**
 * Remove SSE client
 */
function removeClient(res) {
  sseClients = sseClients.filter((c) => c !== res);
  console.log(`[TV] Client disconnected. Total: ${sseClients.length}`);
}

/**
 * Add remote control client
 */
function addRemoteClient(res) {
  remoteClients.push(res);
  // Send current state immediately
  res.write(`data: ${JSON.stringify(playerState)}\n\n`);
}

/**
 * Remove remote control client
 */
function removeRemoteClient(res) {
  remoteClients = remoteClients.filter((c) => c !== res);
}

/**
 * Broadcast to all TV clients
 */
function broadcast(payload) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  sseClients.forEach((client) => {
    client.write(`data: ${data}\n\n`);
  });
}

/**
 * Broadcast to remote control clients
 */
function broadcastToRemote(payload) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  remoteClients.forEach((client) => {
    client.write(`data: ${data}\n\n`);
  });
}

/**
 * Push URL to all TVs
 */
function pushUrl(data) {
  const { url, name, episodes, streamId, currentIndex, magnetURI } = data;

  currentPlayUrl = {
    url,
    name,
    episodes,
    streamId,
    currentIndex,
    magnetURI,
    savedAt: Date.now(),
  };

  console.log(`[TV] Pushing to ${sseClients.length} TV(s): ${url}`);
  saveTvState();

  broadcast(currentPlayUrl);

  return { success: true, clients: sseClients.length };
}

/**
 * Send control command to TVs
 */
function sendControl(action, value) {
  const payload = { action, value };
  console.log(`[TV] Control: ${action}`, value !== undefined ? value : "");
  broadcast(payload);
  return { success: true, clients: sseClients.length };
}

/**
 * Update player state (from TV report)
 */
function updateState(state) {
  const { currentTime, duration, paused, mediaName, streamId } = state;

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
  broadcastToRemote(playerState);
}

/**
 * Get watch progress for stream
 */
function getProgress(streamId) {
  return watchProgress.get(streamId) || { position: 0 };
}

/**
 * Get current play URL
 */
function getCurrentUrl() {
  return currentPlayUrl;
}

/**
 * Clear current playback
 */
function clear() {
  currentPlayUrl = null;
  broadcast({ url: null, action: "clear" });
}

/**
 * Get player state
 */
function getPlayerState() {
  return playerState;
}

module.exports = {
  init,
  getClientCount,
  addClient,
  removeClient,
  addRemoteClient,
  removeRemoteClient,
  broadcast,
  pushUrl,
  sendControl,
  updateState,
  getProgress,
  getCurrentUrl,
  clear,
  getPlayerState,
};
