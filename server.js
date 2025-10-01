import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());

// ---------- Config ----------
const AUTH = process.env.SCRAPER_TOKEN || "dev-secret";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Render Free: hou parallelle tabs laag
let activePages = 0;
const MAX_PAGES = Number(process.env.MAX_PAGES || "2");
async function acquireSlot() {
  while (activePages >= MAX_PAGES) await sleep(150);
  activePages++;
}
function releaseSlot() {
  activePages = Math.max(0, activePages - 1);
}

// ---------- Browser ----------
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

// ---------- Helpers ----------
function allowUrl(u) {
  try { u = new URL(u).toString(); } catch { return false; }
  if (!/^https?:\/\//i.test(u)) return false;
  if (!/(facebook\.(com|net)|fbcdn|scontent|cdninstagram|video-.*\.fbcdn\.net)/i.test(u)) return false;
  if (/rsrc\.php|hsts-pixel|sprite|emoji|\/p50x50\//i.test(u)) return false;
  return true;
}

async function tryAcceptCookies(page) {
  const clicked = await page.evaluate(() => {
    const want = [
      "allow all cookies","alle cookies toestaan","alles toestaan","alles accepteren",
      "accepter tous les cookies","alle cookies akzeptieren","permitir todas las cookies",
      "consenti a tutti i cookie",
    ];
    const btns = Array.from(document.querySelectorAll("button,[role='button']"));
    for (const b of btns) {
      const t = (b.innerText || b.textContent || "").trim().toLowerCase();
      if (want.some(w => t.includes(w))) { b.click(); return true; }
    }
    const alt = document.querySelector('[data-cookiebanner="accept_button"]');
    if (alt) { alt.click(); return true; }
    return false;
  }).catch(() => false);
  if (clicked) await sleep(900);
  return clicked;
}

// draait in elk (i)frame
function collectMediaInThisDom() {
  const media = []; const seen = new Set();
  const allow = (u) =>
    /^https?:\/\//i.test(u) &&
    /(facebook\.(com|net)|fbcdn|scontent|cdninstagram|video-.*\.fbcdn\.net)/i.test(u) &&
    !/rsrc\.php|hsts-pixel|sprite|emoji|\/p50x50\//i.test(u);
  const push = (kind, url) => {
    if (!url) return;
    try { url = new URL(url, location.href).toString(); } catch {}
    if (!allow(url)) return;
    const key = kind + "|" + url;
    if (!seen.has(key)) { seen.add(key); media.push({ kind, url }); }
  };

  // meta
  document.querySelectorAll('meta[property="og:image"], meta[property="og:image:secure_url"]')
    .forEach(m => push("image", m.content));
  document.querySelectorAll('meta[property="og:video"], meta[property="og:video:url"]')
    .forEach(m => push("video", m.content));

  // <img> + lazy/srcset
  document.querySelectorAll("img").forEach(img => {
    if (img.src) push("image", img.src);
    const ds = img.getAttribute("data-src"); if (ds) push("image", ds);
    const ss = img.getAttribute("srcset");
    if (ss) ss.split(",").forEach(p => push("image", p.trim().split(" ")[0]));
  });

  // <source> (video)
  document.querySelectorAll("source").forEach(s => {
    const src = s.getAttribute("src");
    if (src && /\.(mp4|mov|webm)(\?|$)/i.test(src)) push("video", src);
  });

  // inline backgrounds
  document.querySelectorAll("[style]").forEach(el => {
    const m = (el.getAttribute("style")||"").match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
    if (m) push("image", m[1]);
  });

  return media;
}

// bundel alle frames
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
  return out;
}

// auto-scroll voor lazy loads
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

// navigatie met 1 retry
async function gotoWithRetry(page, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (attempt === 0 && /detached|Target closed|Navigation failed/i.test(msg)) {
        await sleep(700);
        continue;
      }
      throw e;
    }
  }
}

// ------------- Filter, Ranking & Classify -------------
function filterRankAndClassify(mediaIn) {
  // dedup
  const seen = new Set();
  const dedup = [];
  for (const m of mediaIn) {
    if (!m?.url) continue;
    const key = m.kind + "|" + m.url;
    if (!seen.has(key)) { seen.add(key); dedup.push(m); }
  }

  // splitsen
  const BAD_IMG = /(empty-state|overfiltering|politics\/archive|sprite|emoji|p50x50|s60x60|s96x96|s148x148|\/v\/t39\.30808-1\/)/i;
  const images = dedup.filter(m => m.kind === "image" && !BAD_IMG.test(m.url));
  const videos = dedup.filter(m => m.kind === "video");
  const has_video = videos.length > 0;

  // detecteer carrousel (heuristiek: meerdere “grote” scontent-afbeeldingen)
  const SIZE_HINT = /(s1200x1200|s2048x2048|s1920x1080|s1280x720|s1080x1080|s960x960|s720x720|s600x600)/i;
  const bigImages = images.filter(i => SIZE_HINT.test(i.url) || /safe_image\.php/i.test(i.url));
  const carousel_count = bigImages.length >= 3 ? bigImages.length : (images.length >= 3 ? images.length : 0);

  // sorteer afbeeldingen (video’s NIET meenemen voor thumbnail)
  function imgScore(u) {
    let s = 0;
    if (SIZE_HINT.test(u)) s += 40;
    if (/safe_image\.php/i.test(u)) s += 10;
    if (/profile|avatar/i.test(u)) s -= 30;
    return s;
  }
  images.sort((a,b) => imgScore(b.url) - imgScore(a.url));

  // kies thumbnail: altijd een afbeelding, bij carrousel is dit effectief de "eerste" (hoogst gescored)
  const thumbnail_url = images[0]?.url || null;

  // klasse
  let ad_kind = "IMAGE";
  if (carousel_count >= 3) ad_kind = "CAROUSEL";
  else if (has_video && images.length <= 1) ad_kind = "VIDEO"; // we vermelden video, maar geven geen video-thumb terug

  // let op: we geven alleen afbeeldingen in 'media' terug,
  // zodat front-end nooit per ongeluk een video als thumb kiest.
  return {
    media: images,
    thumbnail_url,
    has_video,
    ad_kind,
    carousel_count
  };
}

// ---------- Routes ----------
app.get("/", (_req, res) => res.send("OK — use /preview?id=... with X-Auth header"));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/preview", async (req, res) => {
  const token = req.header("X-Auth");
  if (token !== AUTH) return res.status(401).json({ ok: false, code: "AUTH" });

  const id = String(req.query.id || "").trim();
  if (!/^\d+$/.test(id))
    return res.status(400).json({ ok: false, code: "BAD_ID", message: "id must be numeric" });

  await acquireSlot();
  const sniff = []; // netwerk fallback (images/videos)
  const target = `https://www.facebook.com/ads/library/?id=${id}`;

  try {
    const br = await getBrowser();
    const page = await br.newPage();

    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setViewport({ width: 1366, height: 900 });
    await page.setBypassCSP(true);
    page.setDefaultNavigationTimeout(45000);
    page.setDefaultTimeout(15000);

    // Sniff network
    page.on("response", async (r) => {
      const url = r.url();
      if (!allowUrl(url)) return;
      const ct = (r.headers()["content-type"] || "").toLowerCase();
      const isImg = ct.includes("image") || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
      const isVid = ct.includes("video") || /\.(mp4|webm|mov)(\?|$)/i.test(url);
      if (isImg) sniff.push({ kind: "image", url });
      else if (isVid) sniff.push({ kind: "video", url });
    });

    // Intercept: laat FB/IG door; block ruis
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      const u = r.url();
      const t = r.resourceType();
      if (/^data:/i.test(u)) return r.continue();
      if (/(facebook\.(com|net)|fbcdn|scontent|cdninstagram)/i.test(u)) return r.continue();
      if (["image", "font", "media", "stylesheet"].includes(t)) return r.continue();
      return r.abort();
    });

    // ---- navigatie + scraping ----
    await gotoWithRetry(page, target);
    await tryAcceptCookies(page);

    try { await page.waitForSelector('img, meta[property="og:image"]', { timeout: 6000 }); } catch {}
    await autoScroll(page);
    await sleep(800);

    // DOM + iframes
    let media = await collectAllFrames(page);

    // netwerk-fallback toevoegen als DOM niets gaf
    if (media.length === 0 && sniff.length > 0) {
      const uniq = new Map();
      for (const m of sniff) if (allowUrl(m.url) && !uniq.has(m.url)) uniq.set(m.url, m);
      media = Array.from(uniq.values());
    }

    // filter & classificatie (géén video in media, wel has_video/ad_kind)
    let { media: imagesOnly, thumbnail_url, has_video, ad_kind, carousel_count } = filterRankAndClassify(media);

    // laatste redmiddel: zachte reload
    if (imagesOnly.length === 0) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(700);
      media = await collectAllFrames(page);
      ({ media: imagesOnly, thumbnail_url, has_video, ad_kind, carousel_count } = filterRankAndClassify(media));
    }

    await page.close();
    res.set("Cache-Control", "public, max-age=600");
    return res.json({
      ok: true,
      media: imagesOnly,         // alleen afbeeldingen
      thumbnail_url,             // gekozen thumbnail (image)
      has_video,                 // true/false: er was ook video aanwezig
      ad_kind,                   // "IMAGE" | "CAROUSEL" | "VIDEO"
      carousel_count,            // >0 bij carrousel
      target                     // welke URL is gescrapet
    });
  } catch (e) {
    return res.status(500).json({ ok: false, code: "SCRAPE_ERROR", message: String(e?.message || e) });
  } finally {
    releaseSlot();
  }
});

app.listen(process.env.PORT || 8080, () => console.log("scraper listening"));
