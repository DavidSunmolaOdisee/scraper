import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());

// --- config ---
const AUTH = process.env.SCRAPER_TOKEN || "dev-secret";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Beperk parallelle tabs (Render Free)
let activePages = 0;
const MAX_PAGES = Number(process.env.MAX_PAGES || "2");
async function acquireSlot() {
  while (activePages >= MAX_PAGES) await sleep(150);
  activePages++;
}
function releaseSlot() {
  activePages = Math.max(0, activePages - 1);
}

// --- browser lifecycle ---
let browser;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
      ],
    });
  }
  return browser;
}

// --- url filters ---
function allowUrl(u) {
  try { u = new URL(u).toString(); } catch { return false; }
  if (!/^https?:\/\//i.test(u)) return false;
  if (!/(facebook\.(com|net)|fbcdn|scontent|cdninstagram)/i.test(u)) return false;
  if (/rsrc\.php|hsts-pixel|sprite|emoji|\/p50x50\//i.test(u)) return false;
  return true;
}

// --- collector die in elk (i)frame draait ---
function collectMediaInThisDom() {
  const media = []; const seen = new Set();
  const allow = (u) =>
    /^https?:\/\//i.test(u) &&
    /(facebook\.(com|net)|fbcdn|scontent|cdninstagram)/i.test(u) &&
    !/rsrc\.php|hsts-pixel|sprite|emoji|\/p50x50\//i.test(u);
  const push = (kind, url) => {
    if (!url) return;
    try { url = new URL(url, location.href).toString(); } catch {}
    if (!allow(url)) return;
    const key = kind + "|" + url;
    if (!seen.has(key)) { seen.add(key); media.push({ kind, url }); }
  };

  document.querySelectorAll('meta[property="og:image"], meta[property="og:image:secure_url"]').forEach(m => push("image", m.content));
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]').forEach(m => push("video", m.content));

  document.querySelectorAll("img").forEach(img => {
    if (img.src) push("image", img.src);
    const ds = img.getAttribute("data-src"); if (ds) push("image", ds);
    const ss = img.getAttribute("srcset"); if (ss) ss.split(",").forEach(p => push("image", p.trim().split(" ")[0]));
  });

  document.querySelectorAll("source").forEach(s => {
    const src = s.getAttribute("src");
    if (src && /\.(mp4|mov|webm)(\?|$)/i.test(src)) push("video", src);
  });

  document.querySelectorAll("[style]").forEach(el => {
    const m = (el.getAttribute("style")||"").match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
    if (m) push("image", m[1]);
  });

  return media;
}

// -- alle frames bundelen + thumbnail kiezen --
async function collectAllFrames(page) {
  const frames = page.frames();
  const out = []; const seen = new Set();

  for (const fr of frames) {
    try {
      const part = (await fr.evaluate(collectMediaInThisDom).catch(() => [])) || [];
      for (const m of part) {
        if (!allowUrl(m.url)) continue;
        const key = m.kind + "|" + m.url;
        if (!seen.has(key)) { seen.add(key); out.push(m); }
      }
    } catch { /* frame kan al weg zijn */ }
  }

  const thumb =
    out.find(m => m.kind === "image" && /(fbcdn|scontent|cdninstagram)/i.test(m.url)) ||
    out.find(m => m.kind === "image") || null;

  return { media: out, thumbnail_url: thumb ? thumb.url : null };
}

// -- lazy-loads triggeren --
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0; const distance = 600;
      const timer = setInterval(() => {
        const se = document.scrollingElement || document.body;
        window.scrollBy(0, distance);
        total += distance;
        if (total > 3000 || se.scrollTop + window.innerHeight >= se.scrollHeight) {
          clearInterval(timer); resolve();
        }
      }, 150);
    });
  }).catch(() => {});
}

// -- navigatie met 1 retry op detach/target closed --
async function gotoWithRetry(page, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (attempt === 0 && /detached|Target closed|Navigation failed/i.test(msg)) {
        await sleep(700); // << hier stond per ongeluk 'await (700)'
        continue;
      }
      throw e;
    }
  }
}

app.get("/", (_req, res) => res.send("OK — use /preview?id=... with X-Auth header"));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/preview", async (req, res) => {
  const token = req.header("X-Auth");
  if (token !== AUTH) return res.status(401).json({ ok: false, code: "AUTH" });

  const id = String(req.query.id || "").trim();
  if (!/^\d+$/.test(id))
    return res.status(400).json({ ok: false, code: "BAD_ID", message: "id must be numeric" });

  const target = `https://www.facebook.com/ads/archive/render_ad/?id=${id}`;

  await acquireSlot();
  const sniff = []; // netwerk-asset fallback
  try {
    const br = await getBrowser();
    const page = await br.newPage();

    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setViewport({ width: 1366, height: 900 });
    await page.setBypassCSP(true);
    page.setDefaultNavigationTimeout(45000);
    page.setDefaultTimeout(15000);

    // Sniff netwerk assets (image/video)
    page.on("response", async (r) => {
      const url = r.url();
      if (!allowUrl(url)) return;
      const ct = (r.headers()["content-type"] || "").toLowerCase();
      const isImg = ct.includes("image") || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
      const isVid = ct.includes("video") || /\.(mp4|webm|mov)(\?|$)/i.test(url);
      if (isImg) sniff.push({ kind: "image", url });
      else if (isVid) sniff.push({ kind: "video", url });
    });

    // Interceptie: laat FB/IG door; block ruis
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = r.url();
      const t = r.resourceType();
      if (/^data:/i.test(u)) return r.continue();
      if (/(facebook\.(com|net)|fbcdn|scontent|cdninstagram)/i.test(u)) return r.continue();
      if (["image", "font", "media", "stylesheet"].includes(t)) return r.continue();
      return r.abort();
    });

    await gotoWithRetry(page, target);

    // wacht op iets visueels, scroll, laat lazy loaders draaien
    try { await page.waitForSelector('img, meta[property="og:image"]', { timeout: 6000 }); } catch {}
    await autoScroll(page);
    await sleep(800); // << hier stond per ongeluk 'await (800)'

    // verzamel uit alle frames
    let { media, thumbnail_url } = await collectAllFrames(page);

    // fallback: netwerk-sniff combineren
    if (media.length === 0 && sniff.length > 0) {
      const unique = new Map();
      for (const m of sniff) if (!unique.has(m.url)) unique.set(m.url, m);
      media = Array.from(unique.values());
      const thumb = media.find(m => m.kind === "image" && /(fbcdn|scontent|cdninstagram)/i.test(m.url))
                 || media.find(m => m.kind === "image");
      thumbnail_url = thumb ? thumb.url : null;
    }

    // laatste fallback: 1x soft reload
    if (media.length === 0) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(700); // << hier stond per ongeluk 'await (700)'
      ({ media, thumbnail_url } = await collectAllFrames(page));
    }

    await page.close();
    res.set("Cache-Control", "public, max-age=600");
    return res.json({ ok: true, media, thumbnail_url });
  } catch (e) {
    return res.status(500).json({ ok: false, code: "SCRAPE_ERROR", message: String(e?.message || e) });
  } finally {
    releaseSlot();
  }
});

app.listen(process.env.PORT || 8080, () => console.log("scraper listening"));
