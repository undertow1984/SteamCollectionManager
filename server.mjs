import express from 'express';
import fs from 'fs/promises';
import { existsSync, readFileSync, mkdirSync, renameSync, statSync, appendFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { HLTBClient } from 'hltb-client';
import { JSDOM, VirtualConsole } from 'jsdom';

const execAsync = promisify(exec);

const hltbClient = new HLTBClient();

// Silent VirtualConsole for JSDOM (used only for Metacritic scraping).
// Prevents "Error: Could not parse CSS stylesheet" + full stylesheet dumps
// from flooding the console. Metacritic pages have complex CSS that JSDOM's
// parser rejects; we only need the DOM tree for XPath queries on scores.
const silentVirtualConsole = new VirtualConsole();
silentVirtualConsole.on('error', () => {});
silentVirtualConsole.on('warn', () => {});
silentVirtualConsole.on('jsdomError', () => {});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let DATA_DIR = process.env.STEAMCOLLECTIONMANAGER_DATA_DIR || __dirname;

// In packaged installs (even without env from old main.js), prefer a user-writable location
// to avoid EACCES when installed to Program Files etc.
if (!process.env.STEAMCOLLECTIONMANAGER_DATA_DIR && process.versions && process.versions.electron) {
  try {
    const resourcesPath = process.resourcesPath || '';
    const isPackaged = resourcesPath && !resourcesPath.includes('node_modules') && !resourcesPath.includes('dist');
    if (isPackaged) {
      const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || process.env.HOME || '', 'AppData', 'Roaming');
      DATA_DIR = path.join(appData, 'SteamCollectionManager');
    }
  } catch (e) {
    // fall back to __dirname
  }
}

try {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('Could not ensure DATA_DIR:', e.message);
}

// Subfolders for organization
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const LOG_DIR = path.join(DATA_DIR, 'log');
const CONFIG_DIR = path.join(DATA_DIR, 'config');

try {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
} catch (e) {
  console.warn('Could not ensure cache/log/config dirs:', e.message);
}

// === Logging setup (file + console, 2MB rotation) ===
const LOG_PATH = path.join(LOG_DIR, 'steam-collection-manager.log');
const MAX_LOG_SIZE = 2 * 1024 * 1024; // 2 MB

function rotateLogIfNeeded() {
  try {
    if (existsSync(LOG_PATH)) {
      const stat = statSync(LOG_PATH);
      if (stat.size > MAX_LOG_SIZE) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const archive = path.join(LOG_DIR, `steam-collection-manager-${ts}.log`);
        renameSync(LOG_PATH, archive);
      }
    }
  } catch (e) {
    // best effort
  }
}

function writeLog(level, ...args) {
  const msg = args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  try {
    rotateLogIfNeeded();
    appendFileSync(LOG_PATH, line, 'utf8');
  } catch (e) {}
  // always mirror to console too
  if (level === 'ERROR') _origError(...args);
  else if (level === 'WARN') _origWarn(...args);
  else _origLog(...args);
}

// Capture originals before overriding
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

console.log = (...args) => writeLog('INFO', ...args);
console.warn = (...args) => writeLog('WARN', ...args);
console.error = (...args) => writeLog('ERROR', ...args);

// Catch uncaughts
process.on('uncaughtException', (err) => {
  writeLog('FATAL', 'Uncaught exception:', err.stack || err.message || err);
});
process.on('unhandledRejection', (reason) => {
  writeLog('FATAL', 'Unhandled rejection:', reason?.stack || reason);
});

// Migrate legacy cache files from DATA_DIR root into cache/ (one-time for existing users)
const legacyCacheFiles = [
  'games_cache.json',
  'steam_app_list_cache.json',
  'steam_reviews_count_cache.json',
  'steam_ratings_cache.json',
  'steam_metacritic_cache.json',
  'steam_media_cache.json',
  'steam_license_cache.json',
  'steam_hltb_cache.json',
  'steam_tags_cache.json',
  'scan_status.json',
  'scanned_games.json',
  'active_games_count.txt',
  'active_appids.json'
];
for (const fname of legacyCacheFiles) {
  const oldP = path.join(DATA_DIR, fname);
  const newP = path.join(CACHE_DIR, fname);
  if (existsSync(oldP) && !existsSync(newP)) {
    try {
      renameSync(oldP, newP);
      console.log(`[migrate] Moved legacy cache file ${fname} -> cache/`);
    } catch (e) {
      console.warn(`[migrate] Failed to move ${fname}:`, e.message);
    }
  }
}

// Migrate legacy config files
const legacyConfigFiles = ['config.json', 'categories.json'];
for (const fname of legacyConfigFiles) {
  const oldP = path.join(DATA_DIR, fname);
  const newP = path.join(CONFIG_DIR, fname);
  if (existsSync(oldP) && !existsSync(newP)) {
    try {
      renameSync(oldP, newP);
      console.log(`[migrate] Moved legacy config file ${fname} -> config/`);
    } catch (e) {
      console.warn(`[migrate] Failed to move ${fname}:`, e.message);
    }
  }
}

const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const CATEGORIES_PATH = path.join(CONFIG_DIR, 'categories.json');
const CACHE_PATH = path.join(CACHE_DIR, 'games_cache.json');
const APP_LIST_CACHE_PATH = path.join(CACHE_DIR, 'steam_app_list_cache.json');
const REVIEWS_CACHE_PATH = path.join(CACHE_DIR, 'steam_reviews_count_cache.json');
const STEAM_RATINGS_CACHE_PATH = path.join(CACHE_DIR, 'steam_ratings_cache.json');
const METACRITIC_CACHE_PATH = path.join(CACHE_DIR, 'steam_metacritic_cache.json');
const MEDIA_CACHE_PATH = path.join(CACHE_DIR, 'steam_media_cache.json');
const LICENSE_CACHE_PATH = path.join(CACHE_DIR, 'steam_license_cache.json');
const HLTB_CACHE_PATH = path.join(CACHE_DIR, 'steam_hltb_cache.json');
const STEAM_TAGS_CACHE = path.join(CACHE_DIR, 'steam_tags_cache.json');
const ACTIVE_COUNT_PATH = path.join(CACHE_DIR, 'active_games_count.txt');
const ACTIVE_APPIDS_PATH = path.join(CACHE_DIR, 'active_appids.json');
const SCAN_STATUS_PATH = path.join(CACHE_DIR, 'scan_status.json');
const SCANNED_GAMES_PATH = path.join(CACHE_DIR, 'scanned_games.json');

let licenseCache = {};
let hltbCache = {};
let cachedAppMetadata = null;
let cachedAppMetadataMtime = 0;

const DEFAULT_WEB_PORT = 3000;
const DEFAULT_ELECTRON_PORT = 3001;

function getStartupPort() {
  if (process.env.PORT) {
    const p = parseInt(process.env.PORT, 10);
    if (!isNaN(p) && p > 0) return p;
  }
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf8');
      const cfg = JSON.parse(raw || '{}');
      const isElectron = !!(process.versions && process.versions.electron);
      if (isElectron) {
        const ep = parseInt(cfg.electronPort, 10);
        if (!isNaN(ep) && ep > 0) return ep;
        return DEFAULT_ELECTRON_PORT;
      } else {
        const wp = parseInt(cfg.webPort, 10);
        if (!isNaN(wp) && wp > 0) return wp;
        return DEFAULT_WEB_PORT;
      }
    }
  } catch (e) {
    console.warn('Could not read port from config, using default:', e.message);
  }
  const isElectron = !!(process.versions && process.versions.electron);
  return isElectron ? DEFAULT_ELECTRON_PORT : DEFAULT_WEB_PORT;
}

const steamTagsMap = new Map();
const reviewsCountMap = new Map();
const steamRatingsMap = new Map(); // appid -> { reviewScore: number|null, reviewPercentage: number|null } from Steam store
const metacriticScoreMap = new Map(); // appid -> score (real Metacritic from VDF/scrape OR HLTB reviewScore). Never stores nulls. HLTB reviews are written here too for the unified metacritic cache.
const mediaCache = new Map(); // appid -> { data: {screenshots, movies}, timestamp }
let lastMediaFetch = 0; // simple global rate limiter for store media requests
let activeGameCount = 0; // authoritative count of games shown in UI (post-filter); keeps cache status in sync without IO

const STEAM_GENRES = {
  1: "Action",
  2: "Strategy",
  3: "RPG",
  4: "Casual",
  9: "Racing",
  18: "Sports",
  23: "Indie",
  25: "Adventure",
  28: "Simulation",
  29: "Massively Multiplayer",
  37: "Free to Play",
  70: "Early Access",
  50: "Accounting",
  51: "Animation & Modeling",
  52: "Audio Production",
  53: "Design & Illustration",
  54: "Education",
  55: "Photo Editing",
  56: "Software Training",
  57: "Utilities",
  58: "Video Production",
  59: "Web Publishing",
  60: "Game Development"
};

async function loadReviewsCountCache() {
  if (existsSync(REVIEWS_CACHE_PATH)) {
    try {
      const data = JSON.parse(await fs.readFile(REVIEWS_CACHE_PATH, 'utf8'));
      Object.entries(data).forEach(([appid, count]) => {
        reviewsCountMap.set(Number(appid), Number(count));
      });
      console.log(`Loaded ${reviewsCountMap.size} game review counts from local cache.`);
    } catch (e) {
      console.warn("Failed to parse cached game reviews:", e);
    }
  }
}

async function loadSteamRatingsCache() {
  if (existsSync(STEAM_RATINGS_CACHE_PATH)) {
    try {
      const data = JSON.parse(await fs.readFile(STEAM_RATINGS_CACHE_PATH, 'utf8'));
      Object.entries(data).forEach(([appid, rating]) => {
        if (rating && (rating.reviewScore != null || rating.reviewPercentage != null)) {
          steamRatingsMap.set(Number(appid), {
            reviewScore: rating.reviewScore != null ? Number(rating.reviewScore) : null,
            reviewPercentage: rating.reviewPercentage != null ? Number(rating.reviewPercentage) : null
          });
        }
      });
      console.log(`Loaded ${steamRatingsMap.size} Steam ratings from local cache.`);
    } catch (e) {
      console.warn("Failed to parse cached steam ratings:", e);
    }
  }
}

async function saveSteamRatingsCache() {
  try {
    const obj = {};
    for (const [appid, rating] of steamRatingsMap.entries()) {
      obj[appid] = rating;
    }
    await fs.writeFile(STEAM_RATINGS_CACHE_PATH, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.warn("Failed to persist steam ratings cache:", e.message);
  }
}

let isCrawlingReviews = false;

async function fetchSteamReviewSummary(appid) {
  try {
    const res = await fetch(`https://store.steampowered.com/appreviews/${appid}?json=1&num_per_page=0&purchase_type=all&language=english`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.query_summary) return data.query_summary;
    return null;
  } catch (e) {
    return null;
  }
}

async function crawlMissingReviewCounts(games, options = {}) {
  const { forceUpdate = false } = options;
  if (isCrawlingReviews) return;
  isCrawlingReviews = true;
  
  // Find games to process: missing, or all if forceUpdate
  const toProcess = forceUpdate 
    ? games 
    : games.filter(g => !reviewsCountMap.has(g.appid));
  if (toProcess.length === 0) {
    isCrawlingReviews = false;
    stopReviews = false;
    // mark as completed (one-time auto after first setup)
    await markScanCompleted('reviews');
    await markScanCompleted('steamRatings');
    return;
  }
  
  console.log(`Background review crawler: checking/fetching ${toProcess.length} review counts...`);
  
  // Run asynchronously in background
  (async () => {
    try {
      let consecutive429s = 0;
      const concurrency = forceUpdate ? 10 : 1;
      const batchDelay = 150;
      for (let i = 0; i < toProcess.length; i += concurrency) {
        if (stopReviews) {
          stopReviews = false;
          break;
        }
        const batch = toProcess.slice(i, i + concurrency);
        
        // If we hit too many rate limits, pause the entire crawler for a while
        if (consecutive429s >= 3) {
          console.warn("Too many consecutive HTTP 429s. Pausing background crawler for 60 seconds...");
          await new Promise(resolve => setTimeout(resolve, 60000));
          consecutive429s = 0;
        }

        const batchPromises = batch.map(async (game) => {
          try {
            const res = await fetch(`https://store.steampowered.com/appreviews/${game.appid}?json=1&num_per_page=0&purchase_type=all&language=english`);
            if (res.status === 429) {
              consecutive429s++;
              console.warn(`Hit rate limit (HTTP 429) for appid ${game.appid}. Waiting 5 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 5000));
              // For parallel, we don't retry here (will be picked up on next run if needed)
              return;
            }
            
            consecutive429s = 0; // Reset counter on any other status

            let reviewCountResult = null;
            let ratingsResult = null;
            if (res.ok) {
              const data = await res.json();
              const summary = (data && data.query_summary) ? data.query_summary : null;
              if (summary) {
                const total = summary.total_reviews || 0;
                reviewsCountMap.set(game.appid, total);
                reviewCountResult = total;

                // Populate Steam ratings (percentage + score) from the same API response
                // This provides the "steamratings" data that supplements appinfo.vdf
                if (total > 0) {
                  const positive = summary.total_positive || 0;
                  const percentage = Math.round((positive / total) * 100);
                  const reviewScore = summary.review_score != null ? Number(summary.review_score) : null;
                  steamRatingsMap.set(game.appid, {
                    reviewScore,
                    reviewPercentage: percentage
                  });
                  ratingsResult = { reviewScore, reviewPercentage: percentage };
                } else if (!steamRatingsMap.has(game.appid)) {
                  steamRatingsMap.set(game.appid, { reviewScore: null, reviewPercentage: 0 });
                  ratingsResult = { reviewScore: null, reviewPercentage: 0 };
                }
              } else {
                // Store API returned invalid format / delisted app
                // only set for missing (populate); keep old for refresh of existing on bad response
                if (!reviewsCountMap.has(game.appid)) {
                  reviewsCountMap.set(game.appid, 0);
                }
                reviewCountResult = 0;
                if (!steamRatingsMap.has(game.appid)) {
                  steamRatingsMap.set(game.appid, { reviewScore: null, reviewPercentage: 0 });
                }
                ratingsResult = { reviewScore: null, reviewPercentage: 0 };
              }
            } else {
              // Delisted or error status (e.g. 404, 500)
              // keep old cache value for existing games; only set 0 when populating missing
              if (!reviewsCountMap.has(game.appid)) {
                reviewsCountMap.set(game.appid, 0);
              }
              reviewCountResult = 0;
              if (!steamRatingsMap.has(game.appid)) {
                steamRatingsMap.set(game.appid, { reviewScore: null, reviewPercentage: 0 });
              }
              ratingsResult = { reviewScore: null, reviewPercentage: 0 };
            }
            console.log(`[Reviews] App ${game.appid} -> HTTP ${res.status}, count: ${reviewCountResult}`);
            console.log(`[SteamRatings] App ${game.appid} -> HTTP ${res.status}, result: ${JSON.stringify(ratingsResult)}`);
          } catch (e) {
            console.warn(`Failed to fetch review count for appid ${game.appid}:`, e);
            // keep old on error for refresh; only populate 0 for never-before-seen
            if (!reviewsCountMap.has(game.appid)) {
              reviewsCountMap.set(game.appid, 0);
            }
            if (!steamRatingsMap.has(game.appid)) {
              steamRatingsMap.set(game.appid, { reviewScore: null, reviewPercentage: 0 });
            }
            console.log(`[Reviews] App ${game.appid} -> ERROR (no status), count: 0`);
            console.log(`[SteamRatings] App ${game.appid} -> ERROR (no status), result: ${JSON.stringify({ reviewScore: null, reviewPercentage: 0 })}`);
          }
        });

        await Promise.all(batchPromises);
        
        // small delay between batches (for refresh with concurrency)
        if (i + concurrency < toProcess.length) {
          await new Promise(resolve => setTimeout(resolve, batchDelay));
          if (stopReviews) {
            stopReviews = false;
            break;
          }
        }
        
        // Periodically save cache
        if (i % 25 === 0 || i + concurrency >= toProcess.length) {
          const obj = {};
          for (const [appid, count] of reviewsCountMap.entries()) {
            obj[appid] = count;
          }
          await fs.writeFile(REVIEWS_CACHE_PATH, JSON.stringify(obj), 'utf8');
          await saveSteamRatingsCache();
        }
      }
    } catch (err) {
      console.error("Error in background reviews crawler:", err);
    } finally {
      isCrawlingReviews = false;
      stopReviews = false;
      await saveSteamRatingsCache();
      console.log("Background review crawler finished.");

      // Mark as ever-completed (one-time auto after first setup)
      await markScanCompleted('reviews');
      await markScanCompleted('steamRatings');
    }
  })();
}

// Call on startup
loadReviewsCountCache();
loadSteamRatingsCache();

// ──────────────────────────────────────────────────────
// Metacritic score cache (from local VDFs or scraped from metacritic.com; nulls never stored)
// ──────────────────────────────────────────────────────
async function loadMetacriticCache() {
  if (existsSync(METACRITIC_CACHE_PATH)) {
    try {
      const data = JSON.parse(await fs.readFile(METACRITIC_CACHE_PATH, 'utf8'));
      Object.entries(data).forEach(([appid, score]) => {
        if (score !== null) metacriticScoreMap.set(Number(appid), Number(score));
        // do not record null values into the cache (failed results)
      });
      console.log(`Loaded ${metacriticScoreMap.size} metacritic scores from local cache.`);
    } catch (e) {
      console.warn("Failed to parse cached metacritic scores:", e);
    }
  }
}

async function saveMetacriticCache() {
  try {
    const obj = {};
    for (const [appid, score] of metacriticScoreMap.entries()) {
      if (score !== null) {
        obj[appid] = score;
      }
    }
    await fs.writeFile(METACRITIC_CACHE_PATH, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.warn('Failed to save metacritic cache:', e.message);
  }
}

// Seed/refresh metacritic scores from local VDF (primary source).
// Only overrides/adds VDF scores; does NOT clear other scores (from scraper or HLTB).
// Only writes the cache file if VDF actually provided new/updated scores (avoids deleting/recreating file unnecessarily).
async function seedMetacriticFromVDF() {
  const appMetadataMap = await getAppInfoMetadata();
  let updated = false;
  for (const [appid, meta] of appMetadataMap) {
    if (typeof meta.metacriticScore === 'number') {
      const id = Number(appid);
      if (metacriticScoreMap.get(id) !== meta.metacriticScore) {
        metacriticScoreMap.set(id, meta.metacriticScore);
        updated = true;
      }
    }
  }
  if (updated) {
    await saveMetacriticCache();
  }
  return appMetadataMap;
}

// Returns a score for the metacriticScore field sent to the UI.
// Priority:
// 1. Real Metacritic score (from Steam VDF appinfo or scraped from metacritic.com) or HLTB reviewScore (written into same cache)
// HLTB review scores are persisted into the metacritic cache for missing real MC scores.
function getEffectiveMetacriticScore(appid, gameName) {
  const id = Number(appid);
  if (metacriticScoreMap.has(id)) {
    const score = metacriticScoreMap.get(id);
    if (typeof score === 'number') return score;
  }
  // HLTB fallback (aggregated user review score 0-100)
  const key = String(appid);
  let hltb = hltbCache[key];
  if (!hltb && gameName) {
    const nkey = String(gameName).toLowerCase();
    hltb = hltbCache[nkey];
  }
  if (hltb && typeof hltb.reviewScore === 'number') {
    return hltb.reviewScore;
  }
  return undefined;
}

let isCrawlingMetacritic = false;
let isCrawlingMetacriticHLTB = false;
let stopMetacriticHLTB = false;

// Reusable slug for Metacritic using the exact same string replace / cleaning logic as HLTB.
// Strip apostrophes, force entire title to lowercase, replace every space with -, trim after all replaces
function getMetacriticSlug(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';
  let name = cleanSearchNameForHLTB(rawName);
  // strip apostrophes (straight and curly)
  name = name.replace(/['’]/g, '');
  // entire title lowercase
  name = name.toLowerCase();
  // every space replaced with -
  name = name.replace(/\s+/g, '-');
  // clean up: remove invalid chars, collapse multiple -, trim leading/trailing -
  name = name.replace(/[^a-z0-9-]+/g, '')
             .replace(/-+/g, '-')
             .replace(/^-|-$/g, '')
             .trim();
  return name;
}

// Scrape Metacritic score directly from metacritic.com using the specified endpoint format:
// https://www.metacritic.com/game/{slug}/?platform={platform}
// Slug built by applying full HLTB cleaning + strip apostrophes + lowercase + spaces to -.
// For each platform: try XPath (//*[@class='hero-scores']/div)[1]//span first (critic score 0-100),
// if no match then (//*[@class='hero-scores']/div)[2]//span (user score *10, integer).
// Uses JSDOM + XPath for accurate extraction.
// Only called when no score exists in local VDF or the metacritic cache.
async function scrapeMetacriticScore(gameName) {
  const slug = getMetacriticSlug(gameName);
  if (!slug) return null;

  // Try platforms in this order until we find a score: pc, playstation-2, playstation, playstation-3, playstation-4, xbox-one, xbox-360
  // For each: fetch https://www.metacritic.com/game/{slug}/?platform={platform}
  // Try XPath [1] first (critic 0-100), if no then [2] (user score *10, integer)
  const platforms = ['pc', 'playstation-2', 'playstation', 'playstation-3', 'playstation-4', 'xbox-one', 'xbox-360'];
  for (const platform of platforms) {
    const url = `https://www.metacritic.com/game/${slug}/?platform=${platform}`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': 'https://www.metacritic.com/',
        }
      });
      if (res.status === 404) continue;
      if (!res.ok) {
        if (res.status === 429 || res.status === 403) {
          console.warn(`Metacritic scrape rate limited (${res.status}) for "${gameName}" on ${platform}`);
        }
        continue;
      }
      const html = await res.text();

      // Use silent virtual console to avoid CSS parsing error floods from JSDOM
      const dom = new JSDOM(html, { virtualConsole: silentVirtualConsole });
      const doc = dom.window.document;

      // Try first XPath: (//*[@class='hero-scores']/div)[1]//span
      let xpath = `//*[@class='hero-scores']/div[1]//span`;
      let result = doc.evaluate(xpath, doc, null, 9 /* XPathResult.FIRST_ORDERED_NODE_TYPE */, null);
      let node = result.singleNodeValue;
      if (node) {
        const text = node.textContent.trim();
        const score = parseFloat(text);
        if (!isNaN(score) && score >= 0 && score <= 100) return Math.floor(score);
      }

      // If no score, try second XPath: (//*[@class='hero-scores']/div)[2]//span
      // For user score (0-10 scale), multiply by 10 and strip decimals
      xpath = `//*[@class='hero-scores']/div[2]//span`;
      result = doc.evaluate(xpath, doc, null, 9, null);
      node = result.singleNodeValue;
      if (node) {
        const text = node.textContent.trim();
        const score = parseFloat(text);
        if (!isNaN(score) && score >= 0 && score <= 10) {
          return Math.floor(score * 10);
        }
      }

      // No score on this platform's page, try next
      continue;
    } catch (e) {
      // do not log parsing errors to the console instead just say null for the result and do not place in the cache
      continue;
    }
  }
  return null;
}

async function crawlMissingMetacriticScores(games, options = {}) {
  const { forceUpdate = false, retryNulls = false } = options;
  if (isCrawlingMetacritic) return;
  isCrawlingMetacritic = true;

  // Normal: only games missing from VDF cache (or previous cache)
  // On refresh: also retry games that previously got no score (failed results not cached)
  // Skip games that already have a real (numeric) score from VDF or cache
  // If missing from VDF, scrape from metacritic.com (using HLTB cleaning logic for slug) with 1000ms between calls
  // Null values are never recorded in the cache (failed results).
  const toProcess = forceUpdate 
    ? games 
    : games.filter(g => {
        if (!metacriticScoreMap.has(g.appid)) return true; // never attempted
        const score = metacriticScoreMap.get(g.appid);
        return retryNulls && score === null; // retry only nulls on explicit refresh
      });
  if (toProcess.length === 0) {
    isCrawlingMetacritic = false;
    stopMetacritic = false;
    await markScanCompleted('metacritic');
    return;
  }

  console.log(`Background metacritic crawler: fetching ${toProcess.length} scores (scrape metacritic.com using HLTB-cleaned slug for missing VDF/cache)...`);

  (async () => {
    try {
      const concurrency = 1; // sequential calls (1 thread)
      const batchDelay = 1000; // 1000ms wait between each sequential scrape call for missing VDF data
      for (let i = 0; i < toProcess.length; i += concurrency) {
        if (stopMetacritic) {
          stopMetacritic = false;
          break;
        }
        const batch = toProcess.slice(i, i + concurrency);

        const batchPromises = batch.map(async (game) => {
          try {
            const original = game.name || '';
            const cleaned = cleanSearchNameForHLTB(original);
            console.log(`[Metacritic] App ${game.appid} -> cleaned title (substitutions applied): "${original}" -> "${cleaned}"`);

            // Scrape directly from metacritic.com as backup when VDF/cache has no score
            const score = await scrapeMetacriticScore(game.name);
            let result = score; // number or null
            if (result !== null) {
              metacriticScoreMap.set(game.appid, result);
              // Immediately write to cache mapped to SteamID
              await saveMetacriticCache();
            } else {
              // do not record null values into the cache (failed results)
              // do not log parsing errors to the console instead just say null for the result
              result = null;
            }
            console.log(`[Metacritic] App ${game.appid} -> scraped: ${result} for "${game.name}"`);
          } catch (e) {
            // do not log parsing errors to the console instead just say null for the result and do not place in the cache
            const result = null;
            console.log(`[Metacritic] App ${game.appid} -> scraped: ${result} for "${game.name}"`);
          }
        });

        await Promise.all(batchPromises);

        // small delay between batches
        if (i + concurrency < toProcess.length) {
          await new Promise(resolve => setTimeout(resolve, batchDelay));
          if (stopMetacritic) {
            stopMetacritic = false;
            break;
          }
        }

        // Save periodically
        if (i % 25 === 0 || i + concurrency >= toProcess.length) {
          await saveMetacriticCache();
        }
      }
    } catch (err) {
      console.error("Error in metacritic crawler:", err);
    } finally {
      isCrawlingMetacritic = false;
      stopMetacritic = false;
      console.log("Metacritic crawler finished.");

      // Mark as ever-completed (one-time auto after first setup)
      await markScanCompleted('metacritic');
    }
  })();
}

// Dedicated crawler for pulling HLTB review scores into the metacritic cache.
// Uses metacritic cache to decide which games need scores (not the HLTB times cache).
// Leverages fetchHLTBData (with title cleanup) but reads/writes only to metacritic cache for scores.
async function crawlMissingMetacriticScoresViaHLTB(games, options = {}) {
  const { forceUpdate = false, retryNulls = false } = options;
  if (isCrawlingMetacriticHLTB) return;
  isCrawlingMetacriticHLTB = true;

  // Decide based on metacritic cache only
  const toProcess = forceUpdate 
    ? games 
    : games.filter(g => {
        if (!metacriticScoreMap.has(g.appid)) return true;
        const score = metacriticScoreMap.get(g.appid);
        return retryNulls && score === null;
      });
  if (toProcess.length === 0) {
    isCrawlingMetacriticHLTB = false;
    await markScanCompleted('metacritic');
    return;
  }

  console.log(`Background metacritic crawler: fetching ${toProcess.length} scores (via HLTB reviews using HLTB-cleaned slug for missing VDF/cache)...`);

  (async () => {
    try {
      const concurrency = 10;
      const batchDelay = 250;
      for (let i = 0; i < toProcess.length; i += concurrency) {
        if (stopMetacriticHLTB || stopMetacritic) {
          stopMetacriticHLTB = false;
          break;
        }
        const batch = toProcess.slice(i, i + concurrency);

        const batchPromises = batch.map(async (game) => {
          try {
            const original = game.name || '';
            const cleaned = cleanSearchNameForHLTB(original);
            console.log(`[Metacritic] App ${game.appid} -> cleaned title (substitutions applied): "${original}" -> "${cleaned}"`);

            // Use HLTB fetch (title cleanup happens inside), but only for reviewScore into metacritic cache
            const entry = await fetchHLTBData(game.appid, game.name, forceUpdate || retryNulls);
            let result = (entry && typeof entry.reviewScore === 'number') ? entry.reviewScore : null;
            if (result !== null) {
              const mid = Number(game.appid);
              if (!metacriticScoreMap.has(mid)) {
                metacriticScoreMap.set(mid, result);
                await saveMetacriticCache();
              }
            } else {
              result = null;
            }
            console.log(`[Metacritic] App ${game.appid} -> HLTB reviewScore: ${result} for "${game.name}"`);
          } catch (e) {
            console.log(`[Metacritic] App ${game.appid} -> HLTB reviewScore: null for "${game.name}"`);
          }
        });

        await Promise.all(batchPromises);

        if (i + concurrency < toProcess.length) {
          await new Promise(resolve => setTimeout(resolve, batchDelay));
          if (stopMetacriticHLTB || stopMetacritic) {
            stopMetacriticHLTB = false;
            break;
          }
        }
      }
    } catch (err) {
      console.error("Error in metacritic HLTB crawler:", err);
    } finally {
      isCrawlingMetacriticHLTB = false;
      stopMetacriticHLTB = false;
      console.log("Metacritic HLTB crawler finished.");

      // Mark as ever-completed (one-time auto after first setup)
      await markScanCompleted('metacritic');
    }
  })();
}

let isCrawlingHLTB = false;
let isCrawlingLicense = false;
let isCrawlingMedia = false;

// Stop flags for cancellable crawlers (HLTB, Metacritic, Reviews/SteamRatings)
let stopHLTB = false;
let stopMetacritic = false;
let stopReviews = false;

// Helper: returns true only if we have non-null values for all three HLTB times.
// Used to decide whether to skip a game on refresh or treat as incomplete (retry).
function hasCompleteHLTBData(val) {
  if (!val || typeof val !== 'object') return false;
  return val.main != null && val.mainExtra != null && val.completionist != null;
}

async function crawlMissingHLTB(games, options = {}) {
  const { forceUpdate = false, retryNulls = false } = options;
  if (isCrawlingHLTB) {
    console.log('Background HLTB crawler: already running, refresh request ignored.');
    return;
  }
  isCrawlingHLTB = true;

  const toProcess = forceUpdate 
    ? games 
    : games.filter(g => {
        const key = String(g.appid);
        const nameKey = g.name ? g.name.toLowerCase() : null;
        const hasApp = key in hltbCache;
        const hasName = nameKey && (nameKey in hltbCache);
        const completelyMissing = !hasApp && !hasName;
        if (completelyMissing) {
          return true; // rescan ALL missing games (no entry whatsoever in HLTB cache)
        }
        const val = hltbCache[key] ?? (nameKey ? hltbCache[nameKey] : undefined);
        // When refreshing HLTB (retryNulls), also include games that already exist in the
        // HLTB cache but have missing/incomplete details (any of the 3 times is null).
        if (retryNulls) {
          if (!hasCompleteHLTBData(val)) return true;
        }
        // Auto-enrich legacy HLTB entries that are missing reviewScore (added as backup for metacritic).
        // This will force a re-search on next load to capture the aggregated review score.
        if (val && typeof val === 'object' && val.reviewScore == null) {
          return true;
        }
        return false;
      });

  if (toProcess.length === 0) {
    isCrawlingHLTB = false;
    stopHLTB = false;
    await markScanCompleted('hltb');
    console.log('Background HLTB crawler: no games require processing (all have complete data).');
    return;
  }

  const newOnly = toProcess.filter(g => {
    const key = String(g.appid);
    const nkey = g.name ? g.name.toLowerCase() : null;
    return !(key in hltbCache) && !(nkey && nkey in hltbCache);
  });
  const completelyMissingAppIds = new Set(newOnly.map(g => String(g.appid)));
  const numCompletelyMissing = newOnly.length;
  const numIncomplete = toProcess.length - numCompletelyMissing;
  if (numCompletelyMissing > 0) {
    console.log(`Background HLTB crawler: fetching ${numCompletelyMissing} completely missing entries...`);
  }
  if (numIncomplete > 0) {
    console.log(`Background HLTB crawler: re-scanning ${numIncomplete} entries (retrying incomplete HLTB data from cache)...`);
  }

  (async () => {
    try {
      const concurrency = 10; // parallel calls (10 threads)
      const batchDelay = 250; // much shorter delay between batches
      for (let i = 0; i < toProcess.length; i += concurrency) {
        if (stopHLTB) {
          stopHLTB = false;
          break;
        }
        const batch = toProcess.slice(i, i + concurrency);
        const batchPromises = batch.map(async (game) => {
          const key = String(game.appid);
          try {
            let useForce = forceUpdate || retryNulls;
            // Force re-fetch for entries that need reviewScore enrichment (for metacritic backup)
            const cur = hltbCache[key] ?? (game.name ? hltbCache[game.name.toLowerCase()] : undefined);
            if (cur && typeof cur === 'object' && cur.reviewScore == null) {
              useForce = true;
            }
            const entry = await fetchHLTBData(game.appid, game.name, useForce);
            if (entry) {
              hltbCache[key] = entry;
              // Only store under gameid (appid) key on success. Do not use title as key.

              // Write HLTB reviewScore into the same metacritic cache (for missing games).
              // Same title cleanup (via cleanSearchNameForHLTB inside fetchHLTBData) is used as usual.
              if (typeof entry.reviewScore === 'number') {
                const mid = Number(game.appid);
                if (!metacriticScoreMap.has(mid)) {
                  metacriticScoreMap.set(mid, entry.reviewScore);
                  await saveMetacriticCache();
                }
              }
            } else if (!(key in hltbCache) || hltbCache[key] == null) {
              // only set null for missing; keep previous good data for refresh of existing
              hltbCache[key] = null;
            }
          } catch (e) {
            if (completelyMissingAppIds.has(String(game.appid))) {
              console.warn(`HLTB fetch error for ${game.appid}:`, e);
            }
            hltbCache[key] = null;
          }
        });
        await Promise.all(batchPromises);
        // small delay between batches
        if (i + concurrency < toProcess.length) {
          await new Promise(r => setTimeout(r, batchDelay));
          if (stopHLTB) {
            stopHLTB = false;
            break;
          }
        }
      }
      await saveHLTBCache();
    } catch (err) {
      console.error("Error in HLTB crawler:", err);
    } finally {
      isCrawlingHLTB = false;
      stopHLTB = false;
      console.log("HLTB crawler finished.");

      // Mark as ever-completed (one-time auto after first setup)
      await markScanCompleted('hltb');
    }
  })();
}

async function crawlMissingMedia(games, options = {}) {
  const { forceUpdate = false } = options;
  if (isCrawlingMedia) return;
  isCrawlingMedia = true;

  const toProcess = forceUpdate 
    ? games 
    : games.filter(g => {
        const cached = mediaCache.get(g.appid);
        return !cached || !cached.data;
      });

  if (toProcess.length === 0) {
    isCrawlingMedia = false;
    return;
  }

  console.log(`Background media crawler: fetching ${toProcess.length} entries...`);

  (async () => {
    try {
      for (let i = 0; i < toProcess.length; i++) {
        const game = toProcess[i];
        await fetchSteamMedia(game.appid, forceUpdate);
        await new Promise(r => setTimeout(r, 1200)); // rate limit friendly, matches the internal limiter
      }
      await saveMediaCache();
    } catch (err) {
      console.error("Error in media crawler:", err);
    } finally {
      isCrawlingMedia = false;
      console.log("Media crawler finished.");
    }
  })();
}

// Call on startup
loadMetacriticCache();

// Persistent media (screenshots + movies) cache on disk so we don't hammer Steam on every restart
async function loadMediaCache() {
  if (existsSync(MEDIA_CACHE_PATH)) {
    try {
      const data = JSON.parse(await fs.readFile(MEDIA_CACHE_PATH, 'utf8'));
      Object.entries(data).forEach(([appid, entry]) => {
        mediaCache.set(Number(appid), entry);
      });
      console.log(`Loaded ${mediaCache.size} game media entries from disk cache.`);
    } catch (e) {
      console.warn("Failed to load media cache:", e.message);
    }
  }
  // Prune old cache entries that lack the new info fields so they get refreshed on next use
  let pruned = 0;
  for (const [appid, entry] of mediaCache) {
    const d = entry.data || {};
    const hasInfo = d.short_description || d.detailed_description || (d.developers && d.developers.length) || (d.publishers && d.publishers.length);
    if (!hasInfo) {
      mediaCache.delete(appid);
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`Pruned ${pruned} outdated media cache entries (missing dev/pub/desc).`);
    // no need to save yet, will save on next fetch
  }
}
loadMediaCache();

async function loadLicenseCache() {
  try {
    if (existsSync(LICENSE_CACHE_PATH)) {
      const raw = await fs.readFile(LICENSE_CACHE_PATH, 'utf8');
      licenseCache = JSON.parse(raw);
    }
  } catch (err) {
    console.warn('Failed to load license cache:', err.message);
    licenseCache = {};
  }
}

async function saveLicenseCache() {
  try {
    await fs.writeFile(LICENSE_CACHE_PATH, JSON.stringify(licenseCache, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to save license cache:', err.message);
  }
}

function containsDemoWord(str) {
  return /\bdemo\b/i.test(str || '');
}

loadLicenseCache();

// ──────────────────────────────────────────────────────
// HowLongToBeat (HLTB) cache
// ──────────────────────────────────────────────────────
async function loadHLTBCache() {
  if (existsSync(HLTB_CACHE_PATH)) {
    try {
      const data = JSON.parse(await fs.readFile(HLTB_CACHE_PATH, 'utf8'));
      hltbCache = data;
      console.log(`Loaded ${Object.keys(hltbCache).length} HowLongToBeat entries from local cache.`);
    } catch (e) {
      console.warn("Failed to parse cached HLTB data:", e);
      hltbCache = {};
    }
  }
}

async function saveHLTBCache() {
  try {
    await fs.writeFile(HLTB_CACHE_PATH, JSON.stringify(hltbCache, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Failed to save HLTB cache:', err.message);
  }
}

// Remove trademark, registered, copyright symbols (unicode + parenthetical text)
// from game names before HLTB search, as they often prevent matches.
function cleanSearchNameForHLTB(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';
  let name = rawName;

  // Ellipsis handling: replace "... " with a space; replace "..." with nothing.
  // If "..." removal is in the middle of a word (between non-spaces), replace with space to prevent gluing.
  name = name.replace(/\.\.\. /g, ' ');
  name = name.replace(/(\S)\.\.\.(\S)/g, '$1 $2');
  name = name.replace(/\.\.\./g, '');

  // Unicode symbols: ™ (U+2122), ® (U+00AE), © (U+00A9) — use space for mid-"word" removals
  name = name.replace(/[\u2122\u00AE\u00A9]/g, ' ');

  // Remove specific prefixes like [NINJA GAIDEN: Master (from some re-releases/collections)
  name = name.replace(/\s*\[?\s*NINJA\s+GAIDEN\s*:\s*Master\s*/gi, ' ');

  // Parenthesized or bracketed versions: (TM), (R), (C), [TM], etc.
  name = name.replace(/\s*[\(\[]\s*(TM|R|C|trademark|registered|copyright)\s*[\)\]]\s*/gi, ' ');

  // Remove additional parenthetical disambiguators like (Classic), (2022), (Original Version), etc.
  name = name.replace(/\s*[\(\[][^)\]]*?(classic|\d{4}|original version|single player|multiplayer|multi player)[^)\]]*[\)\]]/gi, ' ');
  // Also strip any remaining (YYYY) or (Classic) etc.
  name = name.replace(/\s*[\(\[]\s*(classic|\d{4}|original version|single player|multiplayer)[^)\]]*[\)\]]/gi, ' ');

  // Standalone TM/R/C as whole words (e.g. "Game TM", "Game R") — space to avoid mid-word glue
  name = name.replace(/\s+(TM|R|C)\b/gi, ' ');
  name = name.replace(/\b(TM|R|C)\s+/gi, ' ');

  // Remove year disambiguators commonly added to Steam titles but not present on HLTB,
  // e.g. "Doom (2016)", "Game [2023]", "Title (2020)" — use space
  name = name.replace(/\s*[\(\[]\s*\d{4}\s*[\)\]]/g, ' ');

  // Remove common title separators (- : – —) that often prevent HLTB matches.
  // e.g. "Half-Life 2" -> "Half Life 2", "Witcher 3: Wild Hunt" -> "Witcher 3 Wild Hunt"
  name = name.replace(/[\-–—:]/g, ' ');

  // Remove common edition/version suffixes that cause HLTB title mismatches.
  // These often appear on Steam ("Foo - Special Edition") but not on HowLongToBeat.
  const editionSuffixes = [
    // Longer/more specific first to avoid partial matches
    'game of the year edition',
    'digital deluxe edition',
    'maximum edition',
    "collector's edition",
    'collectors edition',
    'special edition',
    'classic edition',
    'classic version',
    'original version',
    'goty edition',
    'deluxe edition',
    'ultimate edition',
    'complete edition',
    'collection',
    'anniversary edition',
    'legendary edition',
    'enhanced edition',
    'definitive edition',
    'gold edition',
    'platinum edition',
    'premium edition',
    'legacy edition',
    'reloaded edition',
    'limited edition',
    'standard edition',
    'console edition',
    'steam edition',
    'remastered',
    'remaster',
    'remake',
    "director's cut",
    'directors cut',
    'classic',
    'beta',
    'legacy',
    'single player',
    'multiplayer',
    'multi player',
  ];

  for (const suffix of editionSuffixes) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Remove the suffix globally (handles leading, middle, trailing, with or without separators)
    // e.g. "Maximum Edition Game", "Game - Special Edition", "Title (GOTY Edition)"
    const re = new RegExp(`(?:\\s*[-–—:]+\\s*|\\s*[\\(\\[]\\s*|\\s+)?${escaped}(?:\\s*[\\)\\]]?)?`, 'gi');
    name = name.replace(re, ' ');
  }

  // Remove the word "collection" (as whole word) from titles, using space replace for mid-word safety
  name = name.replace(/\bcollection\b/gi, ' ');

  // Replace ALL remaining ( ) [ ] characters (covers (beta), [Legacy], [NINJA GAIDEN: Master ...], etc.)
  name = name.replace(/[\(\)\[\]]/g, ' ');

  // Normalize whitespace and trim (again after edition stripping)
  name = name.replace(/\s+/g, ' ').trim();

  // Strip trailing separators/punctuation that sometimes remain
  name = name.replace(/[\s\-–—:,]+$/g, '').trim();

  return name;
}

async function fetchHLTBData(appid, name, force = false) {
  if (!appid && !name) return null;

  const appKey = appid != null ? String(appid) : null;
  const nameKey = name ? name.toLowerCase().trim() : null;

  // Check cache preferring gameid (appid) key. Fall back to name key only for legacy entries.
  let cachedValue = undefined;
  let hitKey = null;
  const hadEntry = (appKey && appKey in hltbCache) || (nameKey && nameKey in hltbCache);
  if (appKey && (appKey in hltbCache)) {
    cachedValue = hltbCache[appKey];
    hitKey = appKey;
  } else if (nameKey && (nameKey in hltbCache)) {
    cachedValue = hltbCache[nameKey];
    hitKey = nameKey;
  }

  if (!force && cachedValue !== undefined) {
    return cachedValue;
  }

  // Prefer appid as the key for any writes (nulls or data). Only fall back to name if no appid.
  const storeKey = appKey || nameKey || '';

  if (!name) {
    if (storeKey && (!(storeKey in hltbCache) || hltbCache[storeKey] == null)) {
      hltbCache[storeKey] = null;
      await saveHLTBCache();
    }
    if (!hadEntry) {
      console.log(`[HLTB] App ${appid} -> no name provided for search`);
    }
    return null;
  }

  const searchName = cleanSearchNameForHLTB(name);

  if (!hadEntry) {
    console.log(`[HLTB] App ${appid} -> cleaned title (substitutions applied): "${name}" -> "${searchName}"`);
  }

  try {
    if (!hadEntry) {
      console.log(`[HLTB] App ${appid} -> searching for "${searchName || name}" via hltb-client`);
    }
    const game = await hltbClient.searchOne(searchName || name);

    if (!game) {
      if (storeKey && (!(storeKey in hltbCache) || hltbCache[storeKey] == null)) {
        hltbCache[storeKey] = null;
        await saveHLTBCache();
      }
      if (!hadEntry) {
        console.log(`[HLTB] App ${appid} -> no results (searched: "${searchName || name}")`);
      }
      return null;
    }

    const ct = game.completionTimes || {};
    const entry = {
      main: ct.main != null ? ct.main : null,
      mainExtra: ct.mainExtra != null ? ct.mainExtra : null,
      completionist: ct.completionist != null ? ct.completionist : null,
      reviewScore: (typeof game.reviewScore === 'number' ? game.reviewScore : null)
    };

    const hasTimes = entry.main != null || entry.mainExtra != null || entry.completionist != null;
    const hasReview = typeof game.reviewScore === 'number';

    if (!hasTimes && !hasReview) {
      if (storeKey && (!(storeKey in hltbCache) || hltbCache[storeKey] == null)) {
        hltbCache[storeKey] = null;
      }
      if (!hadEntry) {
        console.log(`[HLTB] App ${appid} -> no times (searched: "${searchName || name}")`);
      }
    } else {
      // Success: write ONLY under the gameid (appid) key when available. Never the title.
      // Include reviewScore (HLTB aggregated user review score) even if no completion times.
      const successKey = appKey || nameKey;
      if (successKey) {
        hltbCache[successKey] = entry;
      }
      if (!hadEntry) {
        console.log(`[HLTB] App ${appid} -> success "${name}" (searched: "${searchName || name}"): ${JSON.stringify(entry)}`);
      }
    }

    await saveHLTBCache();
    return entry;
  } catch (e) {
    const searched = searchName || name;
    if (!hadEntry) {
      console.warn(`[HLTB] App ${appid} -> search failed (searched: "${searched}"):`, e && e.message ? e.message : e);
    }
    if (storeKey && (!(storeKey in hltbCache) || hltbCache[storeKey] == null)) {
      hltbCache[storeKey] = null;
      await saveHLTBCache();
    }
    return null;
  }
}

loadHLTBCache();

// After loading both caches, promote any HLTB reviewScores (aggregated) into the metacriticScoreMap
// (and thus the metacritic cache file) for games that have no real Metacritic score.
// This fulfills writing HLTB scores to the same metacritic cache. Title cleanup already happened in HLTB path.
let hltbScoresPromoted = false;
for (const [k, val] of Object.entries(hltbCache)) {
  if (val && typeof val.reviewScore === 'number') {
    const id = Number(k);
    if (!isNaN(id) && !metacriticScoreMap.has(id)) {
      metacriticScoreMap.set(id, val.reviewScore);
      hltbScoresPromoted = true;
    }
  }
}
if (hltbScoresPromoted) {
  saveMetacriticCache();
}

async function hasValidSteamLicense(appid, apiKey, steamId, force = false) {
  const key = String(appid);
  if (!force && key in licenseCache) {
    return licenseCache[key];
  }

  let result = true; // default to licensed (valid access) unless we see a clear denial error
  try {
    const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${apiKey}&steamid=${steamId}&appid=${appid}`;
    const res = await fetch(url);
    if (!res.ok) {
      result = false;
    } else {
      const data = await res.json();
      if (data.playerstats && data.playerstats.error) {
        const err = String(data.playerstats.error).toLowerCase();
        if (err.includes('no stats') || err.includes('no player stats')) {
          result = true; // owned but game has no achievements (common for many free games and some others)
        } else if (err.includes('access denied') || err.includes('denied') || err.includes('not owned') || err.includes('no license') || err.includes('license') || err.includes('profile is not public') || err.includes('private')) {
          result = false; // clear no license / no access (e.g. refunded, removed, restricted)
        } else {
          // Other error but HTTP was ok — treat as licensed (some F2P or edge cases)
          result = true;
        }
      } else if (data.playerstats && data.playerstats.success === false) {
        result = false;
      } else {
        result = true;
      }
    }
  } catch (e) {
    console.warn(`License check failed for app ${appid}:`, e.message);
    result = false;
  }

  const wasNew = !(key in licenseCache);
  licenseCache[key] = result;
  if (!result && wasNew) {
    console.log(`Skipping app ${appid} - no valid license (GetPlayerAchievements error, not 'no stats')`);
  }
  await saveLicenseCache();
  return result;
}

async function saveMediaCache() {
  try {
    const obj = {};
    for (const [appid, entry] of mediaCache.entries()) {
      obj[appid] = entry;
    }
    await fs.writeFile(MEDIA_CACHE_PATH, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.warn("Failed to persist media cache:", e.message);
  }
}

// Prune all per-game scan caches (reviews, metacritic, hltb, media, license) down to only
// the currently active (filtered, interface-visible) games. Prevents processed counts
// from exceeding the shown total (due to stale/removed games from prior library states).
function pruneScanCachesTo(activeGames, licenseRelevantAppIds = null) {
  try {
    const activeAppIds = new Set((activeGames || []).map(g => Number(g.appid)));
    const activeNames = new Set((activeGames || []).map(g => (g.name || '').toLowerCase()).filter(Boolean));

    // reviews
    for (const [id] of reviewsCountMap) {
      if (!activeAppIds.has(Number(id))) reviewsCountMap.delete(id);
    }
    // steam ratings (review percentage/score)
    for (const [id] of steamRatingsMap) {
      if (!activeAppIds.has(Number(id))) steamRatingsMap.delete(id);
    }
    // metacritic
    for (const [id] of metacriticScoreMap) {
      if (!activeAppIds.has(Number(id))) metacriticScoreMap.delete(id);
    }
    // media
    for (const [id] of mediaCache) {
      if (!activeAppIds.has(Number(id))) mediaCache.delete(id);
    }
    // hltb: clean numeric + stale name keys (appid keys always kept for active; names are fallback lookup)
    for (const key of Object.keys(hltbCache)) {
      const num = Number(key);
      if (!isNaN(num)) {
        if (!activeAppIds.has(num)) delete hltbCache[key];
      } else {
        if (!activeNames.has(key)) delete hltbCache[key];
      }
    }
    // license: use broader relevant set (primary owned + vdf + library etc) so that
    // "no license" (false) entries for still-tracked candidates are kept.
    // This prevents re-running license API checks every UI load for games that
    // fail license but still appear in VDF/librarycache candidates.
    // Only drop license entries for apps that have completely disappeared from library signals.
    const licSet = licenseRelevantAppIds || activeAppIds;
    for (const key of Object.keys(licenseCache)) {
      if (!licSet.has(Number(key))) delete licenseCache[key];
    }
  } catch (e) {
    console.warn('pruneScanCachesTo error:', e.message);
  }
}

// Fetch screenshots + videos (movies) for a game using Steam Store API.
// Persistent disk cache + global rate limiting + fallback to store page scraping.
async function fetchSteamMedia(appId, force = false) {
  const cached = mediaCache.get(appId);
  const CACHE_TTL = 24 * 60 * 60 * 1000;   // 24 hours for good results (much more stable)
  const EMPTY_TTL = 2 * 60 * 1000;         // 2 minutes for failures (allows quick retry)

  if (cached) {
    const data = cached.data || {};
    const hasMediaContent = (data.screenshots?.length || 0) + (data.movies?.length || 0) > 0;
    const hasInfo = data.short_description || data.detailed_description || (data.developers && data.developers.length) || (data.publishers && data.publishers.length);
    if (!force && hasMediaContent && hasInfo && (Date.now() - cached.timestamp < CACHE_TTL)) {
      return data;
    }
    // otherwise refetch to get fresh info or media (force bypasses TTL for explicit refresh)
  }

  // Simple rate limiter: at most one media request per ~1200ms
  const now = Date.now();
  const wait = Math.max(0, 1200 - (now - lastMediaFetch));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastMediaFetch = Date.now();

  // Primary: the official (but rate limited) appdetails JSON
  const urlsToTry = [
    `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=en`,
    `https://store.steampowered.com/api/appdetails?appids=${appId}`
  ];

  let result = { screenshots: [], movies: [], short_description: '', detailed_description: '', developers: [], publishers: [] };

  for (let attempt = 0; attempt < urlsToTry.length; attempt++) {
    const url = urlsToTry[attempt];
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'SteamCollectionManager/1.0' } });

      if (resp.status === 429) {
        console.warn(`[media] 429 rate limit for ${appId}`);
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      if (!resp.ok) continue;

      const json = await resp.json();
      const entry = json[String(appId)] || json[appId];
      if (entry && entry.success && entry.data) {
        const data = entry.data;
        result.screenshots = (data.screenshots || []).map(s => ({
          id: s.id,
          thumbnail: s.path_thumbnail,
          full: s.path_full
        }));
        result.movies = (data.movies || []).map(m => {
          // Extract best direct progressive URLs when present (older titles)
          let mp4 = null;
          let webm = null;
          if (m.mp4) {
            if (typeof m.mp4 === 'string') mp4 = m.mp4;
            else mp4 = m.mp4.max || m.mp4['1080'] || m.mp4['720'] || m.mp4['480'] || Object.values(m.mp4)[0] || null;
          }
          if (m.webm) {
            if (typeof m.webm === 'string') webm = m.webm;
            else webm = m.webm.max || m.webm['1080'] || m.webm['720'] || m.webm['480'] || Object.values(m.webm)[0] || null;
          }
          // Prefer hls_h264 for adaptive (widely supported via hls.js); also capture dash as fallback stream info
          const stream = m.hls_h264 || m.hls_av1 || m.dash_h264 || null;
          return {
            id: m.id,
            name: m.name || 'Trailer',
            thumbnail: m.thumbnail,
            mp4,
            webm,
            stream,
            highlight: !!m.highlight
          };
        });

        // Additional game info for details view
        result.short_description = data.short_description || '';
        result.detailed_description = data.detailed_description || data.about_the_game || '';
        result.developers = data.developers || [];
        result.publishers = data.publishers || [];

        if (result.screenshots.length || result.movies.length) {
          console.log(`[media] App ${appId} → ${result.screenshots.length} screenshots, ${result.movies.length} movies (appdetails)`);
          break;
        }
      }
    } catch (e) {
      console.warn(`[media] appdetails error for ${appId}:`, e.message);
    }
  }

  // Ensure we have info fields even if media attempts didn't succeed (e.g. rate limits on media)
  if (!result.short_description && !result.developers?.length) {
    try {
      const infoUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=en`;
      const resp = await fetch(infoUrl, { headers: { 'User-Agent': 'SteamCollectionManager/1.0' } });
      if (resp.ok) {
        const json = await resp.json();
        const entry = json[String(appId)] || json[appId];
        if (entry && entry.success && entry.data) {
          const data = entry.data;
          result.short_description = result.short_description || data.short_description || '';
          result.detailed_description = result.detailed_description || data.detailed_description || data.about_the_game || '';
          result.developers = result.developers?.length ? result.developers : (data.developers || []);
          result.publishers = result.publishers?.length ? result.publishers : (data.publishers || []);
        }
      }
    } catch (e) {
      console.warn(`[media] info fetch error for ${appId}:`, e.message);
    }
  }

  // Fallback: scrape the store HTML page for any visible screenshot / trailer assets
  // This helps when the JSON API is strict or returns empty for some titles.
  if (result.screenshots.length === 0 && result.movies.length === 0) {
    try {
      const pageUrl = `https://store.steampowered.com/app/${appId}/?l=en&cc=US`;
      const pageResp = await fetch(pageUrl, { headers: { 'User-Agent': 'SteamCollectionManager/1.0' } });
      if (pageResp.ok) {
        const html = await pageResp.text();

        // Extract recent style store_item_assets screenshot paths
        const ssMatches = [...html.matchAll(/store_item_assets\/steam\/apps\/[^"']+?(ss_[^"']+\.(?:jpg|png))/gi)];
        const seen = new Set();
        for (const m of ssMatches) {
          const fullUrl = 'https://shared.akamai.steamstatic.com/' + m[0];
          if (!seen.has(fullUrl)) {
            seen.add(fullUrl);
            result.screenshots.push({ id: result.screenshots.length, thumbnail: fullUrl, full: fullUrl });
          }
        }

        // Look for movie thumbnail patterns
        const movieThumbMatches = [...html.matchAll(/store_item_assets\/steam\/apps\/[^"']+?\/movie[^"']*?\.(?:jpg|png)/gi)];
        for (const m of movieThumbMatches) {
          const t = 'https://shared.akamai.steamstatic.com/' + m[0];
          result.movies.push({
            id: 'page-' + result.movies.length,
            name: 'Trailer',
            thumbnail: t,
            stream: null,
            highlight: false
          });
        }

        if (result.screenshots.length || result.movies.length) {
          console.log(`[media] App ${appId} → ${result.screenshots.length} screenshots, ${result.movies.length} movies (page scrape fallback)`);
        }
      }
    } catch (e) {
      console.warn(`[media] page scrape failed for ${appId}`);
    }
  }

  // Always persist, but don't overwrite good previous data with empty/failed result
  // (protect old cache on refresh if new fetch didn't return useful media/info)
  const prev = mediaCache.get(appId);
  const newHasUseful = (result.screenshots?.length || 0) > 0 ||
                       (result.movies?.length || 0) > 0 ||
                       result.short_description ||
                       (result.developers && result.developers.length) ||
                       (result.publishers && result.publishers.length);
  let shouldSet = true;
  if (prev && prev.data) {
    const p = prev.data;
    const prevHasUseful = (p.screenshots?.length || 0) > 0 ||
                          (p.movies?.length || 0) > 0 ||
                          p.short_description ||
                          (p.developers && p.developers.length) ||
                          (p.publishers && p.publishers.length);
    if (prevHasUseful && !newHasUseful) {
      shouldSet = false; // keep old good cache, don't delete/replace with empty on transient failure
    }
  }
  if (shouldSet) {
    mediaCache.set(appId, { data: result, timestamp: Date.now() });
    // Fire and forget disk save (don't block)
    saveMediaCache();
  }

  return shouldSet ? result : (prev && prev.data) || result;
}

async function loadSteamTags() {
  if (existsSync(STEAM_TAGS_CACHE)) {
    try {
      const data = JSON.parse(await fs.readFile(STEAM_TAGS_CACHE, 'utf8'));
      data.forEach(item => {
        steamTagsMap.set(Number(item.tagid), item.name);
      });
      console.log(`Loaded ${steamTagsMap.size} Steam tags from local cache.`);
    } catch (e) {
      console.warn("Failed to parse cached steam tags:", e);
    }
  }
  // Fetch fresh tags in background
  try {
    const res = await fetch('https://store.steampowered.com/tagdata/populartags/english');
    if (res.ok) {
      const data = await res.json();
      data.forEach(item => {
        steamTagsMap.set(Number(item.tagid), item.name);
      });
      await fs.writeFile(STEAM_TAGS_CACHE, JSON.stringify(data), 'utf8');
      console.log(`Successfully fetched and cached ${data.length} popular Steam tags.`);
    }
  } catch (err) {
    console.warn("Failed to fetch fresh Steam tags, using cached mapping:", err);
  }
}

// Call on startup
loadSteamTags();

async function getFileStat(filePath) {
  try {
    if (existsSync(filePath)) {
      return await fs.stat(filePath);
    }
  } catch (e) {}
  return null;
}

async function getGamesCount() {
  if (activeGameCount > 0) return activeGameCount;
  try {
    // Prefer the active filtered count (matches exactly the # of games shown in main interface)
    // This avoids raw games_cache.json count (which includes items filtered out by type/license/etc)
    if (existsSync(ACTIVE_COUNT_PATH)) {
      const txt = (await fs.readFile(ACTIVE_COUNT_PATH, 'utf8')).trim();
      const n = parseInt(txt, 10);
      if (!isNaN(n) && n >= 0) {
        activeGameCount = n;
        return n;
      }
    }
    if (existsSync(CACHE_PATH)) {
      const data = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
      return Array.isArray(data) ? data.length : 0;
    }
  } catch (e) {}
  return 0;
}

const app = express();
const PORT = getStartupPort();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: read file with fallback
async function readJsonFile(filePath, fallbackValue = {}) {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallbackValue;
    }
    console.error(`Error reading file ${filePath}:`, error);
    return fallbackValue;
  }
}

// Helper: write file
async function writeJsonFile(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Error writing file ${filePath}:`, error);
    throw error;
  }
}

// Scan completion tracking in external file (scan_status.json).
// These ensure the one-time automatic initial scans (after first setup) only happen once ever.
// After that, crawlers only run when user explicitly clicks the buttons in Settings.
// If app is stopped/relaunched mid-scan, it won't auto-resume or auto-run on next launch.
async function loadScanStatus() {
  if (existsSync(SCAN_STATUS_PATH)) {
    try {
      const data = JSON.parse(await fs.readFile(SCAN_STATUS_PATH, 'utf8'));
      return {
        metacritic: !!data.metacritic,
        hltb: !!data.hltb,
        reviews: !!data.reviews,
        steamRatings: !!data.steamRatings
      };
    } catch (e) {
      console.warn('Failed to parse scan_status.json, resetting:', e.message);
    }
  }
  return {
    metacritic: false,
    hltb: false,
    reviews: false,
    steamRatings: false
  };
}

async function saveScanStatus(status) {
  try {
    await fs.writeFile(SCAN_STATUS_PATH, JSON.stringify(status, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Error writing scan_status.json:`, error);
  }
}

async function markScanCompleted(type) {
  const status = await loadScanStatus();
  if (!status[type]) {
    status[type] = true;
    await saveScanStatus(status);
    console.log(`[ScanStatus] Marked ${type} scan as ever completed (one-time auto disabled).`);
  }
}

async function loadScannedGames() {
  if (existsSync(SCANNED_GAMES_PATH)) {
    try {
      const data = JSON.parse(await fs.readFile(SCANNED_GAMES_PATH, 'utf8'));
      if (Array.isArray(data)) {
        return new Set(data.map(id => Number(id)));
      }
    } catch (e) {
      console.warn('Failed to parse scanned_games.json:', e.message);
    }
  }
  return new Set();
}

async function saveScannedGames(set) {
  try {
    await fs.writeFile(SCANNED_GAMES_PATH, JSON.stringify(Array.from(set)), 'utf8');
  } catch (e) {
    console.error('Failed to save scanned_games.json:', e.message);
  }
}

async function runAutoCrawlersIfNeeded(games) {
  const scanStatus = await loadScanStatus();
  const scannedSet = await loadScannedGames();
  
  // Find any games that have never been scanned (newly introduced to library)
  const newGames = games.filter(g => !scannedSet.has(Number(g.appid)));
  
  let didChangeScanned = false;
  
  // Case A: Initial ever run of Reviews/SteamRatings
  if (!scanStatus.reviews || !scanStatus.steamRatings) {
    console.log('[Auto-Scan] First-ever Reviews/Ratings run. Scanning full library...');
    crawlMissingReviewCounts(games);
    await markScanCompleted('reviews');
    await markScanCompleted('steamRatings');
    games.forEach(g => scannedSet.add(Number(g.appid)));
    didChangeScanned = true;
  }
  
  // Case B: Initial ever run of Metacritic
  if (!scanStatus.metacritic) {
    console.log('[Auto-Scan] First-ever Metacritic run. Scanning full library...');
    crawlMissingMetacriticScores(games);
    await markScanCompleted('metacritic');
    games.forEach(g => scannedSet.add(Number(g.appid)));
    didChangeScanned = true;
  }

  // Case C: Initial ever run of HLTB
  if (!scanStatus.hltb) {
    console.log('[Auto-Scan] First-ever HLTB run. Scanning full library...');
    crawlMissingHLTB(games);
    await markScanCompleted('hltb');
    games.forEach(g => scannedSet.add(Number(g.appid)));
    didChangeScanned = true;
  }

  // Case D: New games introduced (only if initial runs have already occurred, otherwise handled by Cases A-C)
  if (scanStatus.reviews && scanStatus.steamRatings && scanStatus.metacritic && scanStatus.hltb) {
    if (newGames.length > 0) {
      console.log(`[Auto-Scan] Detected ${newGames.length} new games in library. Scanning new games only...`);
      crawlMissingReviewCounts(newGames);
      crawlMissingMetacriticScores(newGames);
      crawlMissingHLTB(newGames);
      
      // Mark these new games as scanned
      newGames.forEach(g => scannedSet.add(Number(g.appid)));
      didChangeScanned = true;
    }
  }
  
  if (didChangeScanned) {
    await saveScannedGames(scannedSet);
  }
}

// Helpers to decide if we should (re)run a scanner for new/missing games
function hasUnscannedMetacritic(games) {
  return games.some(g => !metacriticScoreMap.has(g.appid));
}

function hasUnscannedHLTB(games) {
  return games.some(g => {
    const key = String(g.appid);
    const nameKey = g.name ? g.name.toLowerCase() : null;
    const val = hltbCache[key] || (nameKey ? hltbCache[nameKey] : null);
    if (!val || typeof val !== 'object') return true;
    // consider unscanned if missing any of the main times or reviewScore (for metacritic use)
    return val.main == null || val.mainExtra == null || val.completionist == null || val.reviewScore == null;
  });
}

function hasUnscannedReviews(games) {
  return games.some(g => !reviewsCountMap.has(g.appid));
}

function hasUnscannedSteamRatings(games) {
  return games.some(g => {
    const r = steamRatingsMap.get(g.appid);
    return !r || (r.reviewScore == null && (r.reviewPercentage == null || r.reviewPercentage === 0));
  });
}

// Helper: Locate Steam install path on Windows
let cachedSteamPath = null;
let cachedAppIdsFromLocal = null;
let cachedPlaytimeFromLocal = null;

function locateSteamPath() {
  if (cachedSteamPath !== null) {
    return cachedSteamPath;
  }

  const possiblePaths = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Steam') : null,
    process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'Steam') : null,
  ].filter(Boolean);

  // Check common default locations first by looking for libraryfolders.vdf
  for (const p of possiblePaths) {
    try {
      const libFile = path.join(p, 'steamapps', 'libraryfolders.vdf');
      if (existsSync(libFile)) {
        cachedSteamPath = p;
        return p;
      }
      // Also check if steam.exe exists as fallback indicator
      if (existsSync(path.join(p, 'steam.exe'))) {
        cachedSteamPath = p;
        return p;
      }
    } catch (e) {}
  }

  // Fallback to registry
  const regKeys = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];

  for (const [key, valueName] of regKeys) {
    try {
      const output = execSync(`reg query "${key}" /v ${valueName}`, { encoding: 'utf-8' });
      // Try several regex patterns for the output format
      let match = output.match(new RegExp(`${valueName}\\s+REG_SZ\\s+(.+)`));
      if (!match) match = output.match(/InstallPath\s+REG_SZ\s+(.+)/);
      if (!match) match = output.match(/SteamPath\s+REG_SZ\s+(.+)/);
      if (match && match[1]) {
        let p = match[1].trim().replace(/\//g, '\\').replace(/"/g, '');
        // Remove trailing junk if any
        p = p.split('\r')[0].split('\n')[0].trim();
        if (existsSync(p)) {
          cachedSteamPath = p;
          return p;
        }
      }
    } catch (regError) {
      // try next
    }
  }

  console.warn("Could not locate Steam installation path.");
  cachedSteamPath = null;
  return null;
}

// Helper: Get list of installed games from local ACF manifests on the host machine
async function getInstalledGamesFromManifests() {
  const steamPath = locateSteamPath();
  if (!steamPath) {
    console.warn("Steam installation directory not found.");
    return [];
  }

  const libraryPaths = [steamPath];

  // Parse libraryfolders.vdf to find secondary libraries
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  try {
    if (existsSync(vdfPath)) {
      const vdfContent = await fs.readFile(vdfPath, 'utf-8');
      const matches = vdfContent.matchAll(/"path"\s+"([^"]+)"/g);
      for (const match of matches) {
        const libPath = match[1].replace(/\\\\/g, '\\');
        if (!libraryPaths.includes(libPath) && existsSync(libPath)) {
          libraryPaths.push(libPath);
        }
      }
    }
  } catch (err) {
    console.warn("Could not read libraryfolders.vdf:", err);
  }

  const localGames = [];

  // For each library path, list appmanifest_*.acf and parse the names
  for (const libPath of libraryPaths) {
    const steamappsPath = path.join(libPath, 'steamapps');
    try {
      if (existsSync(steamappsPath)) {
        const files = await fs.readdir(steamappsPath);
        for (const file of files) {
          const match = file.match(/^appmanifest_(\d+)\.acf$/);
          if (match) {
            const appId = parseInt(match[1], 10);
            if (isNaN(appId) || appId <= 0) continue;
            const manifestPath = path.join(steamappsPath, file);
            try {
              const content = await fs.readFile(manifestPath, 'utf-8');
              const nameMatch = content.match(/"name"\s+"([^"]+)"/);
              const name = nameMatch ? nameMatch[1] : `Steam App ${appId}`;
              localGames.push({
                appid: appId,
                name: name,
                playtime_forever: 0,
                img_icon_url: ''
              });
            } catch (readErr) {
              localGames.push({
                appid: appId,
                name: `Steam App ${appId}`,
                playtime_forever: 0,
                img_icon_url: ''
              });
            }
          }
        }
      }
    } catch (dirError) {
      console.warn(`Error reading library folder ${steamappsPath}:`, dirError);
    }
  }

  return localGames;
}

async function getGameInstallDir(appId) {
  const steamPath = locateSteamPath();
  if (!steamPath) return null;

  const libraryPaths = [steamPath];

  // Parse libraryfolders.vdf
  const vdfPath = path.join(steamPath, 'steamapps', 'libraryfolders.vdf');
  try {
    if (existsSync(vdfPath)) {
      const vdfContent = await fs.readFile(vdfPath, 'utf-8');
      const matches = vdfContent.matchAll(/"path"\s+"([^"]+)"/g);
      for (const match of matches) {
        const libPath = match[1].replace(/\\\\/g, '\\');
        if (!libraryPaths.includes(libPath) && existsSync(libPath)) {
          libraryPaths.push(libPath);
        }
      }
    }
  } catch (err) {
    console.warn("Could not read libraryfolders.vdf for install dir:", err);
  }

  for (const libPath of libraryPaths) {
    const manifestPath = path.join(libPath, 'steamapps', `appmanifest_${appId}.acf`);
    if (existsSync(manifestPath)) {
      try {
        const content = await fs.readFile(manifestPath, 'utf-8');
        const dirMatch = content.match(/"installdir"\s+"([^"]+)"/);
        if (dirMatch) {
          const installdir = dirMatch[1];
          return path.join(libPath, 'steamapps', 'common', installdir);
        }
      } catch (e) {
        console.warn(`Error reading manifest for ${appId}:`, e);
      }
    }
  }
  return null;
}

async function isGameRunning(appId) {
  try {
    const installDir = await getGameInstallDir(appId);
    if (!installDir || !existsSync(installDir)) return false;

    // Find likely game executables (top level + one level deep for common structures)
    let candidateExes = [];

    try {
      const topLevel = await fs.readdir(installDir);
      for (const f of topLevel) {
        if (f.toLowerCase().endsWith('.exe')) {
          candidateExes.push(f);
        }
      }

      // Check common subfolders (Binaries, Win64, etc.)
      const subdirs = ['Binaries', 'Binaries/Win64', 'Win64', 'x64', 'Release', 'Debug'];
      for (const sub of subdirs) {
        const subPath = path.join(installDir, sub);
        if (existsSync(subPath)) {
          const subFiles = await fs.readdir(subPath);
          for (const f of subFiles) {
            if (f.toLowerCase().endsWith('.exe')) {
              candidateExes.push(path.join(sub, f));  // keep relative for name
            }
          }
        }
      }
    } catch (e) {}

    if (candidateExes.length === 0) return false;

    // Heuristic: prefer largest exe that is NOT a crash handler or known helper
    const fullPaths = candidateExes.map(e => ({
      name: path.basename(e),
      full: path.join(installDir, e)
    }));

    // Filter out obvious non-game exes
    const filtered = fullPaths.filter(e => {
      const lower = e.name.toLowerCase();
      return !lower.includes('crash') &&
             !lower.includes('handler') &&
             !lower.includes('unitycrash') &&
             !lower.startsWith('vcredist') &&
             !lower.includes('redist');
    });

    const toCheck = filtered.length > 0 ? filtered : fullPaths;

    // Pick the largest one as primary (most reliable for main game exe)
    let primary = toCheck[0];
    try {
      let maxSize = 0;
      for (const c of toCheck) {
        if (existsSync(c.full)) {
          const stat = await fs.stat(c.full);
          if (stat.size > maxSize) {
            maxSize = stat.size;
            primary = c;
          }
        }
      }
    } catch (e) {}

    const exeName = primary.name;

    try {
      // More reliable check using PowerShell (works better with modern Windows)
      const psCmd = `powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -like '*${exeName.replace('.exe','') }*' -or $_.Path -like '*${exeName}*' } | Select-Object -First 1"`;
      const { stdout } = await execAsync(psCmd);
      if (stdout && stdout.trim().length > 0) {
        return true;
      }
    } catch (e) {}

    // Fallback: check any of the candidates with PowerShell
    for (const c of toCheck) {
      const name = c.name;
      try {
        const psCmd = `powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -like '*${name.replace('.exe','') }*' -or $_.Path -like '*${name}*' } | Select-Object -First 1"`;
        const { stdout } = await execAsync(psCmd);
        if (stdout && stdout.trim().length > 0) {
          return true;
        }
      } catch (e) {}
    }

    return false;
  } catch (e) {
    return false;
  }
}

// Helper: classify VR capabilities of a game
function getGameVRCapabilities(game, appMeta = null) {
  // 1. If we have parsed metadata from appinfo.vdf, use it as source of truth!
  if (appMeta) {
    const hasOpenVR = appMeta.openvrsupport === 1;
    const isOnlyVR = appMeta.onlyvrsupport === 1;
    if (hasOpenVR) {
      return { isVRSupported: true, isVROnly: isOnlyVR };
    }
  }

  // VR Only AppIDs (Require VR)
  const vrOnlyAppIds = [
    546560,  // Half-Life: Alyx
    620980,  // Beat Saber
    261110,  // Skyrim VR
    611660,  // Fallout 4 VR
    450390,  // The Lab
    250820,  // SteamVR
    1055540, // Boneworks
    1592190, // Bonelab
    418650,  // Space Pirate Trainer
    323910,  // SteamVR Performance Test
    450540,  // Hot Dogs, Horseshoes & Hand Grenades
    552440,  // Arizona Sunshine
  ];

  // Optional VR AppIDs (Support both VR and Desktop)
  const vrOptionalAppIds = [
    438100,  // VRChat
    1190460, // Phasmophobia
    275850,  // No Man's Sky
    287450,  // Rise of the Tomb Raider
    250900,  // PCars
    218620,  // PAYDAY 2
    286160,  // Tabletop Simulator
  ];

  const appId = game.appid;

  // 2. Explicit ID matches
  if (vrOnlyAppIds.includes(appId)) {
    return { isVRSupported: true, isVROnly: true };
  }
  if (vrOptionalAppIds.includes(appId)) {
    return { isVRSupported: true, isVROnly: false };
  }

  // 3. Keyword detection fallback
  const name = game.name ? game.name.toLowerCase() : '';
  if (name.includes('steamvr') || name.includes('oculus') || name.includes('vive') || name.includes('index')) {
    return { isVRSupported: true, isVROnly: true };
  }
  if (name.includes(' vr') || name.includes('(vr)') || name.includes('[vr]') || name.includes('vr ')) {
    // If name contains VR, it's typically VR Only (e.g. Fallout 4 VR, Skyrim VR)
    return { isVRSupported: true, isVROnly: true };
  }

  // 4. Pure desktop default
  return { isVRSupported: false, isVROnly: false };
}

// 1. GET /api/config
app.get('/api/config', async (req, res) => {
  const config = await readJsonFile(CONFIG_PATH, { 
    apiKey: '', 
    steamId: '', 
    webPort: DEFAULT_WEB_PORT, 
    electronPort: DEFAULT_ELECTRON_PORT,
    allowMultiFolderMembership: false,
    minimizeToTrayOnClose: true,
    startWithWindows: false,
    startMinimizedToTray: false,
    enableControllerShortcut: true
  });
  const scanStatus = await loadScanStatus();
  const isConfigured = !!(config.apiKey && config.steamId);
  res.json({
    apiKey: config.apiKey,
    steamId: config.steamId,
    webPort: Number(config.webPort) || DEFAULT_WEB_PORT,
    electronPort: Number(config.electronPort) || DEFAULT_ELECTRON_PORT,
    allowMultiFolderMembership: config.allowMultiFolderMembership === true,
    minimizeToTrayOnClose: config.minimizeToTrayOnClose !== false,
    startWithWindows: config.startWithWindows === true,
    startMinimizedToTray: config.startMinimizedToTray === true,
    enableControllerShortcut: config.enableControllerShortcut !== false,
    isConfigured,
    metacriticScanCompleted: scanStatus.metacritic,
    hltbScanCompleted: scanStatus.hltb,
    reviewsScanCompleted: scanStatus.reviews,
    steamRatingsScanCompleted: scanStatus.steamRatings
  });
});

// 2. POST /api/config
app.post('/api/config', async (req, res) => {
  const { apiKey, steamId, webPort, electronPort, allowMultiFolderMembership, minimizeToTrayOnClose, startWithWindows, startMinimizedToTray, enableControllerShortcut } = req.body;
  if (!apiKey || !steamId) {
    return res.status(400).json({ error: 'API Key and Steam ID are required' });
  }

  try {
    const current = await readJsonFile(CONFIG_PATH, {});
    const wp = (webPort !== undefined && webPort !== null && webPort !== '') ? Number(webPort) : (current.webPort || DEFAULT_WEB_PORT);
    const ep = (electronPort !== undefined && electronPort !== null && electronPort !== '') ? Number(electronPort) : (current.electronPort || DEFAULT_ELECTRON_PORT);
    const newConfig = {
      apiKey,
      steamId,
      webPort: (!isNaN(wp) && wp > 0) ? wp : DEFAULT_WEB_PORT,
      electronPort: (!isNaN(ep) && ep > 0) ? ep : DEFAULT_ELECTRON_PORT,
      allowMultiFolderMembership: allowMultiFolderMembership === true,
      minimizeToTrayOnClose: minimizeToTrayOnClose !== false,
      startWithWindows: startWithWindows === true,
      startMinimizedToTray: startMinimizedToTray === true,
      enableControllerShortcut: enableControllerShortcut === true
    };
    await writeJsonFile(CONFIG_PATH, newConfig);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

function mergeAndPreserveDateAdded(newGames, oldGames) {
  const oldGamesMap = new Map();
  if (Array.isArray(oldGames)) {
    oldGames.forEach(g => {
      if (g && g.appid) {
        oldGamesMap.set(g.appid, g);
      }
    });
  }

  const now = Date.now();
  return newGames.map(game => {
    const existing = oldGamesMap.get(game.appid);
    let dateAdded = now;
    if (existing) {
      dateAdded = existing.date_added !== undefined ? existing.date_added : existing.appid;
    } else {
      dateAdded = now;
    }
    return {
      ...game,
      date_added: dateAdded
    };
  });
}

// 3. GET /api/games
app.get('/api/games', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const config = await readJsonFile(CONFIG_PATH, { 
    allowMultiFolderMembership: false
  });
  if (!config || !config.apiKey || !config.steamId) {
    return res.json({ games: [], error: 'Not configured' });
  }

  let cache = await readJsonFile(CACHE_PATH, null);
  if (cache) {
    // Migration: ensure all cached games have a date_added
    let migrated = false;
    cache = cache.map(g => {
      if (g && g.date_added === undefined) {
        g.date_added = g.appid;
        migrated = true;
      }
      return g;
    });
    if (migrated) {
      await writeJsonFile(CACHE_PATH, cache);
    }
  }

  if (!cache) {
    try {
      console.log('Cache empty, performing initial fetch from Steam API...');
      const games = await fetchGamesFromSteam(config.apiKey, config.steamId);
      const gamesWithDates = mergeAndPreserveDateAdded(games, []);
      await writeJsonFile(CACHE_PATH, gamesWithDates);
      cache = gamesWithDates;
    } catch (error) {
      console.error('Initial fetch failed:', error);
      return res.json({ games: [], error: 'Failed to fetch games from Steam API. Check credentials.' });
    }
  }

  try {
    const localGames = await getInstalledGamesFromManifests();
    const localAppIds = new Set(localGames.map(g => g.appid));

    const cacheAppIds = new Set(cache.map(g => g.appid));
    const vdfAppIds = await getAppIdsFromLocalConfigs();
    const vdfSet = new Set(vdfAppIds);

    const mergedGamesMap = new Map();
    cache.forEach(game => {
      mergedGamesMap.set(game.appid, {
        ...game,
        isInstalled: localAppIds.has(game.appid),
        isVRSupported: false,
        isVROnly: false
      });
    });

    localGames.forEach(localGame => {
      if (!mergedGamesMap.has(localGame.appid) && vdfSet.has(localGame.appid)) {
        // Only introduce "extra" installed games if we have VDF evidence of current license/account tracking.
        // This prevents refunded/removed games with leftover install manifests from being included.
        mergedGamesMap.set(localGame.appid, {
          ...localGame,
          isInstalled: true,
          isVRSupported: false,
          isVROnly: false
        });
      }
    });

    const appMetadataMap = await seedMetacriticFromVDF();

    // Bootstrap steam ratings cache from local appinfo.vdf for games that don't have crawled data yet
    // This ensures steamratings cache file gets populated even before reviews crawl runs
    let ratingsBootstrapped = false;
    for (const [appid, meta] of appMetadataMap) {
      if ((meta.reviewPercentage != null || meta.reviewScore != null) && !steamRatingsMap.has(appid)) {
        steamRatingsMap.set(Number(appid), {
          reviewScore: meta.reviewScore != null ? meta.reviewScore : null,
          reviewPercentage: meta.reviewPercentage != null ? meta.reviewPercentage : null
        });
        ratingsBootstrapped = true;
      }
    }
    if (ratingsBootstrapped) {
      await saveSteamRatingsCache();
    }

    const libraryCacheAppIds = await getLibraryCacheAppIds();
    const playtimeMap = await getPlaytimeMapFromLocalConfig();

    // Read categorized AppIDs to preserve family-shared/free games that have been placed in folders
    const categories = await readJsonFile(CATEGORIES_PATH, { folders: [] });
    const categorizedAppIds = new Set();
    
    // Clean up categories.json by removing unowned, uninstalled, non-library-cached games
    let categoriesChanged = false;
    if (categories && categories.folders) {
      categories.folders.forEach(folder => {
        if (folder.appIds) {
          const originalSize = folder.appIds.length;
          folder.appIds = folder.appIds.filter(id => {
            const appid = Number(id);
            const isOwned = cacheAppIds.has(appid);
            const isInstalled = localAppIds.has(appid);
            const isLibraryCached = libraryCacheAppIds.has(appid);
            const hasPlaytime = playtimeMap.get(appid) > 0;
            const t = (appMetadataMap.get(appid)?.type || '').toLowerCase();
            const n = (appMetadataMap.get(appid)?.name || '').toLowerCase();
            const isBadType = t === 'dlc' || t.includes('dlc') || t.includes('add-on') || t.includes('addon') || t === 'tool' || t.includes('tool') || t === 'movie' || t.includes('movie') || t.includes('trailer') || t === 'demo' || t.includes('demo') || containsDemoWord(n);
            
            // Keep logic:
            // isOwned/isInstalled always wins.
            // isLibraryCached is also accepted whether or not there is playtime —
            // Steam only writes to librarycache for legitimately accessible games,
            // so it is a safe signal even for played games that don't appear in
            // GetOwnedGames (e.g. privacy restrictions, unusual license types).
            const keep = (isOwned || isInstalled || isLibraryCached) && !isBadType;
            return keep;
          });
          if (folder.appIds.length !== originalSize) {
            categoriesChanged = true;
          }
          // Build list of categorized apps for other checks
          folder.appIds.forEach(id => categorizedAppIds.add(Number(id)));
        }
      });
    }
    if (categoriesChanged) {
      console.log("Cleaning up categories.json to remove refunded/removed games...");
      await writeJsonFile(CATEGORIES_PATH, categories);
    }

    // Broader set of appids we still track (owned + vdf + librarycache + categorized).
    // Used for pruning license cache so false results for still-candidate games aren't dropped
    // (prevents re-running license API calls on every interface load).
    const licenseRelevantAppIds = new Set([
      ...cacheAppIds,
      ...vdfSet,
      ...libraryCacheAppIds,
      ...categorizedAppIds
    ]);

    // Resolve AppIDs from local VDF configs AND librarycache that aren't in the main map yet.
    // This catches games like free-to-play, family-shared, or games whose license type
    // prevents GetOwnedGames from returning them (e.g. regional, gifted, privacy-flagged).
    const candidateAppIds = new Set(vdfAppIds);
    libraryCacheAppIds.forEach(appid => candidateAppIds.add(appid));

    const missingAppIds = Array.from(candidateAppIds).filter(appid => {
      if (mergedGamesMap.has(appid)) return false;
      const isInstalled = localAppIds.has(appid);
      const isCategorized = categorizedAppIds.has(appid);
      const hasPlaytime = (playtimeMap.get(appid) || 0) > 0;
      const fromVdf = vdfSet.has(appid);
      const meta = appMetadataMap.get(appid) || {};
      const t = (meta.type || '').toLowerCase();
      const isBadType = t === 'dlc' || t.includes('dlc') || t.includes('add-on') || t.includes('addon') || t === 'tool' || t.includes('tool') || t === 'movie' || t.includes('movie') || t.includes('trailer') || t === 'demo' || t.includes('demo');
      const isFree = !!meta.isFree;
      // Include VDF-based supplements (free-to-play, family-shared, etc. that may not appear in GetOwnedGames).
      // Free games (isFree) are included even with 0 playtime (they may not be "played" yet but are in library via VDF).
      // Non-free require one of installed/categorized/hasPlaytime as ownership signal.
      // Free games are fine to show (bypass license check). Other supplements go through license check to exclude no-license/refunded items.
      // Do NOT auto-add pure librarycache items or bad types like demos.
      return fromVdf && !isBadType && (isInstalled || isCategorized || hasPlaytime || isFree);
    });

    if (missingAppIds.length > 0) {
      let appList = await readJsonFile(APP_LIST_CACHE_PATH, null);
      // Re-fetch if missing or older than 7 days so newly-added Steam apps get resolved
      const APP_LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
      let appListStale = !appList;
      if (!appListStale && existsSync(APP_LIST_CACHE_PATH)) {
        try { const stat = await fs.stat(APP_LIST_CACHE_PATH); if (Date.now() - stat.mtimeMs > APP_LIST_MAX_AGE_MS) appListStale = true; } catch(e) { /* ignore */ }
      }
      if (appListStale) {
        appList = await fetchCompleteSteamAppList(config.apiKey);
        await writeJsonFile(APP_LIST_CACHE_PATH, appList);
      }

      if (appList) {
        const appMap = new Map(appList.map(app => [app.appid, app.name]));
        const needingResolution = missingAppIds.filter(a => !appMap.has(a) && !appMetadataMap.get(a)?.name);
        if (needingResolution.length > 0) {
          console.log(`Resolving names for ${needingResolution.length} valid uninstalled/free/shared VDF games...`);
        }
        let newResolutions = false;
        for (const appid of missingAppIds) {
          let name = appMap.get(appid);
          if (!name) {
            name = appMetadataMap.get(appid)?.name;
          }
          if (!name) {
            name = await fetchAppName(appid);
            if (name) {
              console.log(`[name fallback] Resolved ${appid} -> "${name}"`);
              if (!appMap.has(appid)) {
                appList.push({ appid, name });
                appMap.set(appid, name);
                newResolutions = true;
              }
            }
          }
          if (!name) {
            name = `Unknown App ${appid}`;
          }
          if (containsDemoWord(name)) {
            continue; // do not add games whose name contains the word "demo" (but not "demon", etc.)
          }
          const meta = appMetadataMap.get(appid) || {};
          let licensed = true;
          if (!meta.isFree) {
            licensed = await hasValidSteamLicense(appid, config.apiKey, config.steamId);
          }
          if (!licensed) {
            continue;
          }
          const isInstalledForThis = localAppIds.has(appid);
          const isCatForThis = categorizedAppIds.has(appid);
          if (name.startsWith('Unknown App') && !isInstalledForThis && !isCatForThis) {
            continue; // skip unknown extras that are not installed or categorized (prevents clutter from old/stale VDF entries)
          }
          mergedGamesMap.set(appid, {
            appid: appid,
            name: name,
            playtime_forever: playtimeMap.get(appid) || 0,
            img_icon_url: '',
            isInstalled: localAppIds.has(appid),
            isVRSupported: false,
            isVROnly: false
          });
        }
        if (newResolutions) {
          await writeJsonFile(APP_LIST_CACHE_PATH, appList);
        }
      }
    }
    cache = Array.from(mergedGamesMap.values()).map(game => {
      const appMeta = appMetadataMap.get(game.appid) || {
        type: 'unknown',
        controllerSupport: 'none',
        metacriticScore: null,
        reviewScore: null,
        reviewPercentage: null,
        genres: [],
        tags: [],
        categories: [],
        openvrsupport: null,
        onlyvrsupport: null,
        isFree: false,
        releaseDate: null
      };
      const vrCaps = getGameVRCapabilities(game, appMeta);

      let controllerSupport = appMeta.controllerSupport;
      if (vrCaps.isVRSupported && controllerSupport !== 'full') {
        controllerSupport = 'full';
      }

      return {
        ...game,
        type: (appMeta.type || 'unknown').toLowerCase(),
        isVRSupported: vrCaps.isVRSupported,
        isVROnly: vrCaps.isVROnly,
        controllerSupport: controllerSupport,
        metacriticScore: getEffectiveMetacriticScore(game.appid, game.name),
        reviewScore: appMeta.reviewScore != null ? appMeta.reviewScore : (steamRatingsMap.has(game.appid) ? steamRatingsMap.get(game.appid).reviewScore : null),
        reviewPercentage: appMeta.reviewPercentage != null ? appMeta.reviewPercentage : (steamRatingsMap.has(game.appid) ? steamRatingsMap.get(game.appid).reviewPercentage : null),
        reviewCount: reviewsCountMap.has(game.appid) ? reviewsCountMap.get(game.appid) : null,
        genres: appMeta.genres || [],
        tags: appMeta.tags || [],
        categories: appMeta.categories || [],
        isFree: appMeta.isFree || false,
        releaseDate: appMeta.releaseDate,
        hltb: hltbCache[String(game.appid)] || hltbCache[game.name?.toLowerCase()] || null
      };
    });
    
    // Filter to only desired categories of library items.
    // Include: games, soundtracks, videos, software, programs, etc.
    // Explicitly exclude: DLC, add-ons, tools, movies/trailers, demos (by type or name containing the whole word "demo").
    cache = cache.filter(game => {
      const licensed = cacheAppIds.has(game.appid) || vdfSet.has(game.appid);
      if (!licensed) return false;
      const t = (appMetadataMap.get(game.appid)?.type || '').toLowerCase();
      const n = (game.name || '').toLowerCase();
      if (t === 'dlc' || t.includes('dlc') || t.includes('add-on') || t.includes('addon') || t === 'tool' || t.includes('tool') || t === 'movie' || t.includes('movie') || t.includes('trailer') || t === 'demo' || t.includes('demo') || containsDemoWord(n)) {
        return false;
      }
      return true;
    });

    // Prune scan caches + persist active count + active appids so that:
    // 1. cache status "total" matches exactly the number of games loaded in the UI
    // 2. processed counts for HLTB/metacritic/reviews/etc never exceed total (stale entries from removed games or raw vs filtered mismatch are cleaned)
    pruneScanCachesTo(cache, licenseRelevantAppIds);
    try {
      const activeIds = Array.from(new Set(cache.map(g => Number(g.appid))));
      activeGameCount = activeIds.length;
      await fs.writeFile(ACTIVE_COUNT_PATH, String(activeGameCount), 'utf8');
      await fs.writeFile(ACTIVE_APPIDS_PATH, JSON.stringify(activeIds), 'utf8');
      // Persist pruned on-disk so counts are accurate even across restarts without full re-scan
      const revObj = {}; for (const [k, v] of reviewsCountMap.entries()) revObj[k] = v;
      await fs.writeFile(REVIEWS_CACHE_PATH, JSON.stringify(revObj), 'utf8');
      await saveSteamRatingsCache();
      await saveMetacriticCache();
      await saveMediaCache();
      await saveHLTBCache();
      await saveLicenseCache();
    } catch (e) {
      console.warn('Failed to persist active count/caches after filter:', e.message);
    }

    // Trigger background crawlers only if initial scan is needed or new games are detected
    await runAutoCrawlersIfNeeded(cache);
    
  } catch (err) {
    console.error("Failed to map installation status:", err);
  }

  res.json({ games: cache });
});

// 4. POST /api/games/refresh
app.post('/api/games/refresh', async (req, res) => {
  const config = await readJsonFile(CONFIG_PATH, { 
    allowMultiFolderMembership: false
  });
  if (!config || !config.apiKey || !config.steamId) {
    return res.status(400).json({ error: 'Steam credentials not configured' });
  }

  try {
    console.log('Refreshing games list from Steam API...');
    const oldCache = await readJsonFile(CACHE_PATH, null) || [];
    const games = await fetchGamesFromSteam(config.apiKey, config.steamId);
    const gamesWithDates = mergeAndPreserveDateAdded(games, oldCache);
    await writeJsonFile(CACHE_PATH, gamesWithDates);

    // Clear local VDF caches so refresh picks up latest playtimes/configs
    cachedAppIdsFromLocal = null;
    cachedPlaytimeFromLocal = null;

    const localGames = await getInstalledGamesFromManifests();
    const localAppIds = new Set(localGames.map(g => g.appid));

    const apiGamesSet = new Set(games.map(g => g.appid));
    const vdfAppIds = await getAppIdsFromLocalConfigs();
    const vdfSet = new Set(vdfAppIds);

    const mergedGamesMap = new Map();
    games.forEach(game => {
      mergedGamesMap.set(game.appid, {
        ...game,
        isInstalled: localAppIds.has(game.appid),
        isVRSupported: false,
        isVROnly: false
      });
    });

    localGames.forEach(localGame => {
      if (!mergedGamesMap.has(localGame.appid) && vdfSet.has(localGame.appid)) {
        // Only introduce "extra" installed games if we have VDF evidence of current license/account tracking.
        // This prevents refunded/removed games with leftover install manifests from being included.
        mergedGamesMap.set(localGame.appid, {
          ...localGame,
          isInstalled: true,
          isVRSupported: false,
          isVROnly: false
        });
      }
    });

    const appMetadataMap = await seedMetacriticFromVDF();

    // Bootstrap steam ratings cache from local appinfo.vdf for games that don't have crawled data yet
    let ratingsBootstrapped = false;
    for (const [appid, meta] of appMetadataMap) {
      if ((meta.reviewPercentage != null || meta.reviewScore != null) && !steamRatingsMap.has(appid)) {
        steamRatingsMap.set(Number(appid), {
          reviewScore: meta.reviewScore != null ? meta.reviewScore : null,
          reviewPercentage: meta.reviewPercentage != null ? meta.reviewPercentage : null
        });
        ratingsBootstrapped = true;
      }
    }
    if (ratingsBootstrapped) {
      await saveSteamRatingsCache();
    }

    const libraryCacheAppIds = await getLibraryCacheAppIds();
    const playtimeMap = await getPlaytimeMapFromLocalConfig();

    // Read categorized AppIDs to preserve family-shared/free games that have been placed in folders
    const categories = await readJsonFile(CATEGORIES_PATH, { folders: [] });
    const categorizedAppIds = new Set();
    
    // Clean up categories.json by removing unowned, uninstalled, non-library-cached games
    let categoriesChanged = false;
    if (categories && categories.folders) {
      categories.folders.forEach(folder => {
        if (folder.appIds) {
          const originalSize = folder.appIds.length;
          folder.appIds = folder.appIds.filter(id => {
            const appid = Number(id);
            const isOwned = apiGamesSet.has(appid);
            const isInstalled = localAppIds.has(appid);
            const isLibraryCached = libraryCacheAppIds.has(appid);
            const hasPlaytime = playtimeMap.get(appid) > 0;
            const t = (appMetadataMap.get(appid)?.type || '').toLowerCase();
            const n = (appMetadataMap.get(appid)?.name || '').toLowerCase();
            const isBadType = t === 'dlc' || t.includes('dlc') || t.includes('add-on') || t.includes('addon') || t === 'tool' || t.includes('tool') || t === 'movie' || t.includes('movie') || t.includes('trailer') || t === 'demo' || t.includes('demo') || containsDemoWord(n);
            
            // Keep logic (same as GET /api/games — see above):
            const keep = (isOwned || isInstalled || isLibraryCached) && !isBadType;
            return keep;
          });
          if (folder.appIds.length !== originalSize) {
            categoriesChanged = true;
          }
          // Build list of categorized apps for other checks
          folder.appIds.forEach(id => categorizedAppIds.add(Number(id)));
        }
      });
    }
    if (categoriesChanged) {
      console.log("Cleaning up categories.json to remove refunded/removed games...");
      await writeJsonFile(CATEGORIES_PATH, categories);
    }

    // Broader set of appids we still track (owned + vdf + librarycache + categorized).
    // Used for pruning license cache so false results for still-candidate games aren't dropped
    // (prevents re-running license API calls on every interface load).
    const licenseRelevantAppIds = new Set([
      ...apiGamesSet,
      ...vdfSet,
      ...libraryCacheAppIds,
      ...categorizedAppIds
    ]);

    // Resolve AppIDs from local VDF configs AND librarycache that aren't in the main map yet.
    const candidateAppIds = new Set(vdfAppIds);
    libraryCacheAppIds.forEach(appid => candidateAppIds.add(appid));

    const missingAppIds = Array.from(candidateAppIds).filter(appid => {
      if (mergedGamesMap.has(appid)) return false;
      const isInstalled = localAppIds.has(appid);
      const isCategorized = categorizedAppIds.has(appid);
      const hasPlaytime = (playtimeMap.get(appid) || 0) > 0;
      const fromVdf = vdfSet.has(appid);
      const meta = appMetadataMap.get(appid) || {};
      const t = (meta.type || '').toLowerCase();
      const isBadType = t === 'dlc' || t.includes('dlc') || t.includes('add-on') || t.includes('addon') || t === 'tool' || t.includes('tool') || t === 'movie' || t.includes('movie') || t.includes('trailer') || t === 'demo' || t.includes('demo');
      const isFree = !!meta.isFree;
      // Include VDF-based supplements (free-to-play, family-shared, etc. that may not appear in GetOwnedGames).
      // Free games (isFree) are included even with 0 playtime (they may not be "played" yet but are in library via VDF).
      // Non-free require one of installed/categorized/hasPlaytime as ownership signal.
      // Free games are fine to show (bypass license check). Other supplements go through license check to exclude no-license/refunded items.
      // Do NOT auto-add pure librarycache items or bad types like demos.
      return fromVdf && !isBadType && (isInstalled || isCategorized || hasPlaytime || isFree);
    });

    if (missingAppIds.length > 0) {
      let appList = await readJsonFile(APP_LIST_CACHE_PATH, null);
      // Re-fetch if missing or older than 7 days so newly-added Steam apps get resolved
      const APP_LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
      let appListStale = !appList;
      if (!appListStale && existsSync(APP_LIST_CACHE_PATH)) {
        try { const stat = await fs.stat(APP_LIST_CACHE_PATH); if (Date.now() - stat.mtimeMs > APP_LIST_MAX_AGE_MS) appListStale = true; } catch(e) { /* ignore */ }
      }
      if (appListStale) {
        appList = await fetchCompleteSteamAppList(config.apiKey);
        await writeJsonFile(APP_LIST_CACHE_PATH, appList);
      }

      if (appList) {
        const appMap = new Map(appList.map(app => [app.appid, app.name]));
        let newResolutions = false;
        for (const appid of missingAppIds) {
          let name = appMap.get(appid);
          if (!name) {
            name = appMetadataMap.get(appid)?.name;
          }
          if (!name) {
            name = await fetchAppName(appid);
            if (name) {
              console.log(`[name fallback] Resolved ${appid} -> "${name}"`);
              if (!appMap.has(appid)) {
                appList.push({ appid, name });
                appMap.set(appid, name);
                newResolutions = true;
              }
            }
          }
          if (!name) {
            name = `Unknown App ${appid}`;
          }
          if (containsDemoWord(name)) {
            continue; // do not add games whose name contains the word "demo" (but not "demon", etc.)
          }
          const meta = appMetadataMap.get(appid) || {};
          let licensed = true;
          if (!meta.isFree) {
            licensed = await hasValidSteamLicense(appid, config.apiKey, config.steamId);
          }
          if (!licensed) {
            continue;
          }
          const isInstalledForThis = localAppIds.has(appid);
          const isCatForThis = categorizedAppIds.has(appid);
          if (name.startsWith('Unknown App') && !isInstalledForThis && !isCatForThis) {
            continue; // skip unknown extras that are not installed or categorized (prevents clutter from old/stale VDF entries)
          }
          mergedGamesMap.set(appid, {
            appid: appid,
            name: name,
            playtime_forever: playtimeMap.get(appid) || 0,
            img_icon_url: '',
            isInstalled: localAppIds.has(appid),
            isVRSupported: false,
            isVROnly: false
          });
        }
        if (newResolutions) {
          await writeJsonFile(APP_LIST_CACHE_PATH, appList);
        }
      }
    }
    let gamesWithInstalledState = Array.from(mergedGamesMap.values()).map(game => {
      const appMeta = appMetadataMap.get(game.appid) || {
        type: 'unknown',
        controllerSupport: 'none',
        metacriticScore: null,
        reviewScore: null,
        reviewPercentage: null,
        genres: [],
        tags: [],
        openvrsupport: null,
        onlyvrsupport: null,
        isFree: false
      };
      const vrCaps = getGameVRCapabilities(game, appMeta);

      let controllerSupport = appMeta.controllerSupport;
      if (vrCaps.isVRSupported && controllerSupport !== 'full') {
        controllerSupport = 'full';
      }

      return {
        ...game,
        type: (appMeta.type || 'unknown').toLowerCase(),
        isVRSupported: vrCaps.isVRSupported,
        isVROnly: vrCaps.isVROnly,
        controllerSupport: controllerSupport,
        metacriticScore: getEffectiveMetacriticScore(game.appid, game.name),
        reviewScore: appMeta.reviewScore != null ? appMeta.reviewScore : (steamRatingsMap.has(game.appid) ? steamRatingsMap.get(game.appid).reviewScore : null),
        reviewPercentage: appMeta.reviewPercentage != null ? appMeta.reviewPercentage : (steamRatingsMap.has(game.appid) ? steamRatingsMap.get(game.appid).reviewPercentage : null),
        genres: appMeta.genres || [],
        tags: appMeta.tags || [],
        isFree: appMeta.isFree || false,
        hltb: hltbCache[String(game.appid)] || hltbCache[game.name?.toLowerCase()] || null
      };
    });

    // Filter to only desired categories of library items (same as GET /api/games).
    // Explicitly exclude: DLC, add-ons, tools, movies/trailers, demos (by type or name containing the whole word "demo").
    gamesWithInstalledState = gamesWithInstalledState.filter(game => {
      const licensed = apiGamesSet.has(game.appid) || vdfSet.has(game.appid);
      if (!licensed) return false;
      const t = (appMetadataMap.get(game.appid)?.type || '').toLowerCase();
      const n = (game.name || '').toLowerCase();
      if (t === 'dlc' || t.includes('dlc') || t.includes('add-on') || t.includes('addon') || t === 'tool' || t.includes('tool') || t === 'movie' || t.includes('movie') || t.includes('trailer') || t === 'demo' || t.includes('demo') || containsDemoWord(n)) {
        return false;
      }
      return true;
    });

    // Prune + persist active count/appids (same as GET /api/games) so status counts always match UI
    pruneScanCachesTo(gamesWithInstalledState, licenseRelevantAppIds);
    try {
      const activeIds = Array.from(new Set(gamesWithInstalledState.map(g => Number(g.appid))));
      activeGameCount = activeIds.length;
      await fs.writeFile(ACTIVE_COUNT_PATH, String(activeGameCount), 'utf8');
      await fs.writeFile(ACTIVE_APPIDS_PATH, JSON.stringify(activeIds), 'utf8');
      const revObj = {}; for (const [k, v] of reviewsCountMap.entries()) revObj[k] = v;
      await fs.writeFile(REVIEWS_CACHE_PATH, JSON.stringify(revObj), 'utf8');
      await saveSteamRatingsCache();
      await saveMetacriticCache();
      await saveMediaCache();
      await saveHLTBCache();
      await saveLicenseCache();
    } catch (e) {
      console.warn('Failed to persist active count/caches after refresh filter:', e.message);
    }

    // Trigger background crawlers only if initial scan is needed or new games are detected
    await runAutoCrawlersIfNeeded(gamesWithInstalledState);

    res.json({ games: gamesWithInstalledState });
  } catch (error) {
    console.error('Refresh games failed:', error);
    res.status(500).json({ error: 'Failed to fetch games from Steam API: ' + error.message });
  }
});

// GET /api/games/check-install
app.get('/api/games/check-install', async (req, res) => {
  const appId = parseInt(req.query.appid, 10);
  if (isNaN(appId)) {
    return res.status(400).json({ error: 'Invalid AppID' });
  }

  try {
    const installedGames = await getInstalledGamesFromManifests();
    const isInstalled = installedGames.some(g => g.appid === appId);
    res.json({ appId, isInstalled });
  } catch (err) {
    console.error(`Failed to verify installation status for AppID ${appId}:`, err);
    res.status(500).json({ error: 'Failed to verify installation status' });
  }
});

// GET media (screenshots + videos) for a specific game via Steam Store API
app.get('/api/game/:appId/media', async (req, res) => {
  const appId = parseInt(req.params.appId, 10);
  if (!appId || isNaN(appId)) {
    return res.status(400).json({ error: 'Invalid AppID' });
  }
  console.log(`[media] Incoming request for app ${appId}`);
  try {
    const media = await fetchSteamMedia(appId);
    res.json(media);
  } catch (err) {
    console.error(`[media] Error for ${appId}:`, err);
    res.status(500).json({ screenshots: [], movies: [] });
  }
});

// 5. GET /api/categories
app.get('/api/categories', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const categories = await readJsonFile(CATEGORIES_PATH, { folders: [] });
  res.json(categories);
});

// 6. POST /api/categories
app.post('/api/categories', async (req, res) => {
  const { folders } = req.body;
  if (!Array.isArray(folders)) {
    return res.status(400).json({ error: 'folders must be an array' });
  }

  try {
    await writeJsonFile(CATEGORIES_PATH, { folders });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save categories' });
  }
});

// 7. POST /api/launch
app.post('/api/launch', async (req, res) => {
  const { appId } = req.body;
  if (!appId) {
    return res.status(400).json({ error: 'App ID is required' });
  }

  // Query installed status in real time to determine the Steam protocol command
  const localGames = await getInstalledGamesFromManifests();
  const isInstalled = localGames.some(g => g.appid === parseInt(appId, 10));
  const commandUri = isInstalled ? `steam://run/${appId}` : `steam://install/${appId}`;

  console.log(`Executing Steam protocol command: ${commandUri}`);
  // Launch via cmd.exe start command in Windows
  const command = `start ${commandUri}`;
  exec(command, (err) => {
    if (err) {
      console.error(`Command error for app ${appId}:`, err);
      return res.status(500).json({ error: 'Failed to execute Steam command' });
    }
    res.json({ success: true, commandUri, isInstalled });
  });
});

// Check if a specific game is currently running (for launcher minimize/restore)
app.get('/api/game-running', async (req, res) => {
  const appId = parseInt(req.query.appId || req.query.appid, 10);
  if (!appId) {
    return res.json({ running: false });
  }
  const running = await isGameRunning(appId);
  res.json({ running });
});

// Helper: Parse visible library AppIDs from Steam client's librarycache folder
async function getLibraryCacheAppIds() {
  const steamPath = locateSteamPath();
  if (!steamPath) return new Set();

  const libraryCachePath = path.join(steamPath, 'appcache', 'librarycache');
  const appIds = new Set();
  if (existsSync(libraryCachePath)) {
    try {
      const files = await fs.readdir(libraryCachePath);
      files.forEach(file => {
        // Catch bare appid dirs/files as well as common 1757610_hero.jpg, 1757610_library_*.jpg etc.
        const m = String(file).match(/^(\d+)/);
        if (m) {
          const appid = parseInt(m[1], 10);
          if (!isNaN(appid) && appid > 0) {
            appIds.add(appid);
          }
        }
      });
    } catch (e) {
      console.warn("Failed to read librarycache files:", e);
    }
  }
  return appIds;
}

// Helper: Parse playtime history (in minutes) for each AppID from localconfig.vdf
async function getPlaytimeMapFromLocalConfig() {
  if (cachedPlaytimeFromLocal) return cachedPlaytimeFromLocal;

  const steamPath = locateSteamPath();
  if (!steamPath) {
    cachedPlaytimeFromLocal = new Map();
    return cachedPlaytimeFromLocal;
  }
  const userdataPath = path.join(steamPath, 'userdata');
  const playtimeMap = new Map();

  // Only use playtime from the primary user's localconfig.vdf (config.steamId),
  // not family members' (prevents family group accumulation).
  let primaryDir = null;
  try {
    if (existsSync(CONFIG_PATH)) {
      const cfgRaw = await fs.readFile(CONFIG_PATH, 'utf8');
      const cfg = JSON.parse(cfgRaw || '{}');
      if (cfg.steamId) {
        primaryDir = (BigInt(cfg.steamId) - 76561197960265728n).toString();
      }
    }
  } catch (e) {
    console.warn("Could not determine primary SteamID for playtime:", e.message);
  }

  try {
    if (existsSync(userdataPath)) {
      const dirs = await fs.readdir(userdataPath);
      for (const dir of dirs) {
        // Only parse the primary user's localconfig (skip family members' playtime)
        if (primaryDir && dir !== primaryDir) continue;

        const localconfigPath = path.join(userdataPath, dir, 'config', 'localconfig.vdf');
        if (existsSync(localconfigPath)) {
          const content = await fs.readFile(localconfigPath, 'utf-8');
          const appsMatch = content.match(/"apps"\s*\{/i);
          if (appsMatch) {
            const appsStart = appsMatch.index + appsMatch[0].length;
            let depth = 1;
            let pos = appsStart;
            while (pos < content.length) {
              const char = content[pos];
              if (char === '{') depth++;
              else if (char === '}') {
                depth--;
                if (depth === 0) break;
              }
              pos++;
            }
            const appsBlock = content.substring(appsStart, pos);

            let currentDepth = 1;
            let currentAppId = null;
            let index = 0;
            while (index < appsBlock.length) {
              const char = appsBlock[index];
              if (char === '{') {
                currentDepth++;
                index++;
              } else if (char === '}') {
                currentDepth--;
                index++;
              } else if (char === '"') {
                let endQuote = appsBlock.indexOf('"', index + 1);
                if (endQuote === -1) break;
                const key = appsBlock.substring(index + 1, endQuote);
                
                if (currentDepth === 1) {
                  const appid = parseInt(key, 10);
                  if (!isNaN(appid) && appid > 0) {
                    currentAppId = appid;
                  }
                } else if (currentDepth === 2 && currentAppId !== null && key === 'Playtime') {
                  const valStart = appsBlock.indexOf('"', endQuote + 1);
                  if (valStart !== -1) {
                    const valEnd = appsBlock.indexOf('"', valStart + 1);
                    if (valEnd !== -1) {
                      const playtimeVal = parseInt(appsBlock.substring(valStart + 1, valEnd), 10);
                      if (!isNaN(playtimeVal)) {
                        playtimeMap.set(currentAppId, playtimeVal);
                      }
                      endQuote = valEnd;
                    }
                  }
                }
                index = endQuote + 1;
              } else {
                index++;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("Failed to parse playtime map from local config:", e);
  }
  cachedPlaytimeFromLocal = playtimeMap;
  return cachedPlaytimeFromLocal;
}

// Helper: Parse family group member SteamIDs from localconfig.vdf
async function getFamilySteamIds() {
  const steamPath = locateSteamPath();
  if (!steamPath) return [];
  
  const userdataPath = path.join(steamPath, 'userdata');
  const familySteamIds = new Set();

  try {
    if (existsSync(userdataPath)) {
      const dirs = await fs.readdir(userdataPath);
      for (const dir of dirs) {
        const configPath = path.join(userdataPath, dir, 'config', 'localconfig.vdf');
        if (existsSync(configPath)) {
          const content = await fs.readFile(configPath, 'utf-8');
          const fgIndex = content.indexOf('"FamilyGroup"');
          if (fgIndex !== -1) {
            const section = content.substring(fgIndex, fgIndex + 2000);
            const matches = section.matchAll(/"accountid"\s+"(\d+)"/g);
            for (const match of matches) {
              const accountId = parseInt(match[1], 10);
              const steamId64 = BigInt(accountId) + 76561197960265728n;
              familySteamIds.add(steamId64.toString());
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("Failed to parse family group members from localconfig.vdf:", err);
  }

  return Array.from(familySteamIds);
}

// Fetch games helper: parses and merges all Steam Family Sharing member libraries
async function fetchGamesFromSteam(apiKey, primarySteamId) {
  // Only fetch for primary userid to get its playtime exclusively.
  // (Do not fetch GetOwnedGames for family members, which would include their playtime.)
  // Family-shared games are supplemented via local VDF scans (with 0 playtime for non-primary).
  console.log(`Fetching games cache for primary userid only: ${primarySteamId}`);

  const allGamesMap = new Map();

  try {
    const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${primarySteamId}&include_appinfo=1&include_played_free_games=1&skip_unvetted_apps=0&format=json`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      const games = data.response.games || [];
      console.log(`Fetched ${games.length} games for primary ${primarySteamId} (playtime only)`);
      games.forEach(game => {
        allGamesMap.set(game.appid, game);  // primary playtime only
      });
    } else {
      console.warn(`Failed to fetch primary games: HTTP ${response.status}`);
    }
  } catch (err) {
    console.warn(`Error fetching primary games:`, err);
  }

  const finalGames = Array.from(allGamesMap.values());
  console.log(`Total games (primary playtime only): ${finalGames.length}`);
  return finalGames;
}

// Helper: Scan local config files (localconfig.vdf and sharedconfig.vdf) for all AppIDs in the library
async function getAppIdsFromLocalConfigs() {
  if (cachedAppIdsFromLocal) return cachedAppIdsFromLocal;

  const steamPath = locateSteamPath();
  if (!steamPath) {
    cachedAppIdsFromLocal = [];
    return cachedAppIdsFromLocal;
  }

  const userdataPath = path.join(steamPath, 'userdata');
  const appIds = new Set();

  try {
    if (existsSync(userdataPath)) {
      const dirs = await fs.readdir(userdataPath);
      for (const dir of dirs) {
        // 1. localconfig.vdf
        const localconfigPath = path.join(userdataPath, dir, 'config', 'localconfig.vdf');
        if (existsSync(localconfigPath)) {
          const content = await fs.readFile(localconfigPath, 'utf-8');
          const appsMatch = content.match(/"apps"\s*\{/i);
          if (appsMatch) {
            const appsStart = appsMatch.index + appsMatch[0].length;
            let depth = 1;
            let pos = appsStart;
            while (pos < content.length) {
              const char = content[pos];
              if (char === '{') depth++;
              else if (char === '}') {
                depth--;
                if (depth === 0) break;
              }
              pos++;
            }
            const appsBlock = content.substring(appsStart, pos);
            
            // Parse direct AppID keys at depth 1 using the robust depth tracker
            let currentDepth = 1;
            let index = 0;
            while (index < appsBlock.length) {
              const char = appsBlock[index];
              if (char === '{') {
                currentDepth++;
                index++;
              } else if (char === '}') {
                currentDepth--;
                index++;
              } else if (char === '"') {
                const endQuote = appsBlock.indexOf('"', index + 1);
                if (endQuote === -1) break;
                const key = appsBlock.substring(index + 1, endQuote);
                if (currentDepth === 1) {
                  const appid = parseInt(key, 10);
                  if (!isNaN(appid) && appid > 0) {
                    appIds.add(appid);
                  }
                }
                index = endQuote + 1;
              } else {
                index++;
              }
            }
          }
        }

        // 2. sharedconfig.vdf
        const sharedconfigPath = path.join(userdataPath, dir, '7', 'remote', 'sharedconfig.vdf');
        if (existsSync(sharedconfigPath)) {
          const content = await fs.readFile(sharedconfigPath, 'utf-8');
          const appsMatch = content.match(/"apps"\s*\{/i);
          if (appsMatch) {
            const appsStart = appsMatch.index + appsMatch[0].length;
            let depth = 1;
            let pos = appsStart;
            while (pos < content.length) {
              const char = content[pos];
              if (char === '{') depth++;
              else if (char === '}') {
                depth--;
                if (depth === 0) break;
              }
              pos++;
            }
            const appsBlock = content.substring(appsStart, pos);
            const appMatches = appsBlock.matchAll(/"(\d+)"\s*\{/g);
            for (const m of appMatches) {
              const appid = parseInt(m[1], 10);
              if (!isNaN(appid) && appid > 0) {
                appIds.add(appid);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("Failed to parse local VDF configs:", err);
  }

  cachedAppIdsFromLocal = Array.from(appIds);
  return cachedAppIdsFromLocal;
}

// Helper: Download the complete Steam Catalog to map AppID -> Name for missing VDF/Shared games
async function fetchCompleteSteamAppList(apiKey) {
  const allApps = [];
  let lastAppId = 0;
  let hasMore = true;

  console.log("Downloading full Steam App List via IStoreService...");

  while (hasMore) {
    const url = `https://api.steampowered.com/IStoreService/GetAppList/v1/?key=${apiKey}&max_results=50000&last_appid=${lastAppId}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`GetAppList failed: HTTP ${res.status}`);
        break;
      }
      const data = await res.json();
      const apps = data.response?.apps || [];
      if (apps.length === 0) break;

      allApps.push(...apps.map(app => ({ appid: app.appid, name: app.name })));
      hasMore = data.response?.have_more_results || false;
      lastAppId = data.response?.last_appid || 0;
    } catch (e) {
      console.error("Error paginating GetAppList:", e);
      break;
    }
  }

  console.log(`Successfully cached ${allApps.length} Steam apps!`);
  return allApps;
}

// Fallback name resolver for AppIDs missing from the full app list cache
// (e.g. some F2P, family-shared, retired, or recently added titles).
// Uses the public store appdetails endpoint (no key required for basic info).
async function fetchAppName(appid) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000); // 5s timeout so one bad lookup doesn't hang the whole request
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`;
    const res = await fetch(url, { signal: controller.signal });
    if (res.ok) {
      const json = await res.json();
      const entry = json && json[String(appid)];
      if (entry && entry.success && entry.data && entry.data.name) {
        return entry.data.name;
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn(`[name fallback] timeout for appid ${appid}`);
    } else {
      console.warn(`[name fallback] Failed for appid ${appid}:`, e.message || e);
    }
  } finally {
    clearTimeout(t);
  }
  return null;
}

function parseVdfIntChildren(buffer, startOffset) {
  const values = [];
  let pos = startOffset;
  while (pos < buffer.length) {
    const type = buffer[pos++];
    if (type === 0x08 || type === undefined) {
      break;
    }
    pos += 4; // skip key index
    
    if (type === 0x00) {
      let depth = 1;
      while (pos < buffer.length && depth > 0) {
        const t = buffer[pos++];
        if (t === 0x00) {
          pos += 4;
          depth++;
        } else if (t === 0x08) {
          depth--;
        } else if (t === 0x01) {
          pos += 4;
          while (pos < buffer.length && buffer[pos] !== 0) pos++;
          pos++;
        } else if (t === 0x02 || t === 0x03) {
          pos += 8;
        } else if (t === 0x04) {
          pos += 12;
        }
      }
    } else if (type === 0x01) {
      while (pos < buffer.length && buffer[pos] !== 0) pos++;
      pos++;
    } else if (type === 0x02) {
      if (pos + 4 <= buffer.length) {
        values.push(buffer.readUInt32LE(pos));
        pos += 4;
      }
    } else if (type === 0x03) {
      pos += 4;
    } else if (type === 0x04) {
      pos += 8;
    }
  }
  return values;
}

// Helper: Parse appinfo.vdf (primary for 'metacritic_score') and note packageinfo.vdf as potential alternative source for metadata from local Steam files.
async function getAppInfoMetadata() {
  const steamPath = locateSteamPath();
  const metadataMap = new Map(); // appid -> { controllerSupport, metacriticScore, reviewScore, reviewPercentage }
  if (!steamPath) return metadataMap;

  const appinfoPath = path.join(steamPath, 'appcache', 'appinfo.vdf');
  let mtime = 0;
  try {
    if (existsSync(appinfoPath)) {
      // Use cached metadata unless the appinfo.vdf file has been updated (e.g. by Steam client)
      const stat = await fs.stat(appinfoPath);  // note: fs here is promises
      mtime = stat.mtimeMs || 0;
      if (cachedAppMetadata && mtime === cachedAppMetadataMtime) {
        return cachedAppMetadata;
      }

      const buffer = await fs.readFile(appinfoPath);
      if (buffer.length < 16) {
        cachedAppMetadata = metadataMap;
        cachedAppMetadataMtime = mtime;
        return metadataMap;
      }

      const stringTableOffset = Number(buffer.readBigUInt64LE(8));
      const stringCount = buffer.readUInt32LE(stringTableOffset);

      // Find indices for our keys in the string table
      const keyMap = new Map();
      const targetKeys = ['name', 'type', 'controller_support', 'metacritic_score', 'review_score', 'review_percentage', 'genres', 'store_tags', 'openvrsupport', 'onlyvrsupport', 'category', 'isfreeapp', 'steam_release_date', 'original_release_date'];
      const stringTable = [];
      
      let offset = stringTableOffset + 4;
      for (let i = 0; i < stringCount; i++) {
        if (offset >= buffer.length) break;
        let end = offset;
        while (end < buffer.length && buffer[end] !== 0) {
          end++;
        }
        const str = buffer.toString('utf8', offset, end);
        stringTable.push(str);
        if (targetKeys.includes(str)) {
          keyMap.set(str, i);
        }
        offset = end + 1;
      }

      const nameIdx = keyMap.get('name');
      const typeIdx = keyMap.get('type');
      const controllerIdx = keyMap.get('controller_support');
      const metacriticIdx = keyMap.get('metacritic_score');
      const reviewScoreIdx = keyMap.get('review_score');
      const reviewPercentageIdx = keyMap.get('review_percentage');
      const genresIdx = keyMap.get('genres');
      const storeTagsIdx = keyMap.get('store_tags');
      const openvrsupportIdx = keyMap.get('openvrsupport');
      const onlyvrsupportIdx = keyMap.get('onlyvrsupport');
      const categoryIdx = keyMap.get('category');
      const isfreeappIdx = keyMap.get('isfreeapp');
      const steamReleaseDateIdx = keyMap.get('steam_release_date');
      const originalReleaseDateIdx = keyMap.get('original_release_date');

      // Create patterns for the search
      // name is string (type 0x01)
      const namePattern = nameIdx !== undefined ? Buffer.from([0x01, 0, 0, 0, 0]) : null;
      if (namePattern) namePattern.writeUInt32LE(nameIdx, 1);

      // type is string (type 0x01)
      const typePattern = typeIdx !== undefined ? Buffer.from([0x01, 0, 0, 0, 0]) : null;
      if (typePattern) typePattern.writeUInt32LE(typeIdx, 1);

      // controller_support is string (type 0x01)
      const controllerPattern = controllerIdx !== undefined ? Buffer.from([0x01, 0, 0, 0, 0]) : null;
      if (controllerPattern) controllerPattern.writeUInt32LE(controllerIdx, 1);

      // metacritic_score is 32-bit int (type 0x02)
      const metacriticPattern = metacriticIdx !== undefined ? Buffer.from([0x02, 0, 0, 0, 0]) : null;
      if (metacriticPattern) metacriticPattern.writeUInt32LE(metacriticIdx, 1);

      // steam_release_date pattern: type 0x02 (32-bit int), keyIdx
      const steamReleaseDatePattern = steamReleaseDateIdx !== undefined ? Buffer.from([0x02, 0, 0, 0, 0]) : null;
      if (steamReleaseDatePattern) steamReleaseDatePattern.writeUInt32LE(steamReleaseDateIdx, 1);

      // original_release_date pattern: type 0x02 (32-bit int), keyIdx
      const originalReleaseDatePattern = originalReleaseDateIdx !== undefined ? Buffer.from([0x02, 0, 0, 0, 0]) : null;
      if (originalReleaseDatePattern) originalReleaseDatePattern.writeUInt32LE(originalReleaseDateIdx, 1);

      // review_score is 32-bit int (type 0x02)
      const reviewScorePattern = reviewScoreIdx !== undefined ? Buffer.from([0x02, 0, 0, 0, 0]) : null;
      if (reviewScorePattern) reviewScorePattern.writeUInt32LE(reviewScoreIdx, 1);

      // review_percentage is 32-bit int (type 0x02)
      const reviewPercentagePattern = reviewPercentageIdx !== undefined ? Buffer.from([0x02, 0, 0, 0, 0]) : null;
      if (reviewPercentagePattern) reviewPercentagePattern.writeUInt32LE(reviewPercentageIdx, 1);

      // genres pattern: type 0x00 (object), keyIdx
      const genresPattern = genresIdx !== undefined ? Buffer.from([0x00, 0, 0, 0, 0]) : null;
      if (genresPattern) genresPattern.writeUInt32LE(genresIdx, 1);

      // store_tags pattern: type 0x00 (object), keyIdx
      const storeTagsPattern = storeTagsIdx !== undefined ? Buffer.from([0x00, 0, 0, 0, 0]) : null;
      if (storeTagsPattern) storeTagsPattern.writeUInt32LE(storeTagsIdx, 1);

      // openvrsupport pattern: type 0x02 (32-bit int), keyIdx
      const openvrsupportPattern = openvrsupportIdx !== undefined ? Buffer.from([0x02, 0, 0, 0, 0]) : null;
      if (openvrsupportPattern) openvrsupportPattern.writeUInt32LE(openvrsupportIdx, 1);

      // onlyvrsupport pattern: type 0x02 (32-bit int), keyIdx
      const onlyvrsupportPattern = onlyvrsupportIdx !== undefined ? Buffer.from([0x02, 0, 0, 0, 0]) : null;
      if (onlyvrsupportPattern) onlyvrsupportPattern.writeUInt32LE(onlyvrsupportIdx, 1);

      // category pattern: type 0x00 (object), keyIdx
      const categoryPattern = categoryIdx !== undefined ? Buffer.from([0x00, 0, 0, 0, 0]) : null;
      if (categoryPattern) categoryPattern.writeUInt32LE(categoryIdx, 1);

      // isfreeapp pattern: type 0x02 (32-bit int), keyIdx
      const isfreeappPattern = isfreeappIdx !== undefined ? Buffer.from([0x02, 0, 0, 0, 0]) : null;
      if (isfreeappPattern) isfreeappPattern.writeUInt32LE(isfreeappIdx, 1);

      let appOffset = 16;
      while (appOffset < stringTableOffset) {
        if (appOffset + 8 > stringTableOffset) break;
        const appid = buffer.readUInt32LE(appOffset);
        const size = buffer.readUInt32LE(appOffset + 4);

        if (appid === 0) break;

        const entryStart = appOffset + 8;
        const entryEnd = entryStart + size;
        if (entryEnd > stringTableOffset) break;

        const vdfStart = entryStart + 44;
        if (vdfStart < entryEnd) {
          const vdfBuffer = buffer.subarray(vdfStart, entryEnd);
          
          let appName = null;
          let appType = 'unknown';
          let controllerSupport = 'none';
          let metacriticScore = null;
          let reviewScore = null;
          let isFree = false;
          let reviewPercentage = null;
          let openvrsupport = null;
          let onlyvrsupport = null;
          let steamReleaseDate = null;
          let originalReleaseDate = null;
          const genres = [];
          const tags = [];
          const categories = [];

          // Search type
          if (typePattern) {
            const idx = vdfBuffer.indexOf(typePattern);
            if (idx !== -1) {
              const valStart = idx + 5;
              let valEnd = valStart;
              while (valEnd < vdfBuffer.length && vdfBuffer[valEnd] !== 0) {
                valEnd++;
              }
              appType = vdfBuffer.toString('utf8', valStart, valEnd).toLowerCase();
            }
          }

          // Search name
          if (namePattern) {
            const idx = vdfBuffer.indexOf(namePattern);
            if (idx !== -1) {
              const valStart = idx + 5;
              let valEnd = valStart;
              while (valEnd < vdfBuffer.length && vdfBuffer[valEnd] !== 0) {
                valEnd++;
              }
              appName = vdfBuffer.toString('utf8', valStart, valEnd);
            }
          }

          // Search controller_support
          if (controllerPattern) {
            const idx = vdfBuffer.indexOf(controllerPattern);
            if (idx !== -1) {
              const valStart = idx + 5;
              let valEnd = valStart;
              while (valEnd < vdfBuffer.length && vdfBuffer[valEnd] !== 0) {
                valEnd++;
              }
              controllerSupport = vdfBuffer.toString('utf8', valStart, valEnd);
            }
          }

          // Search metacritic_score
          if (metacriticPattern) {
            const idx = vdfBuffer.indexOf(metacriticPattern);
            if (idx !== -1 && idx + 9 <= vdfBuffer.length) {
              metacriticScore = vdfBuffer.readUInt32LE(idx + 5);
            }
          }

          // Search review_score
          if (reviewScorePattern) {
            const idx = vdfBuffer.indexOf(reviewScorePattern);
            if (idx !== -1 && idx + 9 <= vdfBuffer.length) {
              reviewScore = vdfBuffer.readUInt32LE(idx + 5);
            }
          }

          // Search review_percentage
          if (reviewPercentagePattern) {
            const idx = vdfBuffer.indexOf(reviewPercentagePattern);
            if (idx !== -1 && idx + 9 <= vdfBuffer.length) {
              reviewPercentage = vdfBuffer.readUInt32LE(idx + 5);
            }
          }

          // Search steam_release_date
          if (steamReleaseDatePattern) {
            const idx = vdfBuffer.indexOf(steamReleaseDatePattern);
            if (idx !== -1 && idx + 9 <= vdfBuffer.length) {
              steamReleaseDate = vdfBuffer.readUInt32LE(idx + 5);
            }
          }

          // Search original_release_date
          if (originalReleaseDatePattern) {
            const idx = vdfBuffer.indexOf(originalReleaseDatePattern);
            if (idx !== -1 && idx + 9 <= vdfBuffer.length) {
              originalReleaseDate = vdfBuffer.readUInt32LE(idx + 5);
            }
          }

          // Search genres
          if (genresPattern) {
            const idx = vdfBuffer.indexOf(genresPattern);
            if (idx !== -1) {
              const genreIds = parseVdfIntChildren(vdfBuffer, idx + 5);
              genreIds.forEach(id => {
                const name = STEAM_GENRES[id];
                if (name) genres.push(name);
              });
            }
          }

          // Search tags
          if (storeTagsPattern) {
            const idx = vdfBuffer.indexOf(storeTagsPattern);
            if (idx !== -1) {
              const tagIds = parseVdfIntChildren(vdfBuffer, idx + 5);
              tagIds.forEach(id => {
                const name = steamTagsMap.get(id);
                if (name) tags.push(name);
              });
            }
          }

          // Search category
          if (categoryPattern) {
            const idx = vdfBuffer.indexOf(categoryPattern);
            if (idx !== -1) {
              let pos = idx + 5;
              while (pos < vdfBuffer.length) {
                const type = vdfBuffer[pos++];
                if (type === 0x08 || type === undefined) {
                  break;
                }
                const keyIdx = vdfBuffer.readUInt32LE(pos);
                pos += 4;
                const keyStr = stringTable[keyIdx];
                if (type === 0x02 || type === 0x03) {
                  pos += 4;
                } else if (type === 0x01) {
                  while (pos < vdfBuffer.length && vdfBuffer[pos] !== 0) pos++;
                  pos++;
                } else if (type === 0x00) {
                  let depth = 1;
                  while (pos < vdfBuffer.length && depth > 0) {
                    const t = vdfBuffer[pos++];
                    if (t === 0x00) {
                      pos += 4;
                      depth++;
                    } else if (t === 0x08) {
                      depth--;
                    } else if (t === 0x01) {
                      pos += 4;
                      while (pos < vdfBuffer.length && vdfBuffer[pos] !== 0) pos++;
                      pos++;
                    } else if (t === 0x02 || t === 0x03) {
                      pos += 8;
                    } else if (t === 0x04) {
                      pos += 12;
                    }
                  }
                }
                if (keyStr && keyStr.startsWith('category_')) {
                  const catId = parseInt(keyStr.split('_')[1], 10);
                  if (!isNaN(catId)) {
                    categories.push(catId);
                  }
                }
              }
            }
          }

           // Search openvrsupport
          if (openvrsupportPattern) {
            const idx = vdfBuffer.indexOf(openvrsupportPattern);
            if (idx !== -1 && idx + 9 <= vdfBuffer.length) {
              openvrsupport = vdfBuffer.readUInt32LE(idx + 5);
            }
          }

          // Search onlyvrsupport
          if (onlyvrsupportPattern) {
            const idx = vdfBuffer.indexOf(onlyvrsupportPattern);
            if (idx !== -1 && idx + 9 <= vdfBuffer.length) {
              onlyvrsupport = vdfBuffer.readUInt32LE(idx + 5);
            }
          }

          // Search isfreeapp
          if (isfreeappPattern) {
            const idx = vdfBuffer.indexOf(isfreeappPattern);
            if (idx !== -1 && idx + 9 <= vdfBuffer.length) {
              const val = vdfBuffer.readUInt32LE(idx + 5);
              if (val === 1) isFree = true;
            }
          }

          if (controllerSupport !== 'none' || metacriticScore !== null || reviewScore !== null || reviewPercentage !== null || genres.length > 0 || tags.length > 0 || categories.length > 0 || openvrsupport !== null || onlyvrsupport !== null || isFree || steamReleaseDate !== null || originalReleaseDate !== null || appType !== 'unknown' || appName) {
            metadataMap.set(appid, {
              name: appName,
              type: appType,
              controllerSupport,
              metacriticScore,
              reviewScore,
              reviewPercentage,
              genres,
              tags,
              categories,
              openvrsupport,
              onlyvrsupport,
              isFree,
              releaseDate: steamReleaseDate || originalReleaseDate
            });
          }
        }
        appOffset = entryEnd;
      }
    }
    cachedAppMetadata = metadataMap;
    cachedAppMetadataMtime = mtime;
  } catch (err) {
    console.warn("Failed to parse appinfo.vdf metadata:", err);
    if (!cachedAppMetadata) cachedAppMetadata = metadataMap;
  }

  // packageinfo.vdf can also contain per-app metadata in some cases (e.g. for packages)
  // appinfo.vdf is the primary/reliable source for 'metacritic_score' keys.
  // If needed, a full parser for packageinfo can be added to seed additional scores here.

  return cachedAppMetadata || metadataMap;
}

// Helper: Check if steam.exe is currently running on Windows
async function isSteamRunning() {
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq steam.exe" /NH');
    return stdout.toLowerCase().includes('steam.exe');
  } catch (err) {
    return false;
  }
}

// Helper: Close Steam client cleanly first (to flush configurations to disk), fallback to taskkill if it hangs
async function closeSteam() {
  try {
    const running = await isSteamRunning();
    if (!running) return;

    console.log("Requesting clean Steam shutdown...");
    const steamPath = locateSteamPath();
    if (steamPath) {
      const steamExePath = path.join(steamPath, 'steam.exe');
      if (existsSync(steamExePath)) {
        const { exec } = await import('child_process');
        exec(`"${steamExePath}" -shutdown`);
      }
    }

    // Poll until steam.exe is no longer running (up to 16 attempts, i.e., 8 seconds)
    for (let i = 0; i < 16; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const stillRunning = await isSteamRunning();
      if (!stillRunning) {
        console.log("Steam process exited cleanly.");
        // Give 1 second for OS file lock release
        await new Promise(resolve => setTimeout(resolve, 1000));
        return;
      }
    }

    // Fallback to forceful termination if still running
    console.log("Steam did not exit cleanly. Forcefully terminating...");
    await execAsync('taskkill /F /IM steam.exe');
    await new Promise(resolve => setTimeout(resolve, 1500));
  } catch (err) {
    console.warn("Failed to close Steam:", err);
  }
}

// Helper: Relaunch Steam client in background with reset collections command
async function launchSteam() {
  const steamPath = locateSteamPath();
  if (!steamPath) return;
  const steamExePath = path.join(steamPath, 'steam.exe');
  if (existsSync(steamExePath)) {
    const { spawn } = await import('child_process');
    const child = spawn(steamExePath, ['steam://resetcollections'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  }
}

// Helper: Custom VDF parser into nested JS Object
function parseVDF(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [root];
  
  const regex = /^\s*"(.*?)"\s*"(.*?)"/;
  const blockRegex = /^\s*"(.*?)"/;
  
  let lastKey = null;

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('//')) continue;
    
    if (line === '{') {
      if (lastKey !== null) {
        const current = stack[stack.length - 1];
        current[lastKey] = {};
        stack.push(current[lastKey]);
        lastKey = null;
      }
      continue;
    }
    
    if (line === '}') {
      stack.pop();
      lastKey = null;
      continue;
    }
    
    const kvMatch = line.match(regex);
    if (kvMatch) {
      const [, key, val] = kvMatch;
      const current = stack[stack.length - 1];
      current[key] = val;
      lastKey = null;
      continue;
    }
    
    const blockMatch = line.match(blockRegex);
    if (blockMatch) {
      lastKey = blockMatch[1];
      continue;
    }
  }
  
  return root;
}

// Helper: Custom VDF stringifier
function stringifyVDF(obj, indentCount = 0) {
  let result = '';
  const indent = '\t'.repeat(indentCount);
  
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'object' && val !== null) {
      result += `${indent}"${key}"\r\n${indent}{\r\n${stringifyVDF(val, indentCount + 1)}${indent}}\r\n`;
    } else {
      result += `${indent}"${key}"\t\t"${val}"\r\n`;
    }
  }
  return result;
}

// POST /api/config/export-collections
app.post('/api/config/export-collections', async (req, res) => {
  try {
    // 1. Forcefully close Steam (to ensure we can write and it doesn't overwrite)
    await closeSteam();

    // 2. Load configured SteamID
    const config = await readJsonFile(CONFIG_PATH, { 
      metacriticScanCompleted: false,
      hltbScanCompleted: false,
      reviewsScanCompleted: false,
      steamRatingsScanCompleted: false
    });
    if (!config || !config.steamId) {
      return res.status(400).json({ error: 'Steam ID is not configured.' });
    }

    const steamPath = locateSteamPath();
    if (!steamPath) {
      return res.status(500).json({ error: 'Steam installation path could not be located.' });
    }

    const accountId = (BigInt(config.steamId) - 76561197960265728n).toString();
    
    // File paths
    const localConfigPath = path.join(steamPath, 'userdata', accountId, 'config', 'localconfig.vdf');
    const sharedConfigPath = path.join(steamPath, 'userdata', accountId, '7', 'remote', 'sharedconfig.vdf');
    const remoteCachePath = path.join(steamPath, 'userdata', accountId, '7', 'remotecache.vdf');

    if (!existsSync(localConfigPath)) {
      return res.status(500).json({ error: `localconfig.vdf not found for AccountID ${accountId}.` });
    }

    // 3. Load categories (folders)
    const categories = await readJsonFile(CATEGORIES_PATH, { folders: [] });
    const folders = categories.folders || [];

    // --- WRITE METHOD 1: localconfig.vdf user-collections (V2) ---
    // Backup localconfig
    await fs.copyFile(localConfigPath, localConfigPath + '.backup');

    const localContent = await fs.readFile(localConfigPath, 'utf-8');
    const lineRegex = /^[^\r\n]*"user-collections"[^\r\n]*/m;
    const match = localContent.match(lineRegex);
    
    let collections = {};
    let indent = '\t\t';

    if (match) {
      const valMatch = match[0].match(/"user-collections"\s+"(.*)"/);
      if (valMatch) {
        const escapedJson = valMatch[1];
        const jsonStr = escapedJson.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        try {
          collections = JSON.parse(jsonStr);
        } catch (e) {
          console.warn("Failed to parse existing user-collections JSON, starting fresh:", e);
        }
      }
      const lineIndentMatch = match[0].match(/^(\s*)/);
      if (lineIndentMatch) indent = lineIndentMatch[1];
    }

    const generateId = () => {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let result = 'uc-';
      for (let i = 0; i < 12; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };

    folders.forEach(folder => {
      let existingCol = Object.values(collections).find(
        c => c.name && c.name.toLowerCase() === folder.name.toLowerCase()
      );
      if (existingCol) {
        existingCol.added = folder.appIds.map(id => parseInt(id, 10));
        if (folder.filterSpec) {
          existingCol.filterSpec = folder.filterSpec;
        }
      } else {
        const newId = generateId();
        const newCol = {
          id: newId,
          name: folder.name,
          added: folder.appIds.map(id => parseInt(id, 10)),
          removed: []
        };
        if (folder.filterSpec) {
          newCol.filterSpec = folder.filterSpec;
        }
        collections[newId] = newCol;
      }
    });

    const updatedJsonStr = JSON.stringify(collections);
    const updatedEscapedJson = updatedJsonStr.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const newLine = `${indent}"user-collections"\t\t"${updatedEscapedJson}"`;

    let updatedLocalContent = '';
    if (match) {
      updatedLocalContent = localContent.replace(lineRegex, newLine);
    } else {
      const steamIndex = localContent.indexOf('"Steam"');
      if (steamIndex !== -1) {
        const insertPos = localContent.indexOf('{', steamIndex);
        if (insertPos !== -1) {
          updatedLocalContent = localContent.substring(0, insertPos + 1) + 
                               `\r\n${indent}"user-collections"\t\t"${updatedEscapedJson}"` + 
                               localContent.substring(insertPos + 1);
        } else {
          updatedLocalContent = localContent + `\r\n"user-collections"\t\t"${updatedEscapedJson}"`;
        }
      } else {
        updatedLocalContent = localContent + `\r\n"user-collections"\t\t"${updatedEscapedJson}"`;
      }
    }
    await fs.writeFile(localConfigPath, updatedLocalContent, 'utf-8');

    // --- WRITE METHOD 2: sharedconfig.vdf legacy category tags (V1) ---
    if (existsSync(sharedConfigPath) && existsSync(remoteCachePath)) {
      // Backup sharedconfig and remotecache
      await fs.copyFile(sharedConfigPath, sharedConfigPath + '.backup');
      await fs.copyFile(remoteCachePath, remoteCachePath + '.backup');

      // Parse sharedconfig.vdf
      const sharedContent = await fs.readFile(sharedConfigPath, 'utf8');
      const parsedShared = parseVDF(sharedContent);
      const rootKey = Object.keys(parsedShared)[0];
      
      if (parsedShared[rootKey]?.Software?.Valve?.Steam) {
        const steamBlock = parsedShared[rootKey].Software.Valve.Steam;
        if (!steamBlock.apps) {
          steamBlock.apps = {};
        }
        const apps = steamBlock.apps;

        // Clear old custom folder tags
        const folderNames = folders.map(f => f.name.toLowerCase());
        for (const [appid, app] of Object.entries(apps)) {
          if (app.tags) {
            const keptTags = Object.values(app.tags).filter(t => !folderNames.includes(t.toLowerCase()));
            if (keptTags.length > 0) {
              app.tags = {};
              keptTags.forEach((t, i) => {
                app.tags[i.toString()] = t;
              });
            } else {
              delete app.tags;
            }
          }
        }

        // Add new folder tags
        folders.forEach(folder => {
          folder.appIds.forEach(id => {
            const appidStr = id.toString();
            if (!apps[appidStr]) {
              apps[appidStr] = {};
            }
            if (!apps[appidStr].tags) {
              apps[appidStr].tags = {};
            }
            const currentTags = Object.values(apps[appidStr].tags);
            if (!currentTags.includes(folder.name)) {
              const nextIndex = currentTags.length.toString();
              apps[appidStr].tags[nextIndex] = folder.name;
            }
          });
        });

        // Stringify updated sharedconfig.vdf
        const updatedSharedContent = stringifyVDF(parsedShared);
        await fs.writeFile(sharedConfigPath, updatedSharedContent, 'utf8');

        // Parse and update remotecache.vdf so Steam Cloud doesn't overwrite sharedconfig.vdf
        const remoteContent = await fs.readFile(remoteCachePath, 'utf8');
        const parsedRemote = parseVDF(remoteContent);
        const remoteRootKey = Object.keys(parsedRemote)[0];
        const remoteSharedBlock = parsedRemote[remoteRootKey]['sharedconfig.vdf'];

        if (remoteSharedBlock) {
          const stats = await fs.stat(sharedConfigPath);
          const newSize = stats.size.toString();
          
          // Import crypto dynamically for SHA-1 calculation
          const crypto = await import('crypto');
          const calculateSHA1 = (c) => crypto.createHash('sha1').update(c, 'utf8').digest('hex');
          const newSha = calculateSHA1(updatedSharedContent);
          const newTime = Math.floor(Date.now() / 1000).toString();

          remoteSharedBlock.size = newSize;
          remoteSharedBlock.sha = newSha;
          remoteSharedBlock.localtime = newTime;
          remoteSharedBlock.time = newTime;

          const updatedRemoteContent = stringifyVDF(parsedRemote);
          await fs.writeFile(remoteCachePath, updatedRemoteContent, 'utf8');
        }
      }
    }

    // --- WRITE METHOD 3: cloud-storage-namespace-1.json and modified.json (Modern Steam) ---
    const cloudJsonPath = path.join(steamPath, 'userdata', accountId, 'config', 'cloudstorage', 'cloud-storage-namespace-1.json');
    const modifiedJsonPath = path.join(steamPath, 'userdata', accountId, 'config', 'cloudstorage', 'cloud-storage-namespace-1.modified.json');

    if (existsSync(cloudJsonPath) && existsSync(modifiedJsonPath)) {
      try {
        // Backups
        await fs.copyFile(cloudJsonPath, cloudJsonPath + '.backup');
        await fs.copyFile(modifiedJsonPath, modifiedJsonPath + '.backup');

        const cloudContent = await fs.readFile(cloudJsonPath, 'utf8');
        const parsedNamespace = JSON.parse(cloudContent);

        const modifiedContent = await fs.readFile(modifiedJsonPath, 'utf8');
        const parsedModified = JSON.parse(modifiedContent);

        const modifiedKeys = [];

        // 1. Mark old folders no longer in active list as is_deleted
        const activeFolderNames = folders.map(f => f.name.toLowerCase());
        parsedNamespace.forEach(([key, item]) => {
          if (key.startsWith('user-collections.') && !item.is_deleted) {
            try {
              const val = JSON.parse(item.value);
              if (val.id !== 'favorite' && val.id !== 'hidden') {
                if (!activeFolderNames.includes(val.name.toLowerCase())) {
                  item.is_deleted = true;
                  delete item.value;
                  item.timestamp = Math.floor(Date.now() / 1000);
                  item.version = Date.now().toString();
                  modifiedKeys.push(key);
                }
              }
            } catch (e) {
              console.warn("Error parsing namespace collection during cleanup:", e);
            }
          }
        });

        // 2. Add or update active folders
        const generateCloudId = () => {
          const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
          let result = 'uc-';
          for (let i = 0; i < 12; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          return result;
        };

        folders.forEach(folder => {
          let foundPair = parsedNamespace.find(([key, item]) => {
            if (key.startsWith('user-collections.') && !item.is_deleted) {
              try {
                const val = JSON.parse(item.value);
                return val.name.toLowerCase() === folder.name.toLowerCase();
              } catch (e) {
                return false;
              }
            }
            return false;
          });

          if (foundPair) {
            const [key, item] = foundPair;
            try {
              const val = JSON.parse(item.value);
              val.added = folder.appIds.map(Number);
              val.removed = [];
              if (folder.filterSpec) {
                val.filterSpec = folder.filterSpec;
              } else {
                delete val.filterSpec;
              }
              item.value = JSON.stringify(val);
              item.timestamp = Math.floor(Date.now() / 1000);
              item.version = Date.now().toString();
              modifiedKeys.push(key);
            } catch (e) {
              console.warn("Error parsing existing collection for update:", e);
            }
          } else {
            const newId = generateCloudId();
            const key = `user-collections.${newId}`;
            const val = {
              id: newId,
              name: folder.name,
              added: folder.appIds.map(Number),
              removed: []
            };
            if (folder.filterSpec) {
              val.filterSpec = folder.filterSpec;
            }
            const item = {
              key: key,
              timestamp: Math.floor(Date.now() / 1000),
              value: JSON.stringify(val),
              version: Date.now().toString(),
              conflictResolutionMethod: "custom",
              strMethodId: "union-collections"
            };
            parsedNamespace.push([key, item]);
            modifiedKeys.push(key);
          }
        });

        // Merge modified keys list
        const modifiedSet = new Set(parsedModified);
        modifiedKeys.forEach(k => modifiedSet.add(k));
        const newModified = Array.from(modifiedSet);

        // Write both files
        await fs.writeFile(cloudJsonPath, JSON.stringify(parsedNamespace), 'utf8');
        await fs.writeFile(modifiedJsonPath, JSON.stringify(newModified), 'utf8');
        console.log("Modern Steam cloud collections updated successfully.");
      } catch (err) {
        console.warn("Failed to write to modern Steam cloud collections:", err);
      }
    }

    // 8. Relaunch Steam
    await launchSteam();

    res.json({ success: true, count: folders.length });

  } catch (error) {
    console.error('Export collections failed:', error);
    res.status(500).json({ error: 'Failed to export collections: ' + error.message });
  }
});

// Cache status and refresh APIs
app.get('/api/cache/status', async (req, res) => {
  try {
    const totalGames = await getGamesCount();
    const getLast = async (p) => {
      const s = await getFileStat(p);
      return s ? s.mtime.toISOString() : null;
    };
    const status = {
      hltb: {
        // Count only games where we actually found HLTB data (not the nulls for "scanned but no match")
        processed: Object.keys(hltbCache || {}).filter(k => {
          if (isNaN(parseInt(k, 10))) return false;
          const v = hltbCache[k];
          return v != null && typeof v === 'object';
        }).length,
        total: totalGames,
        lastUpdated: await getLast(HLTB_CACHE_PATH),
        running: !!isCrawlingHLTB
      },
      license: {
        processed: (Object.keys(licenseCache || {}).length > 0)
          ? Math.max(0, totalGames - Object.values(licenseCache || {}).filter(v => v === false).length)
          : 0,
        total: totalGames,
        lastUpdated: await getLast(LICENSE_CACHE_PATH),
        running: !!isCrawlingLicense
      },
      media: {
        processed: mediaCache ? mediaCache.size : 0,
        total: totalGames,
        lastUpdated: await getLast(MEDIA_CACHE_PATH),
        running: !!isCrawlingMedia
      },
      metacritic: {
        // Count only games with an actual metacritic score found (exclude nulls for "scanned but none")
        processed: metacriticScoreMap ? Array.from(metacriticScoreMap.values()).filter(v => v != null).length : 0,
        total: totalGames,
        lastUpdated: await getLast(METACRITIC_CACHE_PATH),
        running: !!isCrawlingMetacritic || !!isCrawlingMetacriticHLTB,
        runningViaHLTB: !!isCrawlingMetacriticHLTB
      },
      reviews: {
        processed: reviewsCountMap ? reviewsCountMap.size : 0,
        total: totalGames,
        lastUpdated: await getLast(REVIEWS_CACHE_PATH),
        running: !!isCrawlingReviews
      },
      steamratings: {
        // Count only entries with actual rating data (exclude pure null placeholders)
        processed: steamRatingsMap ? Array.from(steamRatingsMap.values()).filter(r => r && (r.reviewScore != null || (r.reviewPercentage != null && r.reviewPercentage > 0))).length : 0,
        total: totalGames,
        lastUpdated: await getLast(STEAM_RATINGS_CACHE_PATH),
        running: !!isCrawlingReviews
      },
      tags: {
        processed: steamTagsMap ? steamTagsMap.size : 0,
        total: steamTagsMap ? steamTagsMap.size : 0,
        lastUpdated: await getLast(STEAM_TAGS_CACHE),
        running: false
      }
    };
    res.json(status);
  } catch (e) {
    console.error('Cache status error:', e);
    res.status(500).json({ error: 'Failed to get cache status' });
  }
});

app.post('/api/cache/refresh/:type', async (req, res) => {
  const type = req.params.type;
  try {
    let games = [];
    try {
      if (existsSync(CACHE_PATH)) {
        const d = await fs.readFile(CACHE_PATH, 'utf8');
        games = JSON.parse(d) || [];
      }
    } catch (e) {}

    // Determine active (interface-visible) ids for correct prune + toProcess lists.
    // This ensures total in status + scanned counts match UI loaded games, and we don't scan filtered-out items.
    let activeIds = new Set();
    try {
      if (existsSync(ACTIVE_APPIDS_PATH)) {
        const ids = JSON.parse(await fs.readFile(ACTIVE_APPIDS_PATH, 'utf8'));
        if (Array.isArray(ids)) activeIds = new Set(ids.map(Number));
      }
    } catch (e) {}
    if (activeIds.size === 0) {
      activeIds = new Set(games.map(g => Number(g.appid)));
    }

    // Build minimal game list for crawlers using only active ids (preserve names from raw when available for HLTB)
    const rawMap = new Map(games.map(g => [Number(g.appid), g]));
    const activeGames = Array.from(activeIds).map(id => {
      const g = rawMap.get(id) || {};
      return { appid: id, name: g.name || undefined };
    });

    // When manual refresh is requested, ensure everything is marked as scanned in scanned_games.json
    const scannedSet = await loadScannedGames();
    let changed = false;
    activeGames.forEach(g => {
      if (!scannedSet.has(Number(g.appid))) {
        scannedSet.add(Number(g.appid));
        changed = true;
      }
    });
    if (changed) await saveScannedGames(scannedSet);

    if (type === 'reviews') {
      // First add/populate any missing, then refresh existing (in that order).
      // Do not delete/prune old cache entries here (stale removal happens on game list loads).
      const missing = activeGames.filter(g => !reviewsCountMap.has(g.appid));
      const existing = activeGames.filter(g => reviewsCountMap.has(g.appid));
      const ordered = [...missing, ...existing];
      crawlMissingReviewCounts(ordered, { forceUpdate: true });
      await markScanCompleted('reviews');
      await markScanCompleted('steamRatings');
      return res.json({ success: true, message: 'Reviews refresh started' });
    }
    if (type === 'steamratings') {
      // Force refresh underlying review data via API (updates both counts and steam ratings)
      crawlMissingReviewCounts(activeGames, { forceUpdate: true });
      await markScanCompleted('reviews');
      await markScanCompleted('steamRatings');
      return res.json({ success: true, message: 'Steam Ratings refresh started' });
    }
    if (type === 'metacritic') {
      // On refresh: skip games that already have a real score; retry only those with null (or never fetched)
      crawlMissingMetacriticScores(activeGames, { retryNulls: true });
      await markScanCompleted('metacritic');
      return res.json({ success: true, message: 'Metacritic refresh started' });
    }
    if (type === 'metacritic-hltb') {
      // Use HLTB review scores to populate metacritic cache (for games missing scores)
      // Leverages metacritic cache for toProcess list and read/write; HLTB only as source for reviewScore
      crawlMissingMetacriticScoresViaHLTB(activeGames, { retryNulls: true });
      await markScanCompleted('metacritic');
      return res.json({ success: true, message: 'Metacritic via HLTB (review scores) refresh started' });
    }
    if (type === 'hltb') {
      // On HLTB refresh: rescan ALL missing games (no cache entry) + any games that exist in cache
      // but have incomplete details (any of main/mainExtra/completionist null). Skip only complete ones.
      console.log(`[HLTB] Refresh requested for ${activeGames.length} games (will scan ALL missing + retry incomplete entries)...`);
      crawlMissingHLTB(activeGames, { retryNulls: true });
      await markScanCompleted('hltb');
      return res.json({ success: true, message: 'HLTB refresh started' });
    }
    if (type === 'media') {
      // Full clear for media (special "Clear" action, like license).
      // Media is populated on-demand when viewing games (Items cached when viewed).
      // Only clear the cache file if having issues.
      mediaCache.clear();
      try {
        await fs.unlink(MEDIA_CACHE_PATH);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn('Failed to delete media cache file on clear:', err.message);
        }
      }
      return res.json({ success: true, message: 'Media cache cleared' });
    }
    if (type === 'license') {
      // Full clear for license (special "Clear" action, not a refresh/force).
      // Wipe in-memory and delete the file so next /api/games load will re-run
      // license checks for current supplemental games (instead of hitting cache).
      licenseCache = {};
      try {
        await fs.unlink(LICENSE_CACHE_PATH);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.warn('Failed to delete license cache file on clear:', err.message);
        }
      }
      licenseCache = {};
      return res.json({ success: true, message: 'License cache cleared' });
    }
    if (type === 'tags') {
      try {
        const r = await fetch('https://store.steampowered.com/tagdata/populartags/english');
        if (r.ok) {
          const data = await r.json();
          steamTagsMap.clear();
          data.forEach(it => steamTagsMap.set(Number(it.tagid), it.name));
          await fs.writeFile(STEAM_TAGS_CACHE, JSON.stringify(data), 'utf8');
        }
      } catch (e) { console.warn('tags refresh:', e); }
      return res.json({ success: true, message: 'Tags refreshed' });
    }
    res.json({ success: false, error: 'Unknown cache type' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Stop crawlers for HLTB, Metacritic, Reviews/SteamRatings (REVIEW COUNTS)
app.post('/api/cache/stop/:type', (req, res) => {
  const type = (req.params.type || '').toLowerCase();
  let message = '';
  if (type === 'hltb') {
    stopHLTB = true;
    isCrawlingHLTB = false;
    message = 'HLTB crawler stop requested';
  } else if (type === 'metacritic') {
    stopMetacritic = true;
    isCrawlingMetacritic = false;
    message = 'Metacritic crawler stop requested';
  } else if (type === 'metacritic-hltb') {
    stopMetacriticHLTB = true;
    isCrawlingMetacriticHLTB = false;
    message = 'Metacritic via HLTB crawler stop requested';
  } else if (type === 'reviews' || type === 'reviewcounts' || type === 'steamreviews') {
    stopReviews = true;
    isCrawlingReviews = false;
    message = 'Reviews / Review Counts crawler stop requested';
  } else if (type === 'steamratings') {
    stopReviews = true;
    isCrawlingReviews = false;
    message = 'Steam Ratings crawler stop requested';
  } else {
    return res.json({ success: false, error: 'Unknown or non-stoppable crawler type' });
  }
  console.log(`[Stop] ${message}`);
  res.json({ success: true, message });
});

// Helper: evaluate dynamic collection filter rules against a game object
function evaluateFilterSpec(game, filterSpec) {
  if (!filterSpec || !Array.isArray(filterSpec.filterGroups)) return false;
  
  for (let i = 0; i < filterSpec.filterGroups.length; i++) {
    const group = filterSpec.filterGroups[i];
    if (!group || !Array.isArray(group.rgOptions) || group.rgOptions.length === 0) {
      continue;
    }
    
    const options = group.rgOptions;
    const bAcceptUnion = group.bAcceptUnion;
    
    let matchCount = 0;
    
    for (const opt of options) {
      let matches = false;
      if (i === 0) {
        // Play State: 1 = Played, 2 = Unplayed
        if (opt === 1 && game.playtime_forever > 0) matches = true;
        if (opt === 2 && (!game.playtime_forever || game.playtime_forever === 0)) matches = true;
      } else if (i === 1) {
        // App Type: 1 = Games
        if (opt === 1) matches = true;
      } else if (i === 2) {
        // Players / Play Mode / Features
        // Steam dynamic collection feature options in this group:
        // 1=Singleplayer, 2=Multiplayer, 3=VR, 4=Shared/Split Screen, 9=Co-op,
        // 27=Local Multiplayer (the option used by "Local Multiplayer" collections)
        const tags = (game.tags || []).map(t => (t || '').toLowerCase());
        const categories = game.categories || [];
        const hasTag = (needle) => tags.some(t => t.includes(needle));
        
        if (opt === 1 && (categories.includes(2) || hasTag('singleplayer') || hasTag('single-player'))) matches = true;
        if (opt === 2 && (categories.includes(1) || hasTag('multiplayer') || hasTag('multi-player'))) matches = true;
        if (opt === 3 && (game.isVRSupported || categories.includes(52) || categories.includes(54) || categories.includes(53) || hasTag('vr') || hasTag('virtual reality'))) matches = true;
        if (opt === 4 && (categories.includes(24) || hasTag('shared/split screen') || hasTag('split screen'))) matches = true;
        if (opt === 9 && (categories.includes(9) || hasTag('co-op') || hasTag('cooperative') || hasTag('co-op campaign') || hasTag('online co-op'))) matches = true;
        // Local Multiplayer (opt 27): many games signal this via Shared/Split Screen (cat 24) + multiplayer features,
        // or explicit local co-op / local multiplayer tags. Steam collections using "Local Multiplayer" filter use opt 27.
        if (opt === 27 && (
          categories.includes(27) ||
          categories.includes(24) || // Shared/Split Screen is the primary category signal for local play
          hasTag('local multiplayer') || hasTag('local multi-player') || hasTag('local multi') ||
          hasTag('local co-op') || hasTag('local coop') ||
          hasTag('shared/split screen') || hasTag('split screen')
        )) matches = true;
        if (!matches && categories.includes(opt)) matches = true;
      } else if (i === 3) {
        // Controller Support
        // opt 1 = Controller (full), 2 = Controller (partial), 3 = VR
        const categories = game.categories || [];
        if (opt === 1 && (game.controllerSupport === 'full' || categories.includes(28))) matches = true;
        if (opt === 2 && (game.controllerSupport === 'partial' || game.controllerSupport === 'full' || categories.includes(18) || categories.includes(28))) matches = true;
        if (opt === 3 && (game.isVRSupported || categories.includes(47) || categories.includes(48))) matches = true;
      } else if (i === 4) {
        // Genres (from STEAM_GENRES)
        const genres = (game.genres || []).map(g => g.toLowerCase());
        const genreName = STEAM_GENRES[opt];
        if (genreName && genres.includes(genreName.toLowerCase())) matches = true;
      } else if (i === 5) {
        // Hardware Support
        // opt 1 = VR Required, 2 = VR Supported
        const categories = game.categories || [];
        if (opt === 1 && (game.isVROnly || categories.includes(48))) matches = true;
        if (opt === 2 && (game.isVRSupported || categories.includes(47) || categories.includes(48))) matches = true;
      } else if (i === 6) {
        // Store Tags
        const tags = (game.tags || []).map(t => (t || '').toLowerCase());
        const tagName = steamTagsMap.get(opt);
        if (tagName && tags.some(t => t.includes(tagName.toLowerCase()))) matches = true;
      }
      
      if (matches) {
        matchCount++;
      }
    }
    
    if (bAcceptUnion) {
      if (matchCount === 0) return false;
    } else {
      if (matchCount < options.length) return false;
    }
  }
  
  return true;
}

// POST /api/config/import-collections
app.post('/api/config/import-collections', async (req, res) => {
  try {
    const skipClose = req.query.skipClose === 'true';

    // 1. Request a clean Steam exit first so it flushes memory states to VDF files (unless skipped)
    if (!skipClose) {
      await closeSteam();
    }

    // 2. Load configured SteamID
    const config = await readJsonFile(CONFIG_PATH, { 
      metacriticScanCompleted: false,
      hltbScanCompleted: false,
      reviewsScanCompleted: false,
      steamRatingsScanCompleted: false
    });
    if (!config || !config.steamId) {
      return res.status(400).json({ error: 'Steam ID is not configured.' });
    }

    const steamPath = locateSteamPath();
    if (!steamPath) {
      return res.status(500).json({ error: 'Steam installation path could not be located.' });
    }

    const accountId = (BigInt(config.steamId) - 76561197960265728n).toString();
    
    // File paths
    const cloudJsonPath = path.join(steamPath, 'userdata', accountId, 'config', 'cloudstorage', 'cloud-storage-namespace-1.json');
    const localConfigPath = path.join(steamPath, 'userdata', accountId, 'config', 'localconfig.vdf');
    const sharedConfigPath = path.join(steamPath, 'userdata', accountId, '7', 'remote', 'sharedconfig.vdf');

    // Load full games list with mapped metadata for dynamic collection evaluation
    let gamesList = [];
    try {
      let cache = await readJsonFile(CACHE_PATH, null) || [];
      const localGames = await getInstalledGamesFromManifests();
      const localAppIds = new Set(localGames.map(g => g.appid));

      const vdfAppIds = await getAppIdsFromLocalConfigs();
      const vdfSet = new Set(vdfAppIds);

      const mergedGamesMap = new Map();
      cache.forEach(game => {
        mergedGamesMap.set(game.appid, {
          ...game,
          isInstalled: localAppIds.has(game.appid),
          isVRSupported: false,
          isVROnly: false
        });
      });

      localGames.forEach(localGame => {
        if (!mergedGamesMap.has(localGame.appid) && vdfSet.has(localGame.appid)) {
          // Only introduce "extra" installed games if we have VDF evidence of current license/account tracking.
          // This prevents refunded/removed games with leftover install manifests from being included.
          mergedGamesMap.set(localGame.appid, {
            ...localGame,
            isInstalled: true,
            isVRSupported: false,
            isVROnly: false
          });
        }
      });

      const appMetadataMap = await seedMetacriticFromVDF();

      const libraryCacheAppIds = await getLibraryCacheAppIds();
      const playtimeMap = await getPlaytimeMapFromLocalConfig();
      const categories = await readJsonFile(CATEGORIES_PATH, { folders: [] });
      const categorizedAppIds = new Set();
      if (categories && categories.folders) {
        categories.folders.forEach(folder => {
          if (folder.name !== 'trash' && folder.appIds) {
            folder.appIds.forEach(id => categorizedAppIds.add(Number(id)));
          }
        });
      }

      // Only resolve and add missing AppIDs from local VDF configs if they are installed, manually categorized, or has playtime.
      // Avoid librarycache to prevent non-owned items like trailers.
      const missingAppIds = vdfAppIds.filter(appid => {
        if (mergedGamesMap.has(appid)) return false;
        const isInstalled = localAppIds.has(appid);
        const isCategorized = categorizedAppIds.has(appid);
        const hasPlaytime = (playtimeMap.get(appid) || 0) > 0;
        const meta = appMetadataMap.get(appid) || {};
        const t = (meta.type || '').toLowerCase();
        const isBadType = t === 'dlc' || t.includes('dlc') || t.includes('add-on') || t.includes('addon') || t === 'tool' || t.includes('tool') || t === 'movie' || t.includes('movie') || t.includes('trailer') || t === 'demo' || t.includes('demo');
        const isFree = !!meta.isFree;
        // Include VDF-based supplements for dynamic collection eval too.
        // Free games (isFree) allowed even at 0 playtime/not installed (common for F2P).
        // Free games bypass license check (fine to show); others checked for license.
        const keep = !isBadType && (isInstalled || isCategorized || hasPlaytime || isFree);
        return keep;
      });

      if (missingAppIds.length > 0) {
        let appList = await readJsonFile(APP_LIST_CACHE_PATH, null);
        if (!appList) {
          try {
            appList = await fetchCompleteSteamAppList(config.apiKey);
            await writeJsonFile(APP_LIST_CACHE_PATH, appList);
          } catch (e) {
            console.error('Failed to fetch app list during import:', e);
          }
        }

        if (appList) {
          const appMap = new Map(appList.map(app => [app.appid, app.name]));
          let newResolutions = false;
          for (const appid of missingAppIds) {
            let name = appMap.get(appid);
            if (!name) {
              name = appMetadataMap.get(appid)?.name;
            }
            if (!name) {
              name = await fetchAppName(appid);
              if (name) {
                console.log(`[name fallback] Resolved ${appid} -> "${name}"`);
                if (!appMap.has(appid)) {
                  appList.push({ appid, name });
                  appMap.set(appid, name);
                  newResolutions = true;
                }
              }
            }
            if (!name) {
              name = `Unknown App ${appid}`;
            }
            if (containsDemoWord(name)) {
              continue; // do not add games whose name contains the word "demo" (but not "demon", etc.)
            }
            const meta = appMetadataMap.get(appid) || {};
            let licensed = true;
            if (!meta.isFree) {
              licensed = await hasValidSteamLicense(appid, config.apiKey, config.steamId);
            }
            if (!licensed) {
              continue;
            }
            mergedGamesMap.set(appid, {
              appid: appid,
              name: name,
              playtime_forever: 0,
              img_icon_url: '',
              isInstalled: localAppIds.has(appid),
              isVRSupported: false,
              isVROnly: false
            });
          }
          if (newResolutions) {
            await writeJsonFile(APP_LIST_CACHE_PATH, appList);
          }
        }
      }
      gamesList = Array.from(mergedGamesMap.values()).map(game => {
        const appMeta = appMetadataMap.get(game.appid) || {
          type: 'unknown',
          controllerSupport: 'none',
          genres: [],
          tags: [],
          categories: [],
          openvrsupport: null,
          onlyvrsupport: null
        };
        const vrCaps = getGameVRCapabilities(game, appMeta);
        let controllerSupport = appMeta.controllerSupport;
        if (vrCaps.isVRSupported && controllerSupport !== 'full') {
          controllerSupport = 'full';
        }
        return {
          ...game,
          type: (appMeta.type || 'unknown').toLowerCase(),
          isVRSupported: vrCaps.isVRSupported,
          isVROnly: vrCaps.isVROnly,
          controllerSupport: controllerSupport,
          genres: appMeta.genres || [],
          tags: appMeta.tags || [],
          categories: appMeta.categories || [],
          hltb: hltbCache[String(game.appid)] || hltbCache[game.name?.toLowerCase()] || null
        };
      });

      // Filter out dlc/addons/tools/movies/trailers/demos (incl. name contains the whole word "demo") from gamesList used for dynamic eval, to match main library.
      gamesList = gamesList.filter(game => {
        const t = (appMetadataMap.get(game.appid)?.type || '').toLowerCase();
        const n = (game.name || '').toLowerCase();
        if (t === 'dlc' || t.includes('dlc') || t.includes('add-on') || t.includes('addon') || t === 'tool' || t.includes('tool') || t === 'movie' || t.includes('movie') || t.includes('trailer') || t === 'demo' || t.includes('demo') || containsDemoWord(n)) {
          return false;
        }
        return true;
      });
    } catch (e) {
      console.warn("Failed to load games list for dynamic folder evaluation:", e);
    }

    const collectionsMap = new Map(); // name -> { appIds: Set, filterSpec: object }
    let importedFromCloud = false;

    // --- READ METHOD 1: cloud-storage-namespace-1.json (Modern Steam) ---
    if (existsSync(cloudJsonPath)) {
      try {
        const cloudContent = await fs.readFile(cloudJsonPath, 'utf8');
        const parsedNamespace = JSON.parse(cloudContent);
        const collections = parsedNamespace.filter(([key, item]) => key.startsWith('user-collections.') && !item.is_deleted);
        
        if (collections.length > 0) {
          collections.forEach(([key, item]) => {
            try {
              const col = JSON.parse(item.value);
              if (col.id !== 'hidden' && col.name) {
                if (!collectionsMap.has(col.name)) {
                  collectionsMap.set(col.name, { appIds: new Set(), filterSpec: null });
                }
                const entry = collectionsMap.get(col.name);
                if (col.filterSpec) {
                  entry.filterSpec = col.filterSpec;
                  // Dynamic evaluation
                  gamesList.forEach(game => {
                    if (evaluateFilterSpec(game, col.filterSpec)) {
                      entry.appIds.add(game.appid);
                    }
                  });
                  if (col.removed && Array.isArray(col.removed)) {
                    col.removed.forEach(id => entry.appIds.delete(id));
                  }
                }
                if (col.added && Array.isArray(col.added)) {
                  col.added.forEach(id => entry.appIds.add(id));
                }
              }
            } catch (e) {
              console.warn("Failed to parse namespace collection item during import:", e);
            }
          });
          importedFromCloud = true;
          console.log(`Successfully imported ${collections.length} active collections from modern cloudstorage.`);
        }
      } catch (err) {
        console.warn("Failed to read from modern Steam cloud collections:", err);
      }
    }

    // --- READ METHOD 2: localconfig.vdf user-collections (V2) (FALLBACK) ---
    let importedFromLocal = false;
    if (!importedFromCloud && existsSync(localConfigPath)) {
      const localContent = await fs.readFile(localConfigPath, 'utf-8');
      const lineRegex = /^[^\r\n]*"user-collections"[^\r\n]*/m;
      const match = localContent.match(lineRegex);
      if (match) {
        const valMatch = match[0].match(/"user-collections"\s+"(.*)"/);
        if (valMatch) {
          const escapedJson = valMatch[1];
          const jsonStr = escapedJson.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          try {
            const collections = JSON.parse(jsonStr);
            const activeCollections = Object.values(collections);
            if (activeCollections.length > 0) {
              activeCollections.forEach(col => {
                if (col.name) {
                  if (!collectionsMap.has(col.name)) {
                    collectionsMap.set(col.name, { appIds: new Set(), filterSpec: null });
                  }
                  const entry = collectionsMap.get(col.name);
                  if (col.filterSpec) {
                    entry.filterSpec = col.filterSpec;
                    // Dynamic evaluation
                    gamesList.forEach(game => {
                      if (evaluateFilterSpec(game, col.filterSpec)) {
                        entry.appIds.add(game.appid);
                      }
                    });
                    if (col.removed && Array.isArray(col.removed)) {
                      col.removed.forEach(id => entry.appIds.delete(id));
                    }
                  }
                  if (col.added && Array.isArray(col.added)) {
                    col.added.forEach(id => entry.appIds.add(id));
                  }
                }
              });
              importedFromLocal = true;
            }
          } catch (e) {
            console.warn("Failed to parse existing user-collections JSON during import:", e);
          }
        }
      }
    }

    // --- READ METHOD 3: sharedconfig.vdf legacy category tags (V1) (FALLBACK ONLY) ---
    if (!importedFromCloud && !importedFromLocal && existsSync(sharedConfigPath)) {
      console.log("Local user-collections not found. Falling back to sharedconfig.vdf tags.");
      const sharedContent = await fs.readFile(sharedConfigPath, 'utf8');
      const parsedShared = parseVDF(sharedContent);
      const rootKey = Object.keys(parsedShared)[0];
      const apps = parsedShared[rootKey]?.Software?.Valve?.Steam?.apps;

      if (apps) {
        for (const [appid, app] of Object.entries(apps)) {
          if (app.tags) {
            const appidNum = parseInt(appid, 10);
            if (!isNaN(appidNum)) {
              Object.values(app.tags).forEach(tag => {
                if (tag && typeof tag === 'string') {
                  if (!collectionsMap.has(tag)) {
                    collectionsMap.set(tag, { appIds: new Set(), filterSpec: null });
                  }
                  collectionsMap.get(tag).appIds.add(appidNum);
                }
              });
            }
          }
        }
      }
    }

    // 4. Load categories
    const categories = await readJsonFile(CATEGORIES_PATH, { folders: [] });
    const folders = categories.folders || [];

    // Merge collectionsMap into folders list
    let mergeCount = 0;
    for (const [name, folderData] of collectionsMap.entries()) {
      let existingFolder = folders.find(f => f.name.toLowerCase() === name.toLowerCase());
      if (existingFolder) {
        const isDynamic = !!folderData.filterSpec;
        if (isDynamic && !skipClose) {
          // Full import (Steam was closed): replace dynamic folder membership with the
          // freshly evaluated filterSpec results (+ any added/removed from the collection data).
          // This ensures games that now match the improved rules (or were missed before) appear,
          // and stale/missing members are corrected to match current Steam collection.
          existingFolder.appIds = Array.from(folderData.appIds).map(Number);
          existingFolder.filterSpec = folderData.filterSpec;
        } else {
          // Partial data (skipClose) or legacy/non-dynamic: union to avoid losing members
          // when cloud/local files contain only deltas.
          const existingSet = new Set((existingFolder.appIds || []).map(Number));
          folderData.appIds.forEach(id => existingSet.add(Number(id)));
          existingFolder.appIds = Array.from(existingSet);

          if (isDynamic) {
            existingFolder.filterSpec = folderData.filterSpec;
          } else if (!skipClose) {
            // Only clear filterSpec on a full import (Steam closed) — not during live sync
            delete existingFolder.filterSpec;
          }
        }
      } else {
        const newId = 'folder-' + Math.random().toString(36).substring(2, 9);
        const newFolder = {
          id: newId,
          name: name,
          appIds: Array.from(folderData.appIds)
        };
        if (folderData.filterSpec) {
          newFolder.filterSpec = folderData.filterSpec;
        }
        folders.push(newFolder);
      }
      mergeCount++;
    }

    // Deduplicate game memberships across normal/static folders — only if the user
    // has NOT enabled "allow games in multiple folders". If allowMultiFolderMembership
    // is true we skip this so imported collections can overlap freely.
    if (config?.allowMultiFolderMembership !== true) {
      const seenNormalAppIds = new Set();
      folders.forEach(f => {
        if (!f.filterSpec && f.appIds) {
          const uniqueIds = [];
          f.appIds.forEach(id => {
            const numId = Number(id);
            if (!seenNormalAppIds.has(numId)) {
              seenNormalAppIds.add(numId);
              uniqueIds.push(numId);
            }
          });
          f.appIds = uniqueIds;
        }
      });
    }

    categories.folders = folders;
    await writeJsonFile(CATEGORIES_PATH, categories);

    // 5. Relaunch Steam (unless skipped)
    if (!skipClose) {
      await launchSteam();
    }

    res.json({ success: true, count: mergeCount });

  } catch (error) {
    console.error('Import collections failed:', error);
    res.status(500).json({ error: 'Failed to import collections: ' + error.message });
  }
});

app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` SteamCollectionManager Server is running on:`);
  console.log(` http://localhost:${PORT}`);
  console.log(`=========================================`);
});
