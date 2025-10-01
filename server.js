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
  if (!/(facebook\.(com|net)|fbcdn|scontent|cdninstagram)/i.test(u)) return false;
  if (/rsrc\.php|hsts-pixel|sprite|emoji|\/p50x50\//i.test(u)) return false;
  return true;
}

function candidateTargets(id) {
  return [
    `https://www.facebook.com/ads/library/?id=${id}`,
    `https://www.facebook.com/ads/library/ad/?id=${id}`,
    `https://m.facebook.com/ads/library/?id=${id}`,
    `https://mbasic.facebook.com/ads/library/?id=${id}`,
    // legacy fallback:
    `https://www.facebook.com/ads/archive/render_ad/?id=${id}`,
  ];
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
    /(facebook\.(com|net)|fbcdn|scontent|cdninstagram)/i.test(u) &&
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

// ------------- Filter & Ranking (belangrijk) -------------
function filterAndRankMedia(mediaIn) {
  // dedup
  const seen = new Set();
  let media = [];
  for (const m of mediaIn) {
    if (!m?.url) continue;
    const key = m.kind + "|" + m.url;
    if (!seen.has(key)) { seen.add(key); media.push(m); }
  }

  // rommel/kleine plaatjes eruit
  const BAD = /(empty-state|overfiltering|politics\/archive|sprite|emoji|p50x50|s60x60|s96x96|s148x148|\/v\/t39\.30808-1\/)/i;
  media = media.filter(m => !BAD.test(m.url));

  // score voor sortering
  const SIZE_HINT = /(s1200x1200|s2048x2048|s1920x1080|s1280x720|s1080x1080|s960x960|s720x720|s600x600)/i;
  function score(m) {
    let s = 0;
    if (m.kind === "video") s += 100;
    if (SIZE_HINT.test(m.url)) s += 40;
    if (/safe_image\.php/i.test(m.url)) s += 10;     // vaak de echte creative
    if (/profile|avatar/i.test(m.url)) s -= 30;      // avatars omlaag
    return s;
  }

  media.sort((a,b) => score(b) - score(a));
  const best = media[0] || null;
  return { media, thumbnail_url: best ? best.url : null };
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
  let usedTarget = null;

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

    let media = [], thumbnail_url = null;

    // Probeer meerdere targets; stop zodra we iets bruikbaars hebben
    for (const t of candidateTargets(id)) {
      try {
        await gotoWithRetry(page, t);
        await tryAcceptCookies(page);

        try { await page.waitForSelector('img, meta[property="og:image"]', { timeout: 6000 }); } catch {}
        await autoScroll(page);
        await sleep(800);

        // DOM + iframes
        media = await collectAllFrames(page);

        // netwerk-fallback toevoegen als DOM niets gaf
        if (media.length === 0 && sniff.length > 0) {
          const uniq = new Map();
          for (const m of sniff) if (allowUrl(m.url) && !uniq.has(m.url)) uniq.set(m.url, m);
          media = Array.from(uniq.values());
        }

        // filter & ranking
        ({ media, thumbnail_url } = filterAndRankMedia(media));

        // “niet beschikbaar” → probeer volgende
        if (media.length === 0) {
          const bodyText = (await page.evaluate(() => document.body.innerText).catch(() => "")).toLowerCase();
          if (/niet beschikbaar|not available|no está disponible|nicht verfügbar/.test(bodyText)) continue;
        }

        if (media.length > 0) { usedTarget = t; break; }
      } catch { /* volgende target */ }
    }

    // laatste redmiddel: reload van laatste kandidaat
    if (!usedTarget) {
      const last = candidateTargets(id).at(-1);
      await gotoWithRetry(page, last);
      await sleep(700);
      media = await collectAllFrames(page);
      ({ media, thumbnail_url } = filterAndRankMedia(media));
      usedTarget = last;
    }

    await page.close();
    res.set("Cache-Control", "public, max-age=600");
    return res.json({ ok: true, media, thumbnail_url, target: usedTarget });
  } catch (e) {
    return res.status(500).json({ ok: false, code: "SCRAPE_ERROR", message: String(e?.message || e) });
  } finally {
    releaseSlot();
  }
});

app.listen(process.env.PORT || 8080, () => console.log("scraper listening"));
