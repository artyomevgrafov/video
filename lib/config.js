/**
 * Server Configuration
 * Toggle features on/off for debugging and isolation
 */

module.exports = {
  // Core features (always on)
  core: {
    port: process.env.PORT || 8081,
    host: process.env.HOST || "0.0.0.0",
  },

  // Feature toggles - set to false to disable
  features: {
    // Torrent streaming (torrent-stream, webtorrent)
    torrents: true,

    // HLS transcoding (ffmpeg)
    hls: true,

    // TV push/remote control (SSE)
    tvPush: true,

    // YouTube/yt-dlp integration
    ytdlp: true,

    // Push notifications (web-push)
    pushNotifications: true,

    // Background quality switching
    smartQuality: true,

    // Torrent crash recovery
    torrentRecovery: true,

    // Search APIs (YouTube, torrents)
    search: true,
  },

  // HLS settings
  hls: {
    segmentDuration: 4,
    videoCodec: process.env.HLS_VIDEO_CODEC || "libx264",
    // Keep all segments (no deletion) for reliable seeking
    keepAllSegments: true,
  },

  // Torrent settings
  torrent: {
    downloadPath: "downloads",
    timeout: 90000,
    trackers: [
      "udp://tracker.opentrackr.org:1337/announce",
      "udp://open.stealth.si:80/announce",
      "udp://tracker.torrent.eu.org:451/announce",
      "udp://tracker.bittor.pw:1337/announce",
      "udp://public.popcorn-tracker.org:6969/announce",
      "udp://tracker.dler.org:6969/announce",
      "udp://exodus.desync.com:6969/announce",
      "udp://open.demonii.com:1337/announce",
      "udp://tracker.openbittorrent.com:6969/announce",
      "http://bt.t-ru.org/ann?magnet",
    ],
  },

  // Logging
  logging: {
    enabled: true,
    dir: "logs",
    httpLogging: true,
  },
};
