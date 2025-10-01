import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());

const AUTH = process.env.SCRAPER_TOKEN || "dev-secret";
const UA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let browser;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      // Gebruik Chromium uit het base image, of fallback naar bundled path
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--no-zygote",
        "--single-process"
      ]
    });
  }
  return browser;
}


function collectMedia() {
  const media = []; const seen = new Set();
  const push = (kind, url) => {
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (!/(fbcdn|scontent|cdninstagram|facebook\.com)/i.test(url)) return;
    const key = kind + "|" + url;
    if (!seen.has(key)) { seen.add(key); media.push({ kind, url }); }
  };
  document.querySelectorAll('meta[property="og:image"], meta[property="og:image:secure_url"]').forEach(m => push("image", m.content));
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]').forEach(m => push("video", m.content));
  document.querySelectorAll("img").forEach(img => {
    if (img.src) push("image", img.src);
    const ds = img.getAttribute("data-src"); if (ds) push("image", ds);
    const ss = img.getAttribute("srcset");
    if (ss) ss.split(",").forEach(p => push("image", p.trim().split(" ")[0]));
  });
  document.querySelectorAll("source").forEach(s => {
    const src = s.getAttribute("src");
    if (src && /\.(mp4|mov|webm)(\?|$)/i.test(src)) push("video", src);
  });
  document.querySelectorAll("[style]").forEach(el => {
    const m = (el.getAttribute("style")||"").match(/background-image:\s*url\(["']?([^\"')]+)[\"']?\)/i);
    if (m) push("image", m[1]);
  });
  const thumbnail_url = media.find(m => m.kind === "image")?.url || null;
  return { media, thumbnail_url };
}

app.get("/preview", async (req, res) => {
  try {
    if (req.header("X-Auth") !== (process.env.SCRAPER_TOKEN || "dev-secret"))
      return res.status(401).json({ ok:false, code:"AUTH" });

    const id = String(req.query.id || "").trim();
    if (!/^\d+$/.test(id)) return res.status(400).json({ ok:false, code:"BAD_ID", message:"id must be numeric" });

    const url = `https://www.facebook.com/ads/archive/render_ad/?id=${id}`;
    const br = await getBrowser();
    const page = await br.newPage();
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setRequestInterception(true);
    page.on("request", r => {
      const u = r.url();
      if (/fbcdn|scontent|facebook\.com|cdninstagram/i.test(u) || /^data:/i.test(u)) return r.continue();
      r.abort();
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });
    await page.waitForTimeout(800);

    const result = await page.evaluate(collectMedia);
    await page.close();

    res.set("Cache-Control","public, max-age=600");
    return res.json({ ok:true, ...result });
  } catch (e) {
    return res.status(500).json({ ok:false, code:"SCRAPE_ERROR", message:e.message });
  }
});

app.get("/health", (_req,res)=>res.json({ ok:true }));
app.listen(process.env.PORT || 8080, () => console.log("scraper listening"));
