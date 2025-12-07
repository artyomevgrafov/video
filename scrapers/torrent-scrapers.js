const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const cheerio = require("cheerio");

puppeteer.use(StealthPlugin());

// Browser instance cache
let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  browserInstance = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
    ],
  });

  return browserInstance;
}

// YTS (Movies in good quality)
async function searchYTS(query, limit = 15) {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );

    const searchUrl = `https://yts.mx/browse-movies/${encodeURIComponent(query)}/all/all/0/latest/0/all`;

    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });

    const content = await page.content();
    await page.close();

    const $ = cheerio.load(content);
    const results = [];

    $(".browse-movie-wrap").each((i, elem) => {
      if (i >= limit) return false;

      const title = $(elem).find(".browse-movie-title").text().trim();
      const year = $(elem).find(".browse-movie-year").text().trim();
      const rating = $(elem).find(".rating").text().trim();
      const thumbnail = $(elem).find("img").attr("src");
      const link = $(elem).find("a").attr("href");

      if (title && link) {
        results.push({
          title: `${title} (${year})`,
          url: link,
          thumbnail,
          rating,
          seeders: 0,
          size: "",
          source: "YTS",
          type: "movie",
        });
      }
    });

    return results;
  } catch (err) {
    console.error("YTS scraper error:", err.message);
    return [];
  }
}

// 1337x (General torrents)
async function search1337x(query, limit = 15) {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );

    const searchUrl = `https://1337x.to/search/${encodeURIComponent(query)}/1/`;

    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });

    const content = await page.content();
    await page.close();

    const $ = cheerio.load(content);
    const results = [];

    $("tbody tr").each((i, elem) => {
      if (i >= limit) return false;

      const title = $(elem).find(".name a").eq(1).text().trim();
      const link = $(elem).find(".name a").eq(1).attr("href");
      const seeders = parseInt($(elem).find(".seeds").text()) || 0;
      const leechers = parseInt($(elem).find(".leeches").text()) || 0;
      const size = $(elem).find(".size").text().trim();

      if (title && link) {
        results.push({
          title,
          url: `https://1337x.to${link}`,
          seeders,
          leechers,
          size,
          source: "1337x",
          type: "torrent",
        });
      }
    });

    return results;
  } catch (err) {
    console.error("1337x scraper error:", err.message);
    return [];
  }
}

// ThePirateBay (через проксі/дзеркала)
async function searchPirateBay(query, limit = 15) {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );

    // Використовуємо дзеркало
    const searchUrl = `https://thepiratebay.org/search.php?q=${encodeURIComponent(query)}`;

    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 30000 });

    const content = await page.content();
    await page.close();

    const $ = cheerio.load(content);
    const results = [];

    $("#searchResult tbody tr").each((i, elem) => {
      if (i >= limit) return false;

      const title = $(elem).find(".detName a").text().trim();
      const magnetLink = $(elem).find('a[href^="magnet:"]').attr("href");
      const seeders = parseInt($(elem).find("td").eq(2).text()) || 0;
      const leechers = parseInt($(elem).find("td").eq(3).text()) || 0;
      const sizeText = $(elem).find(".detDesc").text();
      const sizeMatch = sizeText.match(/Size (.+?),/);
      const size = sizeMatch ? sizeMatch[1] : "";

      if (title && magnetLink) {
        results.push({
          title,
          url: magnetLink,
          magnetLink,
          seeders,
          leechers,
          size,
          source: "PirateBay",
          type: "torrent",
        });
      }
    });

    return results;
  } catch (err) {
    console.error("PirateBay scraper error:", err.message);
    return [];
  }
}

// Get magnet link from detail page (for 1337x and YTS)
async function getMagnetLink(detailUrl) {
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );

    await page.goto(detailUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Try to find magnet link
    const magnetLink = await page.evaluate(() => {
      const magnetEl = document.querySelector('a[href^="magnet:"]');
      return magnetEl ? magnetEl.href : null;
    });

    await page.close();
    return magnetLink;
  } catch (err) {
    console.error("Get magnet error:", err.message);
    return null;
  }
}

// Unified search across all sources
async function searchAll(query, limit = 15) {
  const promises = [
    searchYTS(query, limit).catch(() => []),
    search1337x(query, limit).catch(() => []),
    searchPirateBay(query, limit).catch(() => []),
  ];

  const results = await Promise.all(promises);
  const combined = results.flat();

  // Sort by seeders (if available)
  combined.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));

  return combined.slice(0, limit);
}

// Close browser on exit
process.on("exit", async () => {
  if (browserInstance) {
    await browserInstance.close();
  }
});

module.exports = {
  searchYTS,
  search1337x,
  searchPirateBay,
  searchAll,
  getMagnetLink,
};
