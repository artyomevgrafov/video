const https = require("https");
const http = require("http");

// Helper for HTTP GET requests
function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;

    const requestOptions = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ...options.headers,
      },
      timeout: 15000,
    };

    client
      .get(url, requestOptions, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return httpGet(res.headers.location, options)
            .then(resolve)
            .catch(reject);
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(data);
          }
        });
      })
      .on("error", reject);
  });
}

// Search using The Pirate Bay API (unofficial mirrors)
async function searchPirateBayAPI(query, limit = 15) {
  try {
    // Using apibay.org - unofficial API
    const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=`;
    const data = await httpGet(url);
    const results = JSON.parse(data);

    if (!Array.isArray(results)) return [];

    return results
      .slice(0, limit)
      .map((item) => {
        if (!item.name || item.name === "No results returned") return null;

        const infoHash = item.info_hash;
        const magnetLink = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.name)}`;

        return {
          title: item.name,
          url: magnetLink,
          magnetLink,
          seeders: parseInt(item.seeders) || 0,
          leechers: parseInt(item.leechers) || 0,
          size: formatBytes(parseInt(item.size)),
          added: new Date(parseInt(item.added) * 1000).toLocaleDateString(),
          source: "PirateBay",
          type: "torrent",
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error("PirateBay API error:", err.message);
    return [];
  }
}

// Search using 1337x API (через проксі API)
async function search1337xAPI(query, limit = 15) {
  try {
    // Використовуємо публічне API (може змінюватись)
    const url = `https://1337x.unblockit.nz/search/${encodeURIComponent(query)}/1/`;
    const html = await httpGet(url);

    // Простий регекс парсинг замість cheerio
    const results = [];
    const pattern = /<a href="\/torrent\/(\d+)\/([^"]+)">([^<]+)<\/a>/g;
    let match;

    while ((match = pattern.exec(html)) !== null && results.length < limit) {
      const [, id, slug, title] = match;
      results.push({
        title: title.trim(),
        url: `https://1337x.unblockit.nz/torrent/${id}/${slug}`,
        source: "1337x",
        type: "torrent",
      });
    }

    return results;
  } catch (err) {
    console.error("1337x API error:", err.message);
    return [];
  }
}

// Search YTS (публічний API)
async function searchYTSAPI(query, limit = 15) {
  try {
    // YTS має офіційний API - пробуємо різні домени
    const domains = ["yts.mx", "yts.lt", "yts.am", "yts.ag"];
    let data = null;
    let lastError = null;

    for (const domain of domains) {
      try {
        const url = `https://${domain}/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=${limit}`;
        data = await httpGet(url);
        break; // Успіх - виходимо з циклу
      } catch (err) {
        lastError = err;
        continue; // Пробуємо наступний домен
      }
    }

    if (!data) throw lastError || new Error("All YTS domains failed");

    const json = JSON.parse(data);

    if (!json.data || !json.data.movies) return [];

    return json.data.movies
      .map((movie) => {
        // Знаходимо найкращу якість
        const torrent = movie.torrents?.[0];
        if (!torrent) return null;

        const magnetLink = `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(movie.title)}`;

        return {
          title: `${movie.title} (${movie.year}) [${torrent.quality}]`,
          url: magnetLink,
          magnetLink,
          thumbnail: movie.medium_cover_image,
          seeders: torrent.seeds,
          leechers: torrent.peers,
          size: torrent.size,
          rating: movie.rating,
          source: "YTS",
          type: "movie",
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error("YTS API error:", err.message);
    return [];
  }
}

// Helper: format bytes to human readable
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "Unknown";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Search Rutor (російськомовний контент)
async function searchRutorAPI(query, limit = 15) {
  try {
    const url = `http://rutor.info/search/0/0/000/0/${encodeURIComponent(query)}`;
    const html = await httpGet(url);

    const results = [];
    // Парсимо таблицю результатів
    const rowPattern =
      /<tr class="[^"]*">\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>.*?<a href="magnet:\?[^"]*"[^>]*>.*?<\/a>.*?<a href="([^"]*)"[^>]*>([^<]*)<\/a>.*?<td[^>]*>([^<]*)<\/td>.*?<td[^>]*><span[^>]*>(\d+)<\/span>.*?<span[^>]*>(\d+)<\/span>/gs;

    // Альтернативний простіший патерн
    const magnetPattern = /magnet:\?xt=urn:btih:([a-fA-F0-9]{40})/g;
    const titlePattern = /<a href="\/torrent\/[^"]+">([^<]+)<\/a>/g;

    const magnets = [...html.matchAll(magnetPattern)];
    const titles = [...html.matchAll(titlePattern)];

    for (let i = 0; i < Math.min(magnets.length, titles.length, limit); i++) {
      const hash = magnets[i][1];
      let title = titles[i][1].trim();
      // Декодуємо HTML entities
      title = title
        .replace(/&amp;/g, "&")
        .replace(/&#039;/g, "'")
        .replace(/&quot;/g, '"');
      const magnetLink = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`;

      results.push({
        title,
        url: magnetLink,
        magnetLink,
        source: "Rutor",
        type: "torrent",
      });
    }

    return results;
  } catch (err) {
    console.error("Rutor API error:", err.message);
    return [];
  }
}

// Search Kinozal (українська локалізація)
async function searchKinozalAPI(query, limit = 15) {
  try {
    const url = `https://kinozal.tv/browse.php?s=${encodeURIComponent(query)}`;
    const html = await httpGet(url);

    const results = [];
    // Простий парсинг посилань на торенти
    const pattern = /<a href="\/details\.php\?id=(\d+)"[^>]*>([^<]+)<\/a>/g;
    let match;

    while ((match = pattern.exec(html)) !== null && results.length < limit) {
      const [, id, title] = match;
      results.push({
        title: title.trim(),
        detailsUrl: `https://kinozal.tv/details.php?id=${id}`,
        source: "Kinozal",
        type: "torrent",
      });
    }

    return results;
  } catch (err) {
    console.error("Kinozal API error:", err.message);
    return [];
  }
}

// Search RARBG via API proxy (резервний англомовний)
async function searchRARBGAPI(query, limit = 15) {
  try {
    // Torrentio/Jackett style API
    const url = `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents/search=${encodeURIComponent(query)}.json`;
    const data = await httpGet(url);
    const json = JSON.parse(data);

    if (!json.streams) return [];

    return json.streams.slice(0, limit).map((s) => {
      const magnetMatch = s.url?.match(/magnet:\?[^&]+/);
      return {
        title: s.title || s.name,
        url: s.url,
        magnetLink: magnetMatch ? magnetMatch[0] : s.url,
        source: "Torrentio",
        type: "torrent",
      };
    });
  } catch (err) {
    console.error("RARBG/Torrentio error:", err.message);
    return [];
  }
}

// Unified search - паралельно по всіх джерелах
async function searchAll(query, limit = 15) {
  // Визначаємо чи запит кирилицею
  const isCyrillic = /[а-яёіїєґА-ЯЁІЇЄҐ]/.test(query);

  const promises = [
    searchYTSAPI(query, limit).catch(() => []),
    searchPirateBayAPI(query, limit).catch(() => []),
  ];

  // Для кириличних запитів додаємо Rutor
  if (isCyrillic) {
    promises.push(searchRutorAPI(query, limit).catch(() => []));
  }

  const results = await Promise.all(promises);
  const combined = results.flat();

  // Сортуємо за кількістю сідів
  combined.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

  return combined.slice(0, limit);
}

module.exports = {
  searchYTS: searchYTSAPI,
  searchPirateBay: searchPirateBayAPI,
  search1337x: search1337xAPI,
  searchRutor: searchRutorAPI,
  searchAll,
};
