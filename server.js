"use strict";

/**
 * Resonance server: music API + web app host.
 *
 * Built on the original new.js music API (YouTube search via youtube-search-api,
 * downloads via yt-dlp). Adds:
 *   - static hosting of the PWA in ./public
 *   - a download queue with live progress and cancellation
 *   - a library index built from ID3/M4A tags
 *   - per-user libraries (each person gets their own folder)
 *   - sharing tracks between people
 *   - chunked (HLS) streaming so playback starts after the first segment
 *   - HTTP Range streaming as the fallback transport
 *   - cover-art extraction (embedded ID3 APIC, ffmpeg fallback)
 *
 * Identity is a username only (no passwords): it selects which library you see.
 * This is a home/LAN server — do not expose it to the internet.
 */

const express = require("express");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const youtubesearchapi = require("youtube-search-api");

const { readTags } = require("./lib/id3");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(os.homedir(), "music"));
const PUBLIC_DIR = path.join(__dirname, "public");
const CACHE_DIR = path.join(MUSIC_DIR, ".cache");
const COVER_DIR = path.join(CACHE_DIR, "covers");
const HLS_DIR = path.join(CACHE_DIR, "hls");
const USERS_DIR = path.join(MUSIC_DIR, "users");
const SHARED_DIR = path.join(MUSIC_DIR, "shared");
const DATA_DIR = path.join(MUSIC_DIR, ".data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SHARES_FILE = path.join(DATA_DIR, "shares.json");

const AUDIO_FORMAT = process.env.AUDIO_FORMAT || "mp3";
const AUDIO_QUALITY = process.env.AUDIO_QUALITY || "0";
const MAX_CONCURRENT_DOWNLOADS = Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 2;
const MAX_QUEUED_DOWNLOADS = Number(process.env.MAX_QUEUED_DOWNLOADS) || 25;
const MAX_JOB_HISTORY = 100;
const HLS_SEGMENT_SECONDS = Number(process.env.HLS_SEGMENT_SECONDS) || 4;
const HLS_MAX_BYTES = Number(process.env.HLS_MAX_BYTES) || 2 * 1024 * 1024 * 1024;
const HLS_MAX_ENTRIES = Number(process.env.HLS_MAX_ENTRIES) || 300;
const HLS_PLAYLIST_WAIT_MS = Number(process.env.HLS_PLAYLIST_WAIT_MS) || 6000;

/**
 * The library that already lives in MUSIC_DIR belongs to this user; anyone else
 * gets MUSIC_DIR/users/<name>. That keeps existing installs working untouched.
 */
const DEFAULT_USER = sanitizeUsername(process.env.DEFAULT_USER || os.userInfo().username || "owner") || "owner";

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".wav", ".webm", ".mp4"]);
const AUDIO_MIME = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".weba": "audio/webm",
    ".webm": "audio/webm"
};

const jobs = new Map();
const durationCache = new Map();
const tagCache = new Map();
const downloadQueue = [];
const hlsJobs = new Map();
const users = new Map();
const shares = [];

let activeDownloads = 0;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

/* --------------------------------------------------------------- identity */

/** Lenient: used to look up an already-registered name from a header/query. */
function sanitizeUsername(value) {
    if (typeof value !== "string") return null;

    const name = value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");

    if (!name || name.length > 32 || name === "." || name === "..") return null;
    return name;
}

/**
 * Strict: used for user input. A typo'd name is rejected with a readable error
 * instead of being silently rewritten into a different person's account.
 */
function cleanUsernameInput(value) {
    if (typeof value !== "string") return null;

    const name = value.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(name) ? name : null;
}

/** Username from the `x-resonance-user` header or `?user=`, else the default. */
function requestUser(req) {
    const raw = req.get("x-resonance-user") || req.query.user;
    if (typeof raw === "string" && raw.trim()) {
        const name = sanitizeUsername(raw);
        if (name) return name;
    }
    return DEFAULT_USER;
}

/** A track listing can address either a personal library or the shared area. */
function requestScope(req) {
    return req.query.scope === "shared" ? "shared" : "library";
}

function libraryRootFor(user) {
    // The default user owns whatever already sits in MUSIC_DIR.
    return user === DEFAULT_USER ? MUSIC_DIR : path.join(USERS_DIR, user);
}

function scopeRoot(user, scope) {
    return scope === "shared" ? SHARED_DIR : libraryRootFor(user);
}

function isWritableScope(scope) {
    return scope !== "shared";
}

/* ------------------------------------------------------------- persistence */

async function readJsonFile(file, fallback) {
    try {
        return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
        return fallback;
    }
}

async function writeJsonFile(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify(value, null, 2));
}

async function loadState() {
    const storedUsers = await readJsonFile(USERS_FILE, {});
    users.clear();

    for (const [name, meta] of Object.entries(storedUsers)) {
        const clean = sanitizeUsername(name);
        if (clean) users.set(clean, { name: clean, createdAt: meta?.createdAt || new Date().toISOString() });
    }

    // Folders already on disk count as people too, so a library copied in over
    // SMB/FTP (or restored from a backup) shows up without re-registering it.
    let discovered = false;

    try {
        for (const entry of await fsp.readdir(USERS_DIR, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;

            const clean = sanitizeUsername(entry.name);

            if (clean && !users.has(clean)) {
                users.set(clean, { name: clean, createdAt: new Date().toISOString() });
                discovered = true;
            }
        }
    } catch {
        /* no per-user folder yet */
    }

    if (!users.has(DEFAULT_USER)) {
        users.set(DEFAULT_USER, { name: DEFAULT_USER, createdAt: new Date().toISOString() });
        discovered = true;
    }

    if (discovered) await saveUsers();

    const storedShares = await readJsonFile(SHARES_FILE, []);
    shares.length = 0;

    if (Array.isArray(storedShares)) {
        for (const share of storedShares) {
            if (share && typeof share.id === "string") shares.push(share);
        }
    }
}

async function saveUsers() {
    await writeJsonFile(USERS_FILE, Object.fromEntries([...users].map(([name, meta]) => [name, meta])));
}

async function saveShares() {
    await writeJsonFile(SHARES_FILE, shares);
}

/* ------------------------------------------------------------------ helpers */

async function initialize() {
    await fsp.mkdir(MUSIC_DIR, { recursive: true });
    await fsp.mkdir(COVER_DIR, { recursive: true });
    await fsp.mkdir(HLS_DIR, { recursive: true });
    await fsp.mkdir(USERS_DIR, { recursive: true });
    await fsp.mkdir(SHARED_DIR, { recursive: true });
    await fsp.mkdir(DATA_DIR, { recursive: true });

    await loadState();
    await ensureUserLibrary(DEFAULT_USER);
    await pruneHlsCache();
}

async function ensureUserLibrary(user) {
    if (user && user !== DEFAULT_USER) {
        await fsp.mkdir(path.join(USERS_DIR, user), { recursive: true });
    }
}

/** Resolve a client-supplied relative path inside a library root. */
function resolveWithin(root, input = "") {
    if (typeof input !== "string" || path.isAbsolute(input)) {
        throw new Error("Invalid relative path");
    }

    const base = path.resolve(root);
    const target = path.resolve(base, input);

    if (target !== base && !target.startsWith(base + path.sep)) {
        throw new Error("Path outside the library");
    }

    return target;
}

function toRelative(root, absolute) {
    return path.relative(root, absolute).split(path.sep).join("/");
}

function isAudioFile(name) {
    return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Hidden entries (.cache, partial downloads, thumbnails) never show up. */
function isHidden(name) {
    return name.startsWith(".") || name.endsWith(".part") || name.endsWith(".ytdl") || name.endsWith(".jpg") || name.endsWith(".webp") || name.endsWith(".png");
}

/** `users/` and `shared/` are structure, not music, for the default user. */
function isReservedEntry(name) {
    return name === "users" || name === "shared";
}

function validateYouTubeUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return false;

    try {
        const url = new URL(value);

        if (url.protocol !== "https:" && url.protocol !== "http:") return false;

        const host = url.hostname.toLowerCase();
        if (!["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"].includes(host)) {
            return false;
        }

        const id = host.endsWith("youtu.be") ? url.pathname.slice(1) : url.searchParams.get("v");
        return typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id);
    } catch {
        return false;
    }
}

function youtubeIdFromUrl(value) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host.endsWith("youtu.be") ? url.pathname.slice(1) : url.searchParams.get("v");
}

/**
 * Binary availability is probed once and cached: spawnSync blocks the event
 * loop for the whole spawn, and doing that on every request stalled unrelated
 * listing/streaming calls behind it.
 */
// ffmpeg/ffprobe only understand the single-dash form; yt-dlp wants two.
const TOOLS = {
    ytDlp: { binary: "yt-dlp", args: ["--version"] },
    ffprobe: { binary: "ffprobe", args: ["-version"] },
    ffmpeg: { binary: "ffmpeg", args: ["-version"] }
};

const tools = { ytDlp: null, ffprobe: null, ffmpeg: null };
const TOOL_RETRY_MS = 15000;

function binaryAvailable(cacheKey) {
    const entry = tools[cacheKey];

    // A "yes" is permanent; a "no" is retried, because a binary can fail to
    // spawn under load (and a 4.5s `yt-dlp --version` must not run per request).
    if (entry && (entry.ok || Date.now() - entry.at < TOOL_RETRY_MS)) return entry.ok;

    const { binary, args } = TOOLS[cacheKey];
    const result = spawnSync(binary, args, { stdio: "ignore" });
    const ok = !result.error && result.status === 0;
    tools[cacheKey] = { ok, at: Date.now() };

    return ok;
}

/** Non-blocking warm-up so accepting connections never waits on a probe. */
function warmTools() {
    return Promise.all(
        Object.entries(TOOLS).map(
            ([cacheKey, { binary, args }]) =>
                new Promise((resolve) => {
                    if (tools[cacheKey]?.ok) return resolve(true);

                    const child = spawn(binary, args, { stdio: "ignore" });
                    const settle = (ok) => {
                        tools[cacheKey] = { ok, at: Date.now() };
                        resolve(ok);
                    };

                    child.on("error", () => settle(false));
                    child.on("close", (code) => settle(code === 0));
                })
        )
    );
}

function ffprobeAvailable() {
    return binaryAvailable("ffprobe");
}

function ffmpegAvailable() {
    return binaryAvailable("ffmpeg");
}

function ytDlpAvailable() {
    return binaryAvailable("ytDlp");
}

/* ------------------------------------------------------------ download jobs */

function publicJob(job) {
    return {
        id: job.id,
        user: job.user,
        url: job.url,
        videoId: job.videoId,
        status: job.status,
        phase: job.phase,
        progress: job.progress,
        title: job.title,
        channel: job.channel,
        artist: job.artist ?? null,
        album: job.album ?? null,
        duration: job.duration ?? null,
        hasCover: job.hasCover ?? null,
        thumbnail: job.thumbnail,
        file: job.file,
        error: job.error,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        autoPlay: job.autoPlay
    };
}

function pruneJobs() {
    if (jobs.size <= MAX_JOB_HISTORY) return;

    const finished = [...jobs.values()]
        .filter((job) => job.status !== "queued" && job.status !== "downloading" && job.status !== "processing")
        .sort((a, b) => new Date(a.finishedAt || a.createdAt) - new Date(b.finishedAt || b.createdAt));

    while (jobs.size > MAX_JOB_HISTORY && finished.length) {
        jobs.delete(finished.shift().id);
    }
}

function enqueueJob(url, user, { autoPlay = false } = {}) {
    const job = {
        id: randomUUID(),
        user,
        url,
        videoId: youtubeIdFromUrl(url),
        status: "queued",
        phase: "Waiting in queue",
        progress: { percent: 0, downloadedBytes: 0, totalBytes: null, speed: null, eta: null },
        title: null,
        channel: null,
        artist: null,
        album: null,
        duration: null,
        hasCover: null,
        thumbnail: null,
        file: null,
        error: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        autoPlay,
        child: null,
        canceled: false
    };

    jobs.set(job.id, job);
    downloadQueue.push(job.id);
    pumpQueue();
    return job;
}

function pumpQueue() {
    while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length) {
        const id = downloadQueue.shift();
        const job = jobs.get(id);

        if (!job || job.status !== "queued") {
            continue;
        }

        startDownload(job);
    }
}

function startDownload(job) {
    activeDownloads += 1;
    job.status = "downloading";
    job.phase = "Downloading";
    job.startedAt = new Date().toISOString();

    const targetDir = libraryRootFor(job.user);

    // Output template keeps the video id so re-downloads and duplicate titles
    // cannot clobber each other.
    const outputTemplate = "%(title)s [%(id)s].%(ext)s";

    const args = [
        "--no-playlist",
        "--no-warnings",
        "--newline",
        "--progress",
        "--progress-template",
        "download:PROGRESS|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",
        "--progress-template",
        "postprocess:POSTPROC|%(progress.status)s",
        "-x",
        "--audio-format",
        AUDIO_FORMAT,
        "--audio-quality",
        AUDIO_QUALITY,
        "--embed-metadata",
        "--embed-thumbnail",
        "--print",
        "after_move:FILE|%(filepath)s",
        "-P",
        targetDir,
        "-o",
        outputTemplate,
        job.url
    ];

    const child = spawn("yt-dlp", args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
    });

    job.child = child;

    let stderr = "";
    let lastLine = "";
    let stdoutBuffer = "";

    const handleLine = (line) => {
        if (!line) return;

        if (line.startsWith("PROGRESS|")) {
            const [, downloaded, total, estimate, speed, eta] = line.split("|");
            const bytes = toNumber(downloaded);
            const totalBytes = toNumber(total) ?? toNumber(estimate);

            job.progress = {
                percent: totalBytes && bytes ? Math.min(100, Math.round((bytes / totalBytes) * 1000) / 10) : 0,
                downloadedBytes: bytes ?? 0,
                totalBytes: totalBytes ?? null,
                speed: toNumber(speed),
                eta: toNumber(eta)
            };

            if (job.progress.percent >= 99.9) {
                job.phase = "Converting audio";
            }

            return;
        }

        if (line.startsWith("POSTPROC|")) {
            const status = line.slice("POSTPROC|".length).trim();
            if (status && status !== "NA") job.phase = humanizePostProcess(status);
            return;
        }

        if (line.startsWith("FILE|")) {
            const filePath = line.slice("FILE|".length).trim();
            if (filePath) {
                job.file = toRelative(targetDir, path.resolve(filePath));
            }
        }
    };

    const consume = (chunk, isStderr) => {
        const text = chunk.toString();

        if (isStderr) {
            stderr = (stderr + text).slice(-4000);
            return;
        }

        stdoutBuffer += text.replace(/\r/g, "\n");
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
            lastLine = line;
            handleLine(line.trim());
        }
    };

    child.stdout.on("data", (chunk) => consume(chunk, false));
    child.stderr.on("data", (chunk) => consume(chunk, true));

    const finish = () => {
        activeDownloads = Math.max(0, activeDownloads - 1);
        job.child = null;
        pumpQueue();
    };

    child.on("error", (error) => {
        job.status = "failed";
        job.phase = "Failed";
        job.error = error.message;
        job.finishedAt = new Date().toISOString();
        finish();
        pruneJobs();
    });

    child.on("close", async (code, signal) => {
        if (signal || job.canceled) {
            job.status = "canceled";
            job.phase = "Canceled";
            job.error = job.error || "Canceled";
        } else if (code === 0) {
            job.status = "completed";
            job.phase = "Completed";
            job.progress.percent = 100;
            job.error = null;

            if (stdoutBuffer.trim()) {
                handleLine(stdoutBuffer.trim());
            }

            if (!job.file) {
                job.file = findDownloadedFile(job, targetDir);
            }

            // Pull the embedded tags so clients can build rich track objects.
            if (job.file) {
                try {
                    const tags = await tagsFor(resolveWithin(targetDir, job.file));
                    job.title = tags.tags.title || job.title;
                    job.channel = job.channel || tags.tags.artist || tags.tags.albumArtist || null;
                    job.artist = tags.tags.artist || tags.tags.albumArtist || null;
                    job.album = tags.tags.album || null;
                    job.duration = tags.tags.duration || null;
                    job.hasCover = Boolean(tags.tags.picture);
                } catch {
                    /* tags are a nice-to-have */
                }
            }
        } else {
            job.status = "failed";
            job.phase = "Failed";
            job.error = (stderr.trim() || lastLine || `yt-dlp exited with code ${code}`).slice(-1200);
        }

        job.finishedAt = job.finishedAt || new Date().toISOString();
        finish();
        pruneJobs();
    });

    // Report the video title as soon as we know it so queued jobs look alive.
    resolveVideoMeta(job).catch(() => {});
}

function toNumber(value) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    if (!trimmed || trimmed === "NA" || trimmed === "None") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

function humanizePostProcess(status) {
    const map = {
        started: "Converting audio",
        processing: "Converting audio",
        finished: "Finishing up"
    };
    return map[status] || "Converting audio";
}

async function resolveVideoMeta(job) {
    if (job.title && job.thumbnail) return;

    try {
        const data = await youtubessearchapiDetails(job.videoId);
        const details = data?.items?.[0] ?? data?.items ?? data;
        job.title = job.title || details?.title || null;
        job.channel = job.channel || details?.channelTitle || details?.author || null;
        job.thumbnail =
            job.thumbnail ||
            details?.thumbnail?.thumbnails?.slice(-1)?.[0]?.url ||
            `https://i.ytimg.com/vi/${job.videoId}/mqdefault.jpg`;
    } catch {
        job.thumbnail = job.thumbnail || `https://i.ytimg.com/vi/${job.videoId}/mqdefault.jpg`;
    }
}

function youtubessearchapiDetails(videoId) {
    return youtubesearchapi.GetVideoDetails(videoId);
}

function findDownloadedFile(job, targetDir) {
    // Fallback: newest audio file that mentions the video id in its name.
    try {
        const entries = fs.readdirSync(targetDir, { withFileTypes: true });
        const candidates = entries
            .filter((entry) => entry.isFile() && !isHidden(entry.name) && entry.name.includes(job.videoId))
            .map((entry) => {
                const full = path.join(targetDir, entry.name);
                return { full, mtime: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);

        return candidates.length ? toRelative(targetDir, candidates[0].full) : null;
    } catch {
        return null;
    }
}

/* ---------------------------------------------------------------- library */

async function tagsFor(filePath) {
    const stat = await fsp.stat(filePath);
    const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
    const cached = tagCache.get(key);

    if (cached) return cached;

    const tags = await readTags(filePath).catch(() => ({}));
    const result = { tags, size: stat.size, mtime: stat.mtimeMs };
    tagCache.set(key, result);

    if (tagCache.size > 2000) tagCache.clear();

    return result;
}

function prettifyFilename(name) {
    return path
        .basename(name, path.extname(name))
        .replace(/\s*\[[a-zA-Z0-9_-]{11}\]$/, "")
        .trim();
}

/** Query string that ties a media URL to the right library. */
function scopeQuery(user, scope) {
    return scope === "shared" ? "scope=shared" : `user=${encodeURIComponent(user)}`;
}

async function describeTrack(relativePath, { user, scope }) {
    const root = scopeRoot(user, scope);
    const absolute = resolveWithin(root, relativePath);
    const { tags, size, mtime } = await tagsFor(absolute);
    const fallback = prettifyFilename(relativePath);
    const duration = tags.duration ?? durationCache.get(`${absolute}:${size}:${mtime}`) ?? null;
    const base = scopeQuery(user, scope);

    return {
        path: relativePath,
        name: path.basename(relativePath),
        title: tags.title || fallback,
        artist: tags.artist || tags.albumArtist || null,
        album: tags.album || null,
        duration,
        size,
        mtime,
        hasCover: Boolean(tags.picture),
        user: scope === "shared" ? null : user,
        scope,
        url: `/api/stream?path=${encodeURIComponent(relativePath)}&${base}`,
        cover: `/api/cover?path=${encodeURIComponent(relativePath)}&${base}`,
        hls: `/api/playlist.m3u8?path=${encodeURIComponent(relativePath)}&${base}`
    };
}

/* ------------------------------------------------------- chunked streaming */

function hlsKey(absolute, stat) {
    return createHash("sha1").update(`${absolute}:${stat.size}:${stat.mtimeMs}`).digest("hex");
}

function hlsDirFor(key) {
    return path.join(HLS_DIR, key);
}

function rewritePlaylist(text, key, base) {
    const lines = text.split("\n");

    return lines
        .map((line) => {
            const trimmed = line.trim();

            if (trimmed.endsWith(".ts")) {
                return `${base}/api/chunk?key=${key}&name=${encodeURIComponent(path.basename(trimmed))}`;
            }

            return line;
        })
        .join("\n");
}

/** Absolute base URL of this request, so HLS URIs are unambiguous. */
function requestBase(req) {
    const configured = process.env.PUBLIC_BASE_URL;
    if (configured) return configured.replace(/\/+$/, "");

    const host = req.get("host");
    if (!host) return "";

    return `${req.protocol}://${host}`;
}

async function readPlaylist(key) {
    try {
        const text = await fsp.readFile(path.join(hlsDirFor(key), "index.m3u8"), "utf8");
        return text.includes("#EXTM3U") ? text : null;
    } catch {
        return null;
    }
}

/** Starts (once) an ffmpeg segmentation job for a file. */
function startHlsGeneration(key, absolute) {
    if (hlsJobs.has(key)) return;

    const dir = hlsDirFor(key);
    hlsJobs.set(key, { dir, startedAt: Date.now(), done: false });

    fs.mkdir(dir, { recursive: true }, () => {
        const args = [
            "-hide_banner",
            "-loglevel", "error",
            "-i", absolute,
            "-vn",
            "-c:a", "aac",
            "-b:a", "192k",
            "-ac", "2",
            "-f", "hls",
            "-hls_time", String(HLS_SEGMENT_SECONDS),
            "-hls_list_size", "0",
            "-hls_playlist_type", "event",
            "-hls_segment_filename", path.join(dir, "seg%05d.ts"),
            path.join(dir, "index.m3u8")
        ];

        const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
        const job = hlsJobs.get(key);

        if (job) job.child = child;

        let stderr = "";

        child.stderr?.on("data", (chunk) => {
            stderr = (stderr + chunk.toString()).slice(-2000);
        });

        child.on("error", (error) => {
            console.error(`HLS generation failed for ${absolute}: ${error.message}`);
            hlsJobs.delete(key);
        });

        child.on("close", (code) => {
            const entry = hlsJobs.get(key);

            if (entry) {
                entry.done = code === 0;
                entry.child = null;
            }

            if (code !== 0 && stderr) {
                console.error(`HLS generation exited ${code}: ${stderr.trim().slice(-300)}`);
            }
        });
    });
}

/** Waits for the first segments to land so clients can start playing. */
async function ensurePlaylist(key, absolute) {
    let text = await readPlaylist(key);

    if (hlsJobs.get(key)?.done && text) {
        return text;
    }

    startHlsGeneration(key, absolute);

    const deadline = Date.now() + HLS_PLAYLIST_WAIT_MS;

    while (Date.now() < deadline) {
        text = await readPlaylist(key);

        // A playlist with a segment line is enough to start playback.
        if (text && /\.ts/.test(text)) {
            return text;
        }

        await new Promise((resolve) => setTimeout(resolve, 120));
    }

    return text;
}

const CONTENT_TYPE_TS = "video/mp2t";

async function pruneHlsCache() {
    try {
        const entries = await fsp.readdir(HLS_DIR, { withFileTypes: true });
        const stats = [];

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const dir = path.join(HLS_DIR, entry.name);
            let bytes = 0;
            let mtime = 0;

            for (const file of await fsp.readdir(dir)) {
                const stat = await fsp.stat(path.join(dir, file)).catch(() => null);
                if (!stat) continue;
                bytes += stat.size;
                mtime = Math.max(mtime, stat.mtimeMs);
            }

            stats.push({ dir, bytes, mtime });
        }

        stats.sort((a, b) => a.mtime - b.mtime);

        let total = stats.reduce((sum, item) => sum + item.bytes, 0);

        while (stats.length && (total > HLS_MAX_BYTES || stats.length > HLS_MAX_ENTRIES)) {
            const victim = stats.shift();
            await fsp.rm(victim.dir, { recursive: true, force: true });
            total -= victim.bytes;
        }
    } catch {
        /* cache pruning is best effort */
    }
}

/* ------------------------------------------------------------------ shares */

function publicShare(share, viewer = DEFAULT_USER) {
    const senderRoot = libraryRootFor(share.from);
    const absolute = path.join(senderRoot, share.trackPath);
    const exists = fs.existsSync(absolute);

    // Media URLs carry the viewer because <audio>/<img>/<video> cannot send the
    // identity header; whoever asked is the only one who ever sees these URLs.
    const viewerQuery = `user=${encodeURIComponent(viewer)}`;

    return {
        id: share.id,
        from: share.from,
        to: share.to,
        trackPath: share.trackPath,
        title: share.title || prettifyFilename(share.trackPath),
        artist: share.artist ?? null,
        album: share.album ?? null,
        duration: share.duration ?? null,
        hasCover: Boolean(share.hasCover),
        note: share.note ?? null,
        createdAt: share.createdAt,
        available: exists,
        stream: `/api/stream?share=${share.id}&${viewerQuery}`,
        cover: `/api/cover?share=${share.id}&${viewerQuery}`,
        hls: `/api/playlist.m3u8?share=${share.id}&${viewerQuery}`
    };
}

function findShare(id) {
    return shares.find((share) => share.id === id);
}

/** Visible to the sender, the recipient, or everyone when shared with "*". */
function shareIsVisibleTo(share, user) {
    return share.from === user || share.to === user || share.to === "*";
}

/* ---------------------------------------------------------------- routes */

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        musicDir: MUSIC_DIR,
        defaultUser: DEFAULT_USER,
        user: requestUser(req),
        users: users.size,
        shares: shares.length,
        format: AUDIO_FORMAT,
        ytDlp: ytDlpAvailable(),
        ffprobe: ffprobeAvailable(),
        ffmpeg: ffmpegAvailable(),
        chunked: ffmpegAvailable(),
        segmentSeconds: HLS_SEGMENT_SECONDS,
        activeDownloads,
        queued: downloadQueue.length
    });
});

/* ----- users ----- */

async function userSummary(name) {
    const root = libraryRootFor(name);
    let tracks = 0;
    let bytes = 0;

    try {
        const entries = await fsp.readdir(root, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isFile() || isHidden(entry.name) || !isAudioFile(entry.name)) continue;
            const stat = await fsp.stat(path.join(root, entry.name)).catch(() => null);
            tracks += 1;
            bytes += stat?.size ?? 0;
        }
    } catch {
        /* an empty or missing folder is fine */
    }

    return { name, tracks, bytes, createdAt: users.get(name)?.createdAt ?? null, isDefault: name === DEFAULT_USER };
}

// GET /api/users
app.get("/api/users", async (req, res) => {
    try {
        const list = await Promise.all([...users.keys()].sort().map(userSummary));
        res.json({ defaultUser: DEFAULT_USER, users: list });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/users { name }
app.post("/api/users", async (req, res) => {
    const name = cleanUsernameInput(req.body?.name);

    if (!name) {
        return res.status(400).json({ error: "Usernames are 1–32 characters: letters, digits, . _ -" });
    }

    try {
        if (!users.has(name)) {
            users.set(name, { name, createdAt: new Date().toISOString() });
            await saveUsers();
        }

        await ensureUserLibrary(name);
        res.status(201).json(await userSummary(name));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /api/me
app.get("/api/me", async (req, res) => {
    const user = requestUser(req);
    await ensureUserLibrary(user);
    res.json(await userSummary(user));
});

/* ----- search / downloads ----- */

// GET /api/search?q=...
app.get("/api/search", async (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";

    if (!query || query.length > 200) {
        return res.status(400).json({ error: "Invalid search query" });
    }

    try {
        const data = await youtubesearchapi.GetListByKeyword(query, false, 20, [{ type: "video" }]);

        const items = (data.items || [])
            .filter((item) => item.id && item.title && !item.isLive)
            .map((item) => ({
                id: item.id,
                name: item.title,
                url: `https://www.youtube.com/watch?v=${item.id}`,
                thumbnail: item.thumbnail?.thumbnails?.slice(-1)?.[0]?.url ?? null,
                channel: item.channelTitle ?? null,
                length: item.length?.simpleText ?? null,
                views: item.shortViewCountText ?? null
            }));

        res.json(items);
    } catch (error) {
        console.error("YouTube search failed:", error.message);
        res.status(502).json({ error: "YouTube search failed" });
    }
});

// POST /api/download { url, autoPlay? }
app.post("/api/download", async (req, res) => {
    const { url, autoPlay } = req.body || {};
    const user = requestUser(req);

    if (!validateYouTubeUrl(url)) {
        return res.status(400).json({ error: "Invalid YouTube video URL" });
    }

    if (!ytDlpAvailable()) {
        return res.status(503).json({ error: "yt-dlp is not installed on the server" });
    }

    if (downloadQueue.length >= MAX_QUEUED_DOWNLOADS) {
        return res.status(429).json({ error: "Download queue is full" });
    }

    await ensureUserLibrary(user);

    const job = enqueueJob(url, user, { autoPlay: Boolean(autoPlay) });

    res.status(202).json(publicJob(job));
});

// GET /api/jobs  (scoped to the current user)
app.get("/api/jobs", (req, res) => {
    const user = requestUser(req);

    const list = [...jobs.values()]
        .filter((job) => job.user === user)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(publicJob);

    res.json({ jobs: list, active: activeDownloads, queued: downloadQueue.length, user });
});

// GET /api/jobs/:id
app.get("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Download job not found" });
    res.json(publicJob(job));
});

// DELETE /api/jobs/:id  -> cancel (also clears finished jobs from history)
app.delete("/api/jobs/:id", async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Download job not found" });

    if (job.status === "queued") {
        job.canceled = true;
        job.status = "canceled";
        job.phase = "Canceled";
        job.finishedAt = new Date().toISOString();
        const index = downloadQueue.indexOf(job.id);
        if (index !== -1) downloadQueue.splice(index, 1);
    } else if (job.child) {
        job.canceled = true;
        job.phase = "Canceling";

        // SIGINT lets yt-dlp clean up its .part files; give it a moment to exit
        // so the response reflects the final state.
        const child = job.child;
        child.kill("SIGINT");
        await Promise.race([
            once(child, "close"),
            new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
    } else {
        jobs.delete(job.id);
        return res.json({ removed: true });
    }

    res.json(publicJob(job));
});

/* ----- library ----- */

// GET /api/tracks?path=&recursive=1[&scope=shared]
app.get("/api/tracks", async (req, res) => {
    try {
        const user = requestUser(req);
        const scope = requestScope(req);
        const root = scopeRoot(user, scope);
        const relativePath = typeof req.query.path === "string" ? req.query.path.replace(/^\/+|\/+$/g, "") : "";
        const recursive = req.query.recursive === "1" || req.query.recursive === "true";

        const dir = resolveWithin(root, relativePath);
        const stat = await fsp.stat(dir).catch((error) => {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") {
                const notFound = new Error("Directory not found");
                notFound.status = 404;
                throw notFound;
            }
            throw error;
        });

        if (!stat.isDirectory()) {
            return res.status(400).json({ error: "Not a directory" });
        }

        const folders = [];
        const tracks = [];
        const seen = new Set();
        const isLibraryRoot = scope === "library" && dir === libraryRootFor(user);

        const walk = async (currentDir, currentRelative, depth) => {
            const entries = await fsp.readdir(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                if (isHidden(entry.name)) continue;
                if (isLibraryRoot && depth === 0 && entry.isDirectory() && isReservedEntry(entry.name)) continue;

                const entryRelative = currentRelative ? `${currentRelative}/${entry.name}` : entry.name;
                const fullPath = path.join(currentDir, entry.name);

                if (entry.isDirectory()) {
                    if (depth === 0) {
                        folders.push({ name: entry.name, path: entryRelative, type: "directory" });
                    }
                    if (recursive && depth < 8 && seen.size < 4000) {
                        await walk(fullPath, entryRelative, depth + 1);
                    }
                } else if (entry.isFile() && isAudioFile(entry.name) && seen.size < 4000) {
                    seen.add(entryRelative);
                    if (!recursive && depth > 0) continue;
                    tracks.push(await describeTrack(entryRelative, { user, scope }));
                }
            }
        };

        await walk(dir, relativePath, 0);

        tracks.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
        folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        res.json({
            user: scope === "shared" ? null : user,
            scope,
            writable: isWritableScope(scope),
            path: relativePath,
            parent: relativePath ? relativePath.split("/").slice(0, -1).join("/") : null,
            folders,
            tracks,
            total: tracks.length
        });
    } catch (error) {
        if (error.code === "EACCES") return res.status(403).json({ error: "Permission denied" });
        res.status(error.status || 400).json({ error: error.message });
    }
});

// GET /api/duration?path=...
app.get("/api/duration", async (req, res) => {
    try {
        const user = requestUser(req);
        const scope = requestScope(req);
        const relativePath = String(req.query.path || "");
        const absolute = resolveWithin(scopeRoot(user, scope), relativePath);
        const stat = await fsp.stat(absolute);
        const key = `${absolute}:${stat.size}:${stat.mtimeMs}`;

        if (durationCache.has(key)) {
            return res.json({ path: relativePath, duration: durationCache.get(key) });
        }

        const seconds = await probeDuration(absolute);
        if (seconds) durationCache.set(key, seconds);

        res.json({ path: relativePath, duration: seconds });
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

function probeDuration(absolute) {
    return new Promise((resolve) => {
        const child = spawn("ffprobe", [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            absolute
        ], { stdio: ["ignore", "pipe", "ignore"] });

        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk.toString()));
        child.on("error", () => resolve(null));
        child.on("close", () => {
            const value = Number.parseFloat(out.trim());
            resolve(Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null);
        });
    });
}

/* ----- media resolution (path, shared area, or a share id) ----- */

async function resolveMediaTarget(req) {
    const shareId = req.query.share;

    if (typeof shareId === "string" && shareId) {
        const share = findShare(shareId);

        if (!share) {
            const error = new Error("Share not found");
            error.status = 404;
            throw error;
        }

        if (!shareIsVisibleTo(share, requestUser(req))) {
            const error = new Error("Not your share");
            error.status = 403;
            throw error;
        }

        const absolute = resolveWithin(libraryRootFor(share.from), share.trackPath);
        const stat = await fsp.stat(absolute);

        return { absolute, stat, label: share.trackPath, kind: "share", share };
    }

    const user = requestUser(req);
    const scope = requestScope(req);
    const relativePath = String(req.query.path || "");
    const absolute = resolveWithin(scopeRoot(user, scope), relativePath);
    const stat = await fsp.stat(absolute);

    return { absolute, stat, label: relativePath, kind: scope === "shared" ? "shared" : "library", user, scope };
}

/** Range-aware file responder shared by /api/stream and /api/chunk. */
function sendFileWithRanges(req, res, absolute, stat, { contentType, etag, cacheControl, downloadName } = {}) {
    const headers = {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": cacheControl || "private, max-age=3600",
        ETag: etag,
        "Last-Modified": stat.mtime.toUTCString()
    };

    if (downloadName) {
        headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(downloadName)}"`;
    }

    if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
    }

    const range = req.headers.range;

    if (!range) {
        res.writeHead(200, { ...headers, "Content-Length": stat.size });

        if (req.method === "HEAD") return res.end();

        const stream = fs.createReadStream(absolute);
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());

    if (!match) {
        return res.status(416).set({ "Content-Range": `bytes */${stat.size}` }).end();
    }

    let start = match[1] === "" ? null : Number.parseInt(match[1], 10);
    let end = match[2] === "" ? null : Number.parseInt(match[2], 10);

    if (start === null && end === null) {
        return res.status(416).set({ "Content-Range": `bytes */${stat.size}` }).end();
    }

    if (start === null) {
        // Suffix range: last N bytes.
        start = Math.max(0, stat.size - end);
        end = stat.size - 1;
    } else if (end === null || end >= stat.size) {
        end = stat.size - 1;
    }

    if (start >= stat.size || start > end) {
        return res.status(416).set({ "Content-Range": `bytes */${stat.size}` }).end();
    }

    res.writeHead(206, {
        ...headers,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1
    });

    if (req.method === "HEAD") return res.end();

    const stream = fs.createReadStream(absolute, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
}

// GET /api/stream?path=|share=   (Range aware whole-file fallback)
app.get("/api/stream", async (req, res) => {
    try {
        const target = await resolveMediaTarget(req);

        if (!target.stat.isFile()) {
            return res.status(400).json({ error: "Not a file" });
        }

        sendFileWithRanges(req, res, target.absolute, target.stat, {
            contentType: AUDIO_MIME[path.extname(target.absolute).toLowerCase()] || "application/octet-stream",
            etag: `"${createHash("sha1").update(`${target.absolute}:${target.stat.size}:${target.stat.mtimeMs}`).digest("hex")}"`,
            downloadName: req.query.download === "1" ? path.basename(target.absolute) : null
        });
    } catch (error) {
        res.status(error.status || (error.code === "ENOENT" ? 404 : 400)).json({ error: error.message || "Stream failed" });
    }
});

// GET /api/playlist?path=|share=   -> chunked (HLS) playlist for seamless start
// Also served as /api/playlist.m3u8 so players that sniff the extension agree.
async function handlePlaylist(req, res) {
    try {
        if (!ffmpegAvailable()) {
            return res.status(503).json({ error: "Chunked streaming needs ffmpeg on the server" });
        }

        const target = await resolveMediaTarget(req);

        if (!target.stat.isFile()) {
            return res.status(400).json({ error: "Not a file" });
        }

        const key = hlsKey(target.absolute, target.stat);
        const playlist = await ensurePlaylist(key, target.absolute);

        if (!playlist) {
            return res.status(504).json({ error: "Chunked stream is still starting — retry in a moment" });
        }

        res.set({
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-cache",
            "X-Resonance-Segment-Seconds": String(HLS_SEGMENT_SECONDS),
            "X-Resonance-Stream-Key": key
        });

        res.send(rewritePlaylist(playlist, key, requestBase(req)));
    } catch (error) {
        res.status(error.status || (error.code === "ENOENT" ? 404 : 400)).json({ error: error.message || "Playlist failed" });
    }
}

app.get("/api/playlist", handlePlaylist);
app.get("/api/playlist.m3u8", handlePlaylist);

// GET /api/chunk?key=<sha1>&name=seg00001.ts
app.get("/api/chunk", async (req, res) => {
    try {
        const key = String(req.query.key || "");
        const name = path.basename(String(req.query.name || ""));

        if (!/^[0-9a-f]{40}$/.test(key) || !/^[A-Za-z0-9._-]+\.ts$/.test(name)) {
            return res.status(400).json({ error: "Invalid chunk reference" });
        }

        const absolute = path.join(HLS_DIR, key, name);
        const stat = await fsp.stat(absolute).catch(() => null);

        if (!stat?.isFile()) {
            return res.status(404).json({ error: "Chunk not ready" });
        }

        sendFileWithRanges(req, res, absolute, stat, {
            contentType: CONTENT_TYPE_TS,
            etag: `"${createHash("sha1").update(`${absolute}:${stat.size}:${stat.mtimeMs}`).digest("hex")}"`,
            cacheControl: "public, max-age=604800, immutable"
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

// GET /api/cover?path=|share=
app.get("/api/cover", async (req, res) => {
    try {
        const target = await resolveMediaTarget(req);
        const etag = `"c${createHash("sha1").update(`${target.absolute}:${target.stat.size}:${target.stat.mtimeMs}`).digest("hex")}"`;

        if (req.headers["if-none-match"] === etag) {
            return res.status(304).end();
        }

        res.set({
            "Cache-Control": "public, max-age=604800",
            ETag: etag
        });

        const { tags } = await tagsFor(target.absolute);
        const embedded = tags.picture;

        if (embedded) {
            res.set("Content-Type", embedded.mime);
            return res.end(embedded.data);
        }

        const extracted = await extractCoverWithFfmpeg(target.absolute, target.label, target.stat);

        if (!extracted) {
            return res.status(404).json({ error: "No embedded cover art" });
        }

        res.set("Content-Type", "image/jpeg");
        return res.sendFile(extracted);
    } catch (error) {
        res.status(error.status || (error.code === "ENOENT" ? 404 : 400)).json({ error: error.message });
    }
});

async function extractCoverWithFfmpeg(absolute, label, stat) {
    const cacheName = `${createHash("sha1").update(`${absolute}:${stat.size}:${stat.mtimeMs}`).digest("hex")}.jpg`;
    const cached = path.join(COVER_DIR, cacheName);

    if (fs.existsSync(cached)) return cached;

    const ok = await new Promise((resolve) => {
        const child = spawn("ffmpeg", [
            "-v", "error",
            "-i", absolute,
            "-an",
            "-map", "0:v:0",
            "-c:v", "mjpeg",
            "-frames:v", "1",
            "-y", cached
        ], { stdio: ["ignore", "ignore", "ignore"] });

        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
    });

    if (!ok || !fs.existsSync(cached)) return null;

    const size = fs.statSync(cached).size;
    if (!size) {
        await fsp.rm(cached, { force: true });
        return null;
    }

    return cached;
}

// DELETE /api/track?path=...   (your own library only)
app.delete("/api/track", async (req, res) => {
    try {
        const user = requestUser(req);
        const relativePath = String(req.query.path || "");
        const root = libraryRootFor(user);
        const absolute = resolveWithin(root, relativePath);

        if (!isAudioFile(absolute)) {
            return res.status(400).json({ error: "Not an audio file" });
        }

        await fsp.unlink(absolute);

        tagCache.clear();
        durationCache.clear();

        res.json({ removed: true, path: relativePath, user });
    } catch (error) {
        res.status(error.code === "ENOENT" ? 404 : 400).json({ error: error.message });
    }
});

/* ----- sharing ----- */

// GET /api/shares  -> what people shared with you, and what you shared
app.get("/api/shares", (req, res) => {
    const user = requestUser(req);

    const incoming = shares
        .filter((share) => share.to === user || share.to === "*")
        .filter((share) => share.from !== user)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((share) => publicShare(share, user));

    const outgoing = shares
        .filter((share) => share.from === user)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map((share) => publicShare(share, user));

    res.json({ user, incoming, outgoing });
});

// POST /api/share { trackPath, to, note? }
app.post("/api/share", async (req, res) => {
    const from = requestUser(req);
    const trackPath = String(req.body?.trackPath || "");
    const rawTo = String(req.body?.to || "");
    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 280) : null;

    const to = rawTo === "*" ? "*" : cleanUsernameInput(rawTo);

    if (!to) {
        return res.status(400).json({ error: "Pick who to share with" });
    }

    if (to !== "*" && !users.has(to)) {
        return res.status(404).json({ error: `No such user: ${to}` });
    }

    try {
        const root = libraryRootFor(from);
        const absolute = resolveWithin(root, trackPath);

        if (!isAudioFile(absolute)) {
            return res.status(400).json({ error: "Not an audio file" });
        }

        const { tags, size } = await tagsFor(absolute);

        const share = {
            id: randomUUID(),
            from,
            to,
            trackPath,
            title: tags.title || prettifyFilename(trackPath),
            artist: tags.artist || tags.albumArtist || null,
            album: tags.album || null,
            duration: tags.duration ?? null,
            hasCover: Boolean(tags.picture),
            size,
            note,
            createdAt: new Date().toISOString()
        };

        shares.push(share);
        await saveShares();

        res.status(201).json(publicShare(share, from));
    } catch (error) {
        res.status(error.code === "ENOENT" ? 404 : 400).json({ error: error.message });
    }
});

// DELETE /api/shares/:id  -> sender revokes, recipient dismisses
app.delete("/api/shares/:id", async (req, res) => {
    const user = requestUser(req);
    const index = shares.findIndex((share) => share.id === req.params.id);

    if (index === -1) {
        return res.status(404).json({ error: "Share not found" });
    }

    const share = shares[index];

    if (share.from !== user && share.to !== user && share.to !== "*") {
        return res.status(403).json({ error: "Not your share" });
    }

    shares.splice(index, 1);
    await saveShares();

    res.json({ removed: true, id: share.id });
});

// POST /api/shares/:id/import  -> copy a shared track into your own library
app.post("/api/shares/:id/import", async (req, res) => {
    const user = requestUser(req);
    const share = findShare(req.params.id);

    if (!share) {
        return res.status(404).json({ error: "Share not found" });
    }

    if (!shareIsVisibleTo(share, user)) {
        return res.status(403).json({ error: "Not your share" });
    }

    try {
        const source = resolveWithin(libraryRootFor(share.from), share.trackPath);
        const stat = await fsp.stat(source);

        if (!stat.isFile()) {
            return res.status(404).json({ error: "The shared file is gone" });
        }

        const root = libraryRootFor(user);
        await ensureUserLibrary(user);

        const destination = await uniqueDestination(root, path.basename(share.trackPath), share.from);
        await fsp.copyFile(source, destination);

        const relative = toRelative(root, destination);
        tagCache.clear();

        res.status(201).json({
            imported: true,
            user,
            path: relative,
            track: await describeTrack(relative, { user, scope: "library" })
        });
    } catch (error) {
        res.status(error.code === "ENOENT" ? 404 : 400).json({ error: error.message });
    }
});

/** Avoids clobbering an existing file: "Song.mp3" -> "Song (from bob).mp3". */
async function uniqueDestination(root, fileName, fromUser) {
    const parsed = path.parse(fileName);
    const candidates = [
        path.join(root, fileName),
        path.join(root, `${parsed.name} (from ${fromUser})${parsed.ext}`)
    ];

    for (const candidate of candidates) {
        if (!fs.existsSync(candidate)) return candidate;
    }

    for (let index = 2; index < 100; index += 1) {
        const candidate = path.join(root, `${parsed.name} (from ${fromUser} ${index})${parsed.ext}`);
        if (!fs.existsSync(candidate)) return candidate;
    }

    return path.join(root, `${parsed.name}-${randomUUID().slice(0, 8)}${parsed.ext}`);
}

/* ------------------------------------------------------------ static / PWA */

app.use(
    express.static(PUBLIC_DIR, {
        index: "index.html",
        etag: true,
        maxAge: 0,
        setHeaders(res, filePath) {
            if (filePath.endsWith("sw.js") || filePath.endsWith("manifest.webmanifest")) {
                res.setHeader("Cache-Control", "no-cache");
            }
        }
    })
);

// SPA fallback (Express 5 needs the named wildcard form).
app.get("/{*splat}", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
});

/* ------------------------------------------------------------------- boot */

async function start() {
    await initialize();

    const server =
        process.env.TLS_CERT && process.env.TLS_KEY
            ? https.createServer(
                  {
                      cert: fs.readFileSync(process.env.TLS_CERT),
                      key: fs.readFileSync(process.env.TLS_KEY)
                  },
                  app
              )
            : http.createServer(app);

    server.listen(PORT, HOST, () => {
        const scheme = process.env.TLS_CERT ? "https" : "http";
        console.log(`Music API listening on ${scheme}://${HOST}:${PORT}`);
        console.log(`Library directory: ${MUSIC_DIR}`);
        console.log(`Default user: ${DEFAULT_USER} (owns ${MUSIC_DIR}) · per-user folders: ${USERS_DIR}`);


        for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
            for (const address of addresses || []) {
                if (address.family === "IPv4" && !address.internal) {
                    console.log(`  LAN: ${scheme}://${address.address}:${PORT}  (${name})`);
                }
            }
        }

        warmTools().then(([ytDlpReady, ffprobeReady, ffmpegReady]) => {
            console.log(`Shared area: ${SHARED_DIR} · chunked streaming: ${ffmpegReady ? `on (${HLS_SEGMENT_SECONDS}s segments)` : "off (ffmpeg missing)"}`);
            if (!ytDlpReady) console.warn("WARNING: yt-dlp not found on PATH - downloads will fail");
            if (!ffprobeReady) console.warn("WARNING: ffprobe not found on PATH - durations unavailable");
        });
    });
}

start().catch((error) => {
    console.error("Initialization failed:", error);
    process.exitCode = 1;
});
