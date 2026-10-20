const express = require("express");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const youtubesearchapi = require("youtube-search-api");

const app = express();
const port = Number(process.env.PORT) || 3000;

const MUSIC_DIR = "/root/music";
const MAX_JOBS = 10;
const jobs = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// Ensure the music directory exists.
async function initialize() {
    await fs.mkdir(MUSIC_DIR, { recursive: true });
}

// Restrict file access to MUSIC_DIR.
function resolveMusicPath(input = "") {
    if (typeof input !== "string" || path.isAbsolute(input)) {
        throw new Error("Invalid relative path");
    }

    const root = path.resolve(MUSIC_DIR);
    const target = path.resolve(root, input);

    if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error("Path outside music directory");
    }

    return target;
}

// Accept only YouTube video URLs.
function validateYouTubeUrl(value) {
    if (typeof value !== "string" || value.length > 2048) {
        return false;
    }

    try {
        const url = new URL(value);

        if (url.protocol !== "https:" && url.protocol !== "http:") {
            return false;
        }

        const host = url.hostname.toLowerCase();

        if (
            !["youtube.com", "www.youtube.com", "m.youtube.com",
              "music.youtube.com", "youtu.be", "www.youtu.be"].includes(host)
        ) {
            return false;
        }

        const id = host.endsWith("youtu.be")
            ? url.pathname.slice(1)
            : url.searchParams.get("v");

        return typeof id === "string" && /^[a-zA-Z0-9_-]{11}$/.test(id);
    } catch {
        return false;
    }
}

// GET /?q=search+term
app.get("/", async (req, res) => {
    const query = typeof req.query.q === "string"
        ? req.query.q.trim()
        : "harki be ma resid 2 tataloo";

    if (!query || query.length > 200) {
        return res.status(400).json({ error: "Invalid search query" });
    }

    try {
        const data = await youtubesearchapi.GetListByKeyword(query);

        const items = (data.items || [])
            .filter(item => item.id && item.title)
            .map(item => ({
                name: item.title,
                url: `https://www.youtube.com/watch?v=${item.id}`,
                thumbnail: item.thumbnail?.thumbnails?.[0]?.url ?? null
            }));

        res.json(items);
    } catch (error) {
        console.error("YouTube search failed:", error.message);
        res.status(502).json({ error: "YouTube search failed" });
    }
});

// POST /  { "url": "https://www.youtube.com/watch?v=..." }
// Returns a job ID so clients can poll for completion.
app.post("/", async (req, res) => {
    const { url } = req.body || {};

    if (!validateYouTubeUrl(url)) {
        return res.status(400).json({ error: "Invalid YouTube video URL" });
    }

    const activeJobs = [...jobs.values()].filter(
        job => job.status === "running"
    ).length;

    if (activeJobs >= MAX_JOBS) {
        return res.status(429).json({
            error: "Too many downloads in progress"
        });
    }

    const id = randomUUID();

    const job = {
        id,
        status: "running",
        url,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null
    };

    jobs.set(id, job);

    // spawn() executes the program without shell interpolation.
    const child = spawn("yt-dlp", [
        "--no-playlist",
        "--no-simulate",
        "--no-progress",
        "-x",
        "--audio-format", "mp3",
        "-P", MUSIC_DIR,
        "-o", "%(title)s.%(ext)s",
        url
    ], {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";

    child.stderr.on("data", chunk => {
        stderr = (stderr + chunk.toString()).slice(-4000);
    });

    child.on("error", error => {
        job.status = "failed";
        job.error = error.message;
        job.finishedAt = new Date().toISOString();
    });

    child.on("close", code => {
        // The error event may already have updated the job.
        if (job.status !== "running") return;

        job.status = code === 0 ? "completed" : "failed";
        job.error = code === 0 ? null : (stderr.trim() || `Exit code ${code}`);
        job.finishedAt = new Date().toISOString();
    });

    res.status(202).json({
        id,
        status: job.status,
        statusUrl: `/downloads/${id}`
    });
});

// GET /downloads/:id
app.get("/downloads/:id", (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job) {
        return res.status(404).json({ error: "Download job not found" });
    }

    res.json(job);
});

// GET /files?path=Albums
// Paths are relative to MUSIC_DIR.
app.get("/files", async (req, res) => {
    try {
        const relativePath = req.query.path ?? "";

        if (typeof relativePath !== "string") {
            return res.status(400).json({ error: "Invalid path" });
        }

        const dir = resolveMusicPath(relativePath);
        const stat = await fs.stat(dir);

        if (!stat.isDirectory()) {
            return res.status(400).json({ error: "Not a directory" });
        }

        const entries = await fs.readdir(dir, {
            withFileTypes: true
        });

        const files = await Promise.all(
            entries.map(async entry => {
                const fullPath = path.join(dir, entry.name);
                let size = null;

                if (entry.isFile()) {
                    try {
                        size = (await fs.stat(fullPath)).size;
                    } catch {}
                }

                return {
                    name: entry.name,
                    type: entry.isDirectory() ? "directory" : "file",
                    size,
                    path: path.posix.join(relativePath, entry.name)
                };
            })
        );

        res.json({
            path: relativePath,
            files
        });
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") {
            return res.status(404).json({ error: "Directory not found" });
        }

        if (error.code === "EACCES") {
            return res.status(403).json({ error: "Permission denied" });
        }

        res.status(400).json({ error: error.message });
    }
});

// Start only after the music directory is ready.
initialize()
    .then(() => {
        app.listen(port, "127.0.0.1", () => {
            console.log(`Music API listening on http://127.0.0.1:${port}`);
        });
    })
    .catch(error => {
        console.error("Initialization failed:", error);
        process.exitCode = 1;
    });
