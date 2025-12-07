// Video extractor using Playwright
// Intercepts network requests to find m3u8/mp4 video sources

const { chromium } = require("playwright");

async function extractVideoUrl(pageUrl, timeout = 30000) {
  let browser = null;
  const videoUrls = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      extraHTTPHeaders: {
        Referer: new URL(pageUrl).origin + "/",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    const page = await context.newPage();

    // Intercept network requests
    page.on("request", (request) => {
      const url = request.url();
      // Look for video streams
      if (
        url.includes(".m3u8") ||
        url.includes(".mp4") ||
        url.includes(".ts") ||
        url.includes("/hls/") ||
        url.includes("/video/") ||
        url.includes("manifest")
      ) {
        if (!url.includes(".ts?") && !url.includes("segment")) {
          // Skip segments
          videoUrls.push({
            url: url,
            type: url.includes(".m3u8")
              ? "hls"
              : url.includes(".mp4")
                ? "mp4"
                : "other",
            resourceType: request.resourceType(),
          });
        }
      }
    });

    page.on("response", async (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";

      // Check content type for video
      if (
        contentType.includes("mpegurl") ||
        contentType.includes("mp4") ||
        contentType.includes("video")
      ) {
        if (!videoUrls.find((v) => v.url === url)) {
          videoUrls.push({
            url: url,
            type: contentType.includes("mpegurl") ? "hls" : "mp4",
            contentType: contentType,
          });
        }
      }
    });

    console.log("Loading page:", pageUrl);
    await page.goto(pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeout,
    });

    // Wait for player to initialize and start loading video
    await page.waitForTimeout(5000);

    // Try to find and click play button if exists
    try {
      const playButtons = await page.$$(
        'button[class*="play"], .play-button, .vjs-big-play-button, [class*="play"]',
      );
      if (playButtons.length > 0) {
        await playButtons[0].click();
        await page.waitForTimeout(3000);
      }
    } catch (e) {
      // No play button or can't click
    }

    // Look for video elements in page
    const videoSources = await page.evaluate(() => {
      const sources = [];

      // Check video elements
      document.querySelectorAll("video").forEach((video) => {
        if (video.src) sources.push({ url: video.src, type: "video-src" });
        video.querySelectorAll("source").forEach((source) => {
          if (source.src)
            sources.push({ url: source.src, type: "video-source" });
        });
      });

      // Check iframes for embedded players
      document.querySelectorAll("iframe").forEach((iframe) => {
        if (iframe.src) sources.push({ url: iframe.src, type: "iframe" });
      });

      return sources;
    });

    videoSources.forEach((s) => {
      if (!videoUrls.find((v) => v.url === s.url)) {
        videoUrls.push(s);
      }
    });

    // If we found iframes, try to extract from them too
    const iframeSources = videoUrls.filter((v) => v.type === "iframe");
    for (const iframe of iframeSources) {
      try {
        const iframePage = await context.newPage();

        iframePage.on("request", (request) => {
          const url = request.url();
          if (url.includes(".m3u8") || url.includes(".mp4")) {
            if (!videoUrls.find((v) => v.url === url)) {
              videoUrls.push({
                url: url,
                type: url.includes(".m3u8") ? "hls" : "mp4",
                source: "iframe",
              });
            }
          }
        });

        await iframePage.goto(iframe.url, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await iframePage.waitForTimeout(5000);

        // Try clicking play in iframe
        try {
          const playBtn = await iframePage.$(
            'button[class*="play"], .play-button, [class*="play"]',
          );
          if (playBtn) {
            await playBtn.click();
            await iframePage.waitForTimeout(3000);
          }
        } catch (e) {}

        await iframePage.close();
      } catch (e) {
        console.log("Could not load iframe:", e.message);
      }
    }

    await browser.close();

    // Filter and prioritize results
    const hlsUrls = videoUrls.filter(
      (v) => v.type === "hls" || v.url?.includes(".m3u8"),
    );
    const mp4Urls = videoUrls.filter(
      (v) => v.type === "mp4" || v.url?.includes(".mp4"),
    );

    return {
      success: videoUrls.length > 0,
      hls: hlsUrls,
      mp4: mp4Urls,
      all: videoUrls,
      bestUrl: hlsUrls[0]?.url || mp4Urls[0]?.url || null,
    };
  } catch (error) {
    if (browser) await browser.close();
    return {
      success: false,
      error: error.message,
      all: videoUrls,
    };
  }
}

// Export for use in server
module.exports = { extractVideoUrl };

// CLI usage
if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    console.log("Usage: node video-extractor.js <url>");
    process.exit(1);
  }

  extractVideoUrl(url).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  });
}
