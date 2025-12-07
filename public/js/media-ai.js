// AI Media Assistant
// Provides smart recommendations, network-based quality filtering, and auto-cleanup

class MediaAI {
  constructor(db) {
    this.db = db;
    this.networkSpeed = 0;
    this.isMonitoring = false;
    this.speedHistory = [];
    this.maxHistorySize = 10;
  }

  // Start monitoring network speed
  startNetworkMonitoring() {
    if (this.isMonitoring) return;
    this.isMonitoring = true;
    this.measureSpeed();
    // Measure every 30 seconds
    this.monitorInterval = setInterval(() => this.measureSpeed(), 30000);
  }

  stopNetworkMonitoring() {
    this.isMonitoring = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
  }

  // Measure network speed using a small test
  async measureSpeed() {
    try {
      const testUrl = '/api/storage/stats'; // Small endpoint for speed test
      const startTime = performance.now();
      const response = await fetch(testUrl + '?t=' + Date.now());
      const data = await response.text();
      const endTime = performance.now();

      const duration = (endTime - startTime) / 1000; // seconds
      const bytes = data.length;
      const speedBps = bytes / duration;

      // This is a rough estimate, actual video bandwidth will be different
      // We'll use connection API if available for better estimate
      if (navigator.connection) {
        const conn = navigator.connection;
        if (conn.downlink) {
          // downlink is in Mbps
          this.networkSpeed = conn.downlink * 1000000 / 8; // Convert to bytes/sec
        }
      } else {
        // Fallback: estimate based on small request (very rough)
        // Assume actual bandwidth is much higher than measured
        this.networkSpeed = speedBps * 100;
      }

      this.speedHistory.push(this.networkSpeed);
      if (this.speedHistory.length > this.maxHistorySize) {
        this.speedHistory.shift();
      }

      // Save to DB
      if (this.db) {
        await this.db.recordNetworkSpeed(this.networkSpeed);
      }

      return this.networkSpeed;
    } catch (e) {
      console.warn('Speed measurement failed:', e);
      return this.networkSpeed;
    }
  }

  // Get average speed from history
  getAverageSpeed() {
    if (this.speedHistory.length === 0) return this.networkSpeed;
    const sum = this.speedHistory.reduce((a, b) => a + b, 0);
    return sum / this.speedHistory.length;
  }

  // Get recommended quality based on network speed
  getRecommendedQuality() {
    const speedMbps = this.getAverageSpeed() / (1000000 / 8);

    if (speedMbps >= 25) return { quality: '4K', minBitrate: 15000, maxBitrate: 50000 };
    if (speedMbps >= 10) return { quality: '1080p', minBitrate: 5000, maxBitrate: 15000 };
    if (speedMbps >= 5) return { quality: '720p', minBitrate: 2500, maxBitrate: 5000 };
    if (speedMbps >= 2) return { quality: '480p', minBitrate: 1000, maxBitrate: 2500 };
    return { quality: '360p', minBitrate: 500, maxBitrate: 1000 };
  }

  // Parse quality from torrent name
  parseQualityFromName(name) {
    const lowerName = name.toLowerCase();

    if (lowerName.includes('2160p') || lowerName.includes('4k') || lowerName.includes('uhd')) {
      return { quality: '4K', estimatedBitrate: 25000 };
    }
    if (lowerName.includes('1080p') || lowerName.includes('fullhd') || lowerName.includes('full hd')) {
      return { quality: '1080p', estimatedBitrate: 8000 };
    }
    if (lowerName.includes('720p') || lowerName.includes('hd')) {
      return { quality: '720p', estimatedBitrate: 4000 };
    }
    if (lowerName.includes('480p') || lowerName.includes('dvd')) {
      return { quality: '480p', estimatedBitrate: 2000 };
    }
    if (lowerName.includes('360p')) {
      return { quality: '360p', estimatedBitrate: 800 };
    }

    // Check for codec hints
    if (lowerName.includes('hevc') || lowerName.includes('x265') || lowerName.includes('h265')) {
      // HEVC is more efficient, assume 1080p by default
      return { quality: '1080p', estimatedBitrate: 5000 };
    }
    if (lowerName.includes('x264') || lowerName.includes('h264')) {
      return { quality: '720p', estimatedBitrate: 4000 };
    }

    // Default to 720p if unknown
    return { quality: 'Unknown', estimatedBitrate: 4000 };
  }

  // Check if torrent is suitable for current network
  isSuitableForNetwork(torrentName) {
    const quality = this.parseQualityFromName(torrentName);
    const recommended = this.getRecommendedQuality();

    const qualityOrder = ['360p', '480p', '720p', '1080p', '4K'];
    const torrentIndex = qualityOrder.indexOf(quality.quality);
    const recommendedIndex = qualityOrder.indexOf(recommended.quality);

    if (torrentIndex === -1) return { suitable: true, reason: 'Unknown quality' };

    if (torrentIndex <= recommendedIndex) {
      return { suitable: true, reason: `${quality.quality} is good for your connection` };
    } else {
      return {
        suitable: false,
        reason: `${quality.quality} may buffer. Recommended: ${recommended.quality} or lower`,
        recommendedQuality: recommended.quality
      };
    }
  }

  // Minimum seeders to show a torrent (only applied if seeders info is available)
  minSeeders = 3;

  // Filter and sort search results by suitability
  filterSearchResults(results) {
    if (!results || results.length === 0) return results;

    return results
      .filter(result => {
        // Filter out torrents with too few seeders (but allow if seeders unknown)
        const seeders = result.seeders ?? result.seeds ?? null;
        // If seeders is unknown (null), allow the result
        if (seeders === null || seeders === undefined) return true;
        return seeders >= this.minSeeders;
      })
      .map(result => {
        const suitability = this.isSuitableForNetwork(result.name || result.title || '');
        const quality = this.parseQualityFromName(result.name || result.title || '');
        const seeders = result.seeders || result.seeds || 0;

        return {
          ...result,
          seeders: seeders,
          aiQuality: quality.quality,
          aiSuitable: suitability.suitable,
          aiReason: suitability.reason,
          aiScore: this.calculateScore(result, quality, suitability),
          aiHealth: this.getTorrentHealth(seeders)
        };
      }).sort((a, b) => b.aiScore - a.aiScore);
  }

  // Get torrent health based on seeders
  getTorrentHealth(seeders) {
    if (seeders >= 50) return { status: 'excellent', label: 'Excellent', color: '#22c55e' };
    if (seeders >= 20) return { status: 'good', label: 'Good', color: '#84cc16' };
    if (seeders >= 10) return { status: 'ok', label: 'OK', color: '#eab308' };
    if (seeders >= 3) return { status: 'poor', label: 'Slow', color: '#f97316' };
    return { status: 'dead', label: 'Dead', color: '#ef4444' };
  }

  // Smart search - performs torrent search and enhances results with AI
  async smartSearch(query) {
    // Search for multiple qualities in parallel
    const qualities = ['', '720p', '1080p'];
    const searches = qualities.map(q =>
      fetch(`/api/search/torrents?q=${encodeURIComponent(query + (q ? ' ' + q : ''))}`)
        .then(r => r.json())
        .catch(() => ({ results: [] }))
    );

    const results = await Promise.all(searches);

    // Merge and deduplicate results
    const allResults = [];
    const seen = new Set();

    for (const data of results) {
      if (data.results) {
        for (const r of data.results) {
          const key = r.magnetLink || r.url;
          if (!seen.has(key)) {
            seen.add(key);
            allResults.push(r);
          }
        }
      }
    }

    if (allResults.length === 0) {
      return [];
    }

    // Enhance results with AI scoring
    const enhanced = this.filterSearchResults(allResults);

    // Group by content (same title, different quality)
    const grouped = this.groupByContent(enhanced);

    // Record search to history for better recommendations
    if (this.db) {
      await this.db.setPref('lastSearch', { query, timestamp: Date.now() });
    }

    return grouped;
  }

  // Group torrents by content (same movie/series, different quality)
  groupByContent(results) {
    const groups = new Map();

    for (const result of results) {
      const baseName = this.extractBaseName(result.name || result.title || '');

      if (!groups.has(baseName)) {
        groups.set(baseName, {
          baseName,
          variants: [],
          bestVariant: null,
          fastestVariant: null
        });
      }

      groups.get(baseName).variants.push(result);
    }

    // For each group, determine best and fastest variants
    for (const group of groups.values()) {
      const qualityOrder = ['4K', '2160p', '1080p', '720p', '480p', '360p', 'Unknown'];
      group.variants.sort((a, b) => {
        const aIdx = qualityOrder.indexOf(a.aiQuality);
        const bIdx = qualityOrder.indexOf(b.aiQuality);
        return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
      });

      group.bestVariant = group.variants[0];
      group.fastestVariant = group.variants.reduce((best, curr) =>
        (curr.seeders || 0) > (best.seeders || 0) ? curr : best
      , group.variants[0]);
      group.smartStreamUseful = group.bestVariant !== group.fastestVariant;
    }

    // Convert to flat array
    const result = [];
    for (const group of groups.values()) {
      if (group.variants.length === 1) {
        result.push(group.variants[0]);
      } else {
        const primary = group.fastestVariant;
        result.push({
          ...primary,
          hasAlternatives: true,
          alternativeCount: group.variants.length - 1,
          bestQuality: group.bestVariant.aiQuality,
          allVariants: group.variants,
          smartStreamUseful: group.smartStreamUseful
        });
      }
    }

    return result.sort((a, b) => b.aiScore - a.aiScore);
  }

  // Extract base name without quality markers
  extractBaseName(name) {
    return name
      .replace(/\b(2160p|1080p|720p|480p|360p|4K|UHD|HD|SD)\b/gi, '')
      .replace(/\b(WEB-DL|WEBRip|BluRay|BDRip|HDRip|DVDRip|HDTV)\b/gi, '')
      .replace(/\b(x264|x265|H\.?264|H\.?265|HEVC|AVC|AAC|AC3|DTS)\b/gi, '')
      .replace(/[\[\](){}]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .substring(0, 50);
  }

  // Start smart stream - uses fastest torrent, downloads better in background
  async startSmartStream(variants) {
    if (!variants || variants.length === 0) return null;

    const options = variants.map(v => ({
      magnetLink: v.magnetLink || v.url,
      name: v.name || v.title,
      seeders: v.seeders || 0,
      quality: v.aiQuality
    }));

    try {
      const response = await fetch('/api/smart-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options })
      });
      return await response.json();
    } catch (e) {
      console.error('Smart stream failed:', e);
      return null;
    }
  }

  // Calculate suitability score
  calculateScore(result, quality, suitability) {
    let score = 0;

    // Base score from seeders
    if (result.seeders) {
      score += Math.min(result.seeders, 100);
    }

    // Bonus for suitable quality
    if (suitability.suitable) {
      score += 50;
    }

    // Prefer higher quality when suitable
    const qualityBonus = { '4K': 40, '1080p': 30, '720p': 20, '480p': 10, '360p': 5 };
    if (suitability.suitable && qualityBonus[quality.quality]) {
      score += qualityBonus[quality.quality];
    }

    return score;
  }

  // Get continue watching suggestions
  async getContinueWatching() {
    if (!this.db) return [];

    try {
      const history = await this.db.getHistory(20);
      const progress = await this.db.getAllProgress();

      // Find items with progress < 90%
      const continueItems = [];

      for (const item of history) {
        const prog = progress.find(p => p.id === item.id);
        if (prog && prog.percentage < 90) {
          continueItems.push({
            ...item,
            progress: prog.percentage,
            position: prog.position,
            duration: prog.duration
          });
        }
      }

      return continueItems.slice(0, 5);
    } catch (e) {
      console.warn('Failed to get continue watching:', e);
      return [];
    }
  }

  // Get series to continue
  async getSeriesContinue() {
    if (!this.db) return [];

    try {
      const series = await this.db.getAllSeries();

      // Filter series with unwatched episodes
      return series.filter(s => {
        const watched = s.watchedEpisodes || [];
        const total = s.totalEpisodes || 0;
        return total > 0 && watched.length < total;
      }).map(s => ({
        ...s,
        nextEpisode: this.getNextEpisode(s),
        progress: Math.round((s.watchedEpisodes?.length || 0) / s.totalEpisodes * 100)
      })).slice(0, 5);
    } catch (e) {
      console.warn('Failed to get series continue:', e);
      return [];
    }
  }

  // Get next episode to watch
  getNextEpisode(series) {
    const watched = series.watchedEpisodes || [];
    for (let i = 1; i <= series.totalEpisodes; i++) {
      if (!watched.includes(i)) {
        return i;
      }
    }
    return null;
  }

  // Get cleanup suggestions
  async getCleanupSuggestions() {
    try {
      // Get storage stats
      const response = await fetch('/api/storage/stats');
      const storage = await response.json();

      // Get watch history to identify watched content
      const history = this.db ? await this.db.getHistory(100) : [];
      const watchedMagnets = history
        .filter(h => h.type === 'torrent' && h.watched)
        .map(h => h.magnetURI || h.id);

      return {
        totalSize: storage.total,
        formattedSize: storage.formatted?.total || this.formatBytes(storage.total),
        watchedCount: watchedMagnets.length,
        suggestions: watchedMagnets.length > 0 ?
          `${watchedMagnets.length} watched items can be cleaned up` :
          'No cleanup suggestions'
      };
    } catch (e) {
      console.warn('Failed to get cleanup suggestions:', e);
      return { totalSize: 0, formattedSize: '0 B', watchedCount: 0, suggestions: 'Unable to analyze' };
    }
  }

  // Format bytes to human readable
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Format speed to human readable
  formatSpeed(bytesPerSec) {
    return this.formatBytes(bytesPerSec) + '/s';
  }

  // Get network status summary
  getNetworkStatus() {
    const speed = this.getAverageSpeed();
    const quality = this.getRecommendedQuality();

    return {
      speed: speed,
      speedFormatted: this.formatSpeed(speed),
      speedMbps: (speed / (1000000 / 8)).toFixed(1),
      recommendedQuality: quality.quality,
      status: speed > 5000000 ? 'excellent' : speed > 2000000 ? 'good' : speed > 500000 ? 'fair' : 'slow'
    };
  }

  // Prefetch suggestions - what to download in background
  async getPrefetchSuggestions() {
    if (!this.db) return [];

    try {
      const series = await this.db.getAllSeries();
      const suggestions = [];

      for (const s of series) {
        const nextEp = this.getNextEpisode(s);
        if (nextEp && s.magnetURI) {
          suggestions.push({
            seriesName: s.name,
            episode: nextEp,
            magnetURI: s.magnetURI,
            priority: s.lastWatched ? 'high' : 'low'
          });
        }
      }

      return suggestions.slice(0, 3);
    } catch (e) {
      console.warn('Failed to get prefetch suggestions:', e);
      return [];
    }
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MediaAI;
}
