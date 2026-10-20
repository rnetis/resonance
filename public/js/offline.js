// Offline audio cache: full tracks kept in the Cache Storage API so the player
// keeps working with no network. The canonical /api/stream URL is the key.

const CACHE_NAME = "resonance-audio-v1";
const INDEX_KEY = "resonance.offline.v1";
const MAX_TRACK_BYTES = 150 * 1024 * 1024;

export function supported() {
  return typeof caches !== "undefined" && location.protocol !== "file:";
}

function readIndex() {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeIndex(index) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

export function list() {
  return Object.values(readIndex());
}

export function get(url) {
  return readIndex()[url] || null;
}

export function has(url) {
  return Boolean(readIndex()[url]);
}

/** Confirms the index entry still has bytes behind it in Cache Storage. */
export async function verify(url) {
  if (!supported() || !has(url)) return false;

  try {
    const cache = await caches.open(CACHE_NAME);
    return Boolean(await cache.match(url));
  } catch {
    return false;
  }
}

/**
 * Drops index entries whose cached response is gone (browser eviction, "clear
 * site data", or an update that changed the cache name).
 */
export async function prune() {
  if (!supported()) return 0;

  const index = readIndex();
  const urls = Object.keys(index);
  if (!urls.length) return 0;

  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const present = new Set(keys.map((request) => request.url));

  let removed = 0;

  for (const url of urls) {
    if (!present.has(new URL(url, location.href).href)) {
      delete index[url];
      removed += 1;
    }
  }

  if (removed) writeIndex(index);
  return removed;
}

export async function save(url, track) {
  if (!supported()) throw new Error("Offline storage is unavailable in this browser");
  if (!navigator.onLine) throw new Error("You are offline");

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);

  const length = Number(response.headers.get("content-length") || 0);
  if (length && length > MAX_TRACK_BYTES) throw new Error("Track is too large to keep offline");

  const cache = await caches.open(CACHE_NAME);
  await cache.put(url, response.clone());
  const blob = await response.blob();

  const index = readIndex();
  index[url] = {
    url,
    path: track.path,
    title: track.title,
    artist: track.artist || null,
    album: track.album || null,
    duration: track.duration || null,
    size: blob.size,
    savedAt: new Date().toISOString()
  };
  writeIndex(index);

  return index[url];
}

export async function remove(url) {
  const cache = await caches.open(CACHE_NAME);
  await cache.delete(url);

  const index = readIndex();
  delete index[url];
  writeIndex(index);
}

/** Object URL for a cached track, or null when it is not stored. */
export async function objectUrl(url) {
  if (!supported() || !has(url)) return null;

  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(url);
    if (!response) return null;
    return URL.createObjectURL(await response.blob());
  } catch {
    return null;
  }
}

export async function usage() {
  const entries = list();
  return {
    count: entries.length,
    bytes: entries.reduce((total, entry) => total + (entry.size || 0), 0)
  };
}

export async function clearAll() {
  if (supported()) await caches.delete(CACHE_NAME);
  writeIndex({});
}
