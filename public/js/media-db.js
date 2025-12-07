// ============== MEDIA DATABASE ==============
// IndexedDB for watch history, progress, recommendations

const DB_NAME = 'LanVideoDB';
const DB_VERSION = 1;

class MediaDB {
  constructor() {
    this.db = null;
    this.ready = this.init();
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Watch history - what user has watched
        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id' });
          historyStore.createIndex('watchedAt', 'watchedAt');
          historyStore.createIndex('type', 'type'); // movie, series, youtube
          historyStore.createIndex('title', 'title');
        }

        // Watch progress - position in each video
        if (!db.objectStoreNames.contains('progress')) {
          const progressStore = db.createObjectStore('progress', { keyPath: 'id' });
          progressStore.createIndex('updatedAt', 'updatedAt');
          progressStore.createIndex('completed', 'completed');
        }

        // Series tracking - episodes watched per series
        if (!db.objectStoreNames.contains('series')) {
          const seriesStore = db.createObjectStore('series', { keyPath: 'infoHash' });
          seriesStore.createIndex('title', 'title');
          seriesStore.createIndex('lastWatched', 'lastWatched');
        }

        // Recommendations cache
        if (!db.objectStoreNames.contains('recommendations')) {
          const recStore = db.createObjectStore('recommendations', { keyPath: 'id' });
          recStore.createIndex('basedOn', 'basedOn');
          recStore.createIndex('score', 'score');
        }

        // Download queue for prefetching
        if (!db.objectStoreNames.contains('downloadQueue')) {
          const queueStore = db.createObjectStore('downloadQueue', { keyPath: 'id', autoIncrement: true });
          queueStore.createIndex('priority', 'priority');
          queueStore.createIndex('status', 'status');
        }

        // User preferences
        if (!db.objectStoreNames.contains('preferences')) {
          db.createObjectStore('preferences', { keyPath: 'key' });
        }

        // Network stats for bandwidth-based filtering
        if (!db.objectStoreNames.contains('networkStats')) {
          const netStore = db.createObjectStore('networkStats', { keyPath: 'id', autoIncrement: true });
          netStore.createIndex('timestamp', 'timestamp');
        }
      };
    });
  }

  // ============== HISTORY ==============
  async addToHistory(item) {
    await this.ready;
    const entry = {
      id: item.id || this.generateId(item.url || item.magnetURI),
      url: item.url,
      magnetURI: item.magnetURI,
      title: item.title || item.name,
      type: item.type || 'unknown',
      thumbnail: item.thumbnail,
      duration: item.duration,
      watchedAt: Date.now(),
      metadata: item.metadata || {}
    };

    return this.put('history', entry);
  }

  async getHistory(limit = 50) {
    await this.ready;
    return this.getAllByIndex('history', 'watchedAt', null, limit, 'prev');
  }

  async clearOldHistory(daysOld = 30) {
    await this.ready;
    const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    const tx = this.db.transaction('history', 'readwrite');
    const store = tx.objectStore('history');
    const index = store.index('watchedAt');

    const range = IDBKeyRange.upperBound(cutoff);
    let cursor = await this.cursorRequest(index.openCursor(range));
    let deleted = 0;

    while (cursor) {
      cursor.delete();
      deleted++;
      cursor = await this.cursorRequest(cursor.continue());
    }

    return deleted;
  }

  // ============== PROGRESS ==============
  async saveProgress(id, position, duration, metadata = {}) {
    await this.ready;
    const completed = duration > 0 && position / duration > 0.9;

    return this.put('progress', {
      id,
      position,
      duration,
      completed,
      percentage: duration > 0 ? Math.round(position / duration * 100) : 0,
      updatedAt: Date.now(),
      ...metadata
    });
  }

  async getProgress(id) {
    await this.ready;
    return this.get('progress', id);
  }

  async getIncomplete(limit = 20) {
    await this.ready;
    const all = await this.getAllByIndex('progress', 'completed', false, limit);
    return all.filter(p => p.percentage > 5 && p.percentage < 90);
  }

  async getAllProgress() {
    await this.ready;
    return this.getAllByIndex('progress', 'updatedAt', null, 100, 'prev');
  }

  async getAllSeries() {
    await this.ready;
    return this.getAllByIndex('series', 'lastWatched', null, 100, 'prev');
  }

  // ============== SERIES TRACKING ==============
  async updateSeries(infoHash, data) {
    await this.ready;
    const existing = await this.get('series', infoHash) || {
      infoHash,
      watchedEpisodes: [],
      totalEpisodes: 0,
      createdAt: Date.now()
    };

    const updated = {
      ...existing,
      ...data,
      lastWatched: Date.now()
    };

    // Track watched episodes
    if (data.currentEpisode !== undefined) {
      if (!updated.watchedEpisodes.includes(data.currentEpisode)) {
        updated.watchedEpisodes.push(data.currentEpisode);
      }
    }

    return this.put('series', updated);
  }

  async getSeries(infoHash) {
    await this.ready;
    return this.get('series', infoHash);
  }

  async getWatchingSeries(limit = 10) {
    await this.ready;
    const all = await this.getAllByIndex('series', 'lastWatched', null, limit, 'prev');
    // Filter to only incomplete series
    return all.filter(s => s.watchedEpisodes.length < s.totalEpisodes);
  }

  async getCompletedEpisodes(infoHash) {
    await this.ready;
    const series = await this.get('series', infoHash);
    return series?.watchedEpisodes || [];
  }

  // ============== NETWORK STATS ==============
  async recordNetworkSpeed(downloadSpeed, uploadSpeed) {
    await this.ready;
    return this.put('networkStats', {
      id: Date.now(),
      timestamp: Date.now(),
      downloadSpeed, // bytes per second
      uploadSpeed
    });
  }

  async getAverageSpeed(lastMinutes = 10) {
    await this.ready;
    const cutoff = Date.now() - (lastMinutes * 60 * 1000);
    const stats = await this.getAllByIndex('networkStats', 'timestamp', IDBKeyRange.lowerBound(cutoff));

    if (stats.length === 0) return null;

    const avgDownload = stats.reduce((sum, s) => sum + s.downloadSpeed, 0) / stats.length;
    const avgUpload = stats.reduce((sum, s) => sum + s.uploadSpeed, 0) / stats.length;

    return {
      downloadSpeed: avgDownload,
      uploadSpeed: avgUpload,
      samples: stats.length,
      // Recommended max bitrate (80% of speed for buffer)
      recommendedBitrate: Math.floor(avgDownload * 0.8 * 8 / 1000000), // Mbps
      quality: this.speedToQuality(avgDownload)
    };
  }

  speedToQuality(bytesPerSecond) {
    const mbps = bytesPerSecond * 8 / 1000000;
    if (mbps >= 25) return '4K';
    if (mbps >= 10) return '1080p';
    if (mbps >= 5) return '720p';
    if (mbps >= 2) return '480p';
    return '360p';
  }

  // ============== DOWNLOAD QUEUE ==============
  async addToDownloadQueue(item) {
    await this.ready;
    return this.put('downloadQueue', {
      ...item,
      status: 'pending',
      priority: item.priority || 5,
      addedAt: Date.now()
    });
  }

  async getDownloadQueue() {
    await this.ready;
    const all = await this.getAllByIndex('downloadQueue', 'status', 'pending');
    return all.sort((a, b) => b.priority - a.priority);
  }

  async updateDownloadStatus(id, status, progress = 0) {
    await this.ready;
    const item = await this.get('downloadQueue', id);
    if (item) {
      item.status = status;
      item.progress = progress;
      item.updatedAt = Date.now();
      return this.put('downloadQueue', item);
    }
  }

  // ============== PREFERENCES ==============
  async setPref(key, value) {
    await this.ready;
    return this.put('preferences', { key, value, updatedAt: Date.now() });
  }

  async getPref(key, defaultValue = null) {
    await this.ready;
    const pref = await this.get('preferences', key);
    return pref?.value ?? defaultValue;
  }

  // ============== RECOMMENDATIONS ==============
  async addRecommendation(rec) {
    await this.ready;
    return this.put('recommendations', {
      id: rec.id || this.generateId(rec.magnetURI || rec.url),
      ...rec,
      addedAt: Date.now()
    });
  }

  async getRecommendations(limit = 20) {
    await this.ready;
    return this.getAllByIndex('recommendations', 'score', null, limit, 'prev');
  }

  // ============== AI HELPERS ==============
  async getWatchPatterns() {
    await this.ready;
    const history = await this.getHistory(100);

    // Analyze patterns
    const genres = {};
    const hours = new Array(24).fill(0);
    const days = new Array(7).fill(0);

    history.forEach(item => {
      const date = new Date(item.watchedAt);
      hours[date.getHours()]++;
      days[date.getDay()]++;

      if (item.metadata?.genre) {
        genres[item.metadata.genre] = (genres[item.metadata.genre] || 0) + 1;
      }
    });

    return {
      totalWatched: history.length,
      preferredHours: hours.map((count, hour) => ({ hour, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        .map(h => h.hour),
      preferredDays: days.map((count, day) => ({ day, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)
        .map(d => d.day),
      topGenres: Object.entries(genres)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([genre]) => genre)
    };
  }

  // ============== CLEANUP ==============
  async cleanupWatched(infoHash) {
    // Mark series episodes for deletion from disk
    const series = await this.getSeries(infoHash);
    if (!series) return [];

    return series.watchedEpisodes;
  }

  async cleanupOldData() {
    await this.ready;

    // Clean old history (30 days)
    const historyDeleted = await this.clearOldHistory(30);

    // Clean old network stats (1 day)
    const netCutoff = Date.now() - (24 * 60 * 60 * 1000);
    const tx = this.db.transaction('networkStats', 'readwrite');
    const store = tx.objectStore('networkStats');
    const index = store.index('timestamp');
    const range = IDBKeyRange.upperBound(netCutoff);

    let cursor = await this.cursorRequest(index.openCursor(range));
    let netDeleted = 0;
    while (cursor) {
      cursor.delete();
      netDeleted++;
      cursor = await this.cursorRequest(cursor.continue());
    }

    return { historyDeleted, netDeleted };
  }

  // ============== UTILITY ==============
  generateId(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return 'id_' + Math.abs(hash).toString(36);
  }

  async get(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async put(storeName, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const request = tx.objectStore(storeName).put(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async delete(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const request = tx.objectStore(storeName).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getAllByIndex(storeName, indexName, query = null, limit = 100, direction = 'next') {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = indexName ? store.index(indexName) : store;
      const results = [];

      const request = index.openCursor(query, direction);
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  cursorRequest(request) {
    return new Promise((resolve, reject) => {
      if (!request) {
        resolve(null);
        return;
      }
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

// Singleton instance
const mediaDB = new MediaDB();

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MediaDB, mediaDB };
}
