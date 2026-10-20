"use strict";

/**
 * Music API + PWA host.
 *
 * Built on the original new.js music API (YouTube search via youtube-search-api,
 * downloads via yt-dlp). Adds:
 *   - static hosting of the PWA in ./public
 *   - a download queue with live progress and cancellation
 *   - a library index built from ID3/M4A tags
 *   - HTTP Range streaming so <audio> can seek
 *   - cover-art extraction (embedded ID3 APIC, ffmpeg fallback)
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
const AUDIO_FORMAT = process.env.AUDIO_FORMAT || "mp3";
const AUDIO_QUALITY = process.env.AUDIO_QUALITY || "0";
const MAX_CONCURRENT_DOWNLOADS = Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 2;
const MAX_QUEUED_DOWNLOADS = Number(process.env.MAX_QUEUED_DOWNLOADS) || 25;
const MAX_JOB_HISTORY = 100;

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
let activeDownloads = 0;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

/* ------------------------------------------------------------------ helpers */

async function initialize() {
    await fsp.mkdir(MUSIC_DIR, { recursive: true });
    await fsp.mkdir(COVER_DIR, { recursive: true });
}

/** Resolve a client-supplied relative path inside MUSIC_DIR. */
function resolveMusicPath(input = "") {
    if (typeof input !== "string" || path.isAbsolute(input)) {
        throw new Error("Invalid relative path");
    }

    const root = MUSIC_DIR;
    const target = path.resolve(root, input);

    if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error("Path outside music directory");
    }

    return target;
}

function toRelative(absolute) {
    const rel = path.relative(MUSIC_DIR, absolute);
    return rel.split(path.sep).join("/");
}

function isAudioFile(name) {
    return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Hidden entries (.cache, partial downloads, thumbnails) never show up. */
function isHidden(name) {
    return name.startsWith(".") || name.endsWith(".part") || name.endsWith(".ytdl") || name.endsWith(".jpg") || name.endsWith(".webp") || name.endsWith(".png");
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

function ffprobeAvailable() {
    return spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
}

function ytDlpAvailable() {
    return spawnSync("yt-dlp", ["--version"], { stdio: "ignore" }).status === 0;
}

/* ------------------------------------------------------------ download jobs */

function publicJob(job) {
    return {
        id: job.id,
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

function enqueueJob(url, { autoPlay = false } = {}) {
    const job = {
        id: randomUUID(),
        url,
        videoId: youtubeIdFromUrl(url),
        status: "queued",
        phase: "Waiting in queue",
        progress: { percent: 0, downloadedBytes: 0, totalBytes: null, speed: null, eta: null },
        title: null,
        channel: null,
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
        MUSIC_DIR,
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
                job.file = toRelative(path.resolve(filePath));
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
                job.file = findDownloadedFile(job);
            }

            // Pull the embedded tags so clients can build rich track objects.
            if (job.file) {
                try {
                    const tags = await tagsFor(resolveMusicPath(job.file));
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
        const data = await youtubesearchapi.GetVideoDetails(job.videoId);
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

function findDownloadedFile(job) {
    // Fallback: newest audio file that mentions the video id in its name.
    try {
        const entries = fs.readdirSync(MUSIC_DIR, { withFileTypes: true });
        const candidates = entries
            .filter((entry) => entry.isFile() && !isHidden(entry.name) && entry.name.includes(job.videoId))
            .map((entry) => {
                const full = path.join(MUSIC_DIR, entry.name);
                return { full, mtime: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime);

        return candidates.length ? toRelative(candidates[0].full) : null;
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

async function describeTrack(relativePath) {
    const absolute = resolveMusicPath(relativePath);
    const { tags, size, mtime } = await tagsFor(absolute);
    const fallback = prettifyFilename(relativePath);

    const duration = tags.duration ?? durationCache.get(`${relativePath}:${size}:${mtime}`) ?? null;

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
        url: `/api/stream?path=${encodeURIComponent(relativePath)}`,
        cover: `/api/cover?path=${encodeURIComponent(relativePath)}`
    };
}

/* ---------------------------------------------------------------- routes */

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        musicDir: MUSIC_DIR,
        format: AUDIO_FORMAT,
        ytDlp: ytDlpAvailable(),
        ffprobe: ffprobeAvailable(),
        activeDownloads,
        queued: downloadQueue.length
    });
});

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

    if (!validateYouTubeUrl(url)) {
        return res.status(400).json({ error: "Invalid YouTube video URL" });
    }

    if (!ytDlpAvailable()) {
        return res.status(503).json({ error: "yt-dlp is not installed on the server" });
    }

    if (downloadQueue.length >= MAX_QUEUED_DOWNLOADS) {
        return res.status(429).json({ error: "Download queue is full" });
    }

    const job = enqueueJob(url, { autoPlay: Boolean(autoPlay) });

    res.status(202).json(publicJob(job));
});

// GET /api/jobs
app.get("/api/jobs", (req, res) => {
    const list = [...jobs.values()]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(publicJob);

    res.json({ jobs: list, active: activeDownloads, queued: downloadQueue.length });
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

// GET /api/tracks?path=&recursive=1
app.get("/api/tracks", async (req, res) => {
    try {
        const relativePath = typeof req.query.path === "string" ? req.query.path.replace(/^\/+|\/+$/g, "") : "";
        const recursive = req.query.recursive === "1" || req.query.recursive === "true";

        const dir = resolveMusicPath(relativePath);
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

        const walk = async (currentDir, currentRelative, depth) => {
            const entries = await fsp.readdir(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                if (isHidden(entry.name)) continue;

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
                    tracks.push(await describeTrack(entryRelative));
                }
            }
        };

        await walk(dir, relativePath, 0);

        tracks.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
        folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        res.json({
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

// GET /api/duration?path=...  (ffprobe, cached)
app.get("/api/duration", async (req, res) => {
    try {
        const relativePath = String(req.query.path || "");
        const absolute = resolveMusicPath(relativePath);
        const stat = await fsp.stat(absolute);
        const key = `${relativePath}:${stat.size}:${stat.mtimeMs}`;

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

// GET /api/stream?path=...   (Range aware)
app.get("/api/stream", async (req, res) => {
    try {
        const relativePath = String(req.query.path || "");
        const absolute = resolveMusicPath(relativePath);

        if (!isAudioFile(absolute)) {
            return res.status(400).json({ error: "Not an audio file" });
        }

        const stat = await fsp.stat(absolute);
        if (!stat.isFile()) return res.status(400).json({ error: "Not a file" });

        const contentType = AUDIO_MIME[path.extname(absolute).toLowerCase()] || "application/octet-stream";
        const etag = `"${createHash("sha1").update(`${relativePath}:${stat.size}:${stat.mtimeMs}`).digest("hex")}"`;

        const headers = {
            "Content-Type": contentType,
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=3600",
            ETag: etag,
            "Last-Modified": stat.mtime.toUTCString()
        };

        if (req.query.download === "1") {
            headers["Content-Disposition"] = `attachment; filename="${encodeURIComponent(path.basename(absolute))}"`;
        }

        if (req.headers["if-none-match"] === etag) {
            return res.status(304).end();
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
    } catch (error) {
        res.status(error.code === "ENOENT" ? 404 : 400).json({ error: error.message || "Stream failed" });
    }
});

// GET /api/cover?path=...  (embedded art first, ffmpeg extraction as fallback)
app.get("/api/cover", async (req, res) => {
    try {
        const relativePath = String(req.query.path || "");
        const absolute = resolveMusicPath(relativePath);
        const stat = await fsp.stat(absolute);

        if (req.headers["if-none-match"] === coverEtag(relativePath, stat)) {
            return res.status(304).end();
        }

        res.set({
            "Cache-Control": "public, max-age=604800",
            ETag: coverEtag(relativePath, stat)
        });

        const { tags } = await tagsFor(absolute);
        const embedded = tags.picture;

        if (embedded) {
            res.set("Content-Type", embedded.mime);
            return res.end(embedded.data);
        }

        const extracted = await extractCoverWithFfmpeg(absolute, relativePath, stat);

        if (!extracted) {
            return res.status(404).json({ error: "No embedded cover art" });
        }

        res.set("Content-Type", "image/jpeg");
        return res.sendFile(extracted);
    } catch (error) {
        res.status(error.code === "ENOENT" ? 404 : 400).json({ error: error.message });
    }
});

function coverEtag(relativePath, stat) {
    return `"c${createHash("sha1").update(`${relativePath}:${stat.size}:${stat.mtimeMs}`).digest("hex")}"`;
}

async function extractCoverWithFfmpeg(absolute, relativePath, stat) {
    const cacheName = `${createHash("sha1").update(`${relativePath}:${stat.size}:${stat.mtimeMs}`).digest("hex")}.jpg`;
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

// DELETE /api/track?path=...
app.delete("/api/track", async (req, res) => {
    try {
        const relativePath = String(req.query.path || "");
        const absolute = resolveMusicPath(relativePath);

        if (!isAudioFile(absolute)) {
            return res.status(400).json({ error: "Not an audio file" });
        }

        await fsp.unlink(absolute);
        tagCache.clear();
        res.json({ removed: true, path: relativePath });
    } catch (error) {
        res.status(error.code === "ENOENT" ? 404 : 400).json({ error: error.message });
    }
});

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
        console.log(`Music PWA listening on ${scheme}://${HOST}:${PORT}`);
        console.log(`Library directory: ${MUSIC_DIR}`);

        for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
            for (const address of addresses || []) {
                if (address.family === "IPv4" && !address.internal) {
                    console.log(`  LAN: ${scheme}://${address.address}:${PORT}  (${name})`);
                }
            }
        }

        if (!ytDlpAvailable()) console.warn("WARNING: yt-dlp not found on PATH - downloads will fail");
        if (!ffprobeAvailable()) console.warn("WARNING: ffprobe not found on PATH - durations unavailable");
    });
}

start().catch((error) => {
    console.error("Initialization failed:", error);
    process.exitCode = 1;
});
