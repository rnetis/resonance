"use strict";

/**
 * API integration tests: spins up server.js against a throwaway music library
 * and exercises the endpoints the PWA depends on.
 *
 * Run with: npm test
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.TEST_PORT) || 3399;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, "..");

let server;
let musicDir;
let hasMediaTools = false;

function ffmpeg(args) {
    const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}

function makeMp3(target, { title, artist, album, cover = false, seconds = 2 }) {
    const base = `${target}.base.mp3`;
    ffmpeg(["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-metadata", `title=${title}`, "-metadata", `artist=${artist}`, "-metadata", `album=${album}`, "-c:a", "libmp3lame", "-b:a", "64k", base]);

    if (!cover) {
        fs.renameSync(base, target);
        return;
    }

    const coverPath = path.join(musicDir, "cover.jpg");
    ffmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x7c5cff:s=96x96", "-frames:v", "1", coverPath]);
    ffmpeg([
        "-y",
        "-i", base,
        "-i", coverPath,
        "-map", "0:a",
        "-map", "1:v",
        "-c:a", "copy",
        "-c:v", "mjpeg",
        "-id3v2_version", "3",
        "-metadata:s:v", "title=Album cover",
        "-metadata:s:v", "comment=Cover (front)",
        target
    ]);
    fs.rmSync(base, { force: true });
}

async function waitForHealth(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${BASE}/api/health`);
            if (response.ok) return await response.json();
        } catch {
            /* not up yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }

    throw new Error("server did not become healthy in time");
}

before(async () => {
    hasMediaTools = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

    if (!hasMediaTools) {
        throw new Error("ffmpeg is required to build the test fixtures");
    }

    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-test-"));

    makeMp3(path.join(musicDir, "Alpha Song.mp3"), { title: "Alpha Song", artist: "Fixture Artist", album: "Fixture Album", cover: true });
    makeMp3(path.join(musicDir, "Beta Song.mp3"), { title: "Beta Song", artist: "Fixture Artist", album: "Fixture Album" });

    fs.mkdirSync(path.join(musicDir, "Nested Folder"), { recursive: true });
    makeMp3(path.join(musicDir, "Nested Folder", "Gamma Song.mp3"), { title: "Gamma Song", artist: "Nested Artist", album: "Nested Album" });

    fs.writeFileSync(path.join(musicDir, "notes.txt"), "not audio");
    fs.writeFileSync(path.join(musicDir, ".hidden.mp3"), "hidden");

    server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", MUSIC_DIR: musicDir },
        stdio: ["ignore", "pipe", "pipe"]
    });

    server.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

    await waitForHealth();
});

after(() => {
    server?.kill("SIGTERM");
    if (musicDir) fs.rmSync(musicDir, { recursive: true, force: true });
});

test("health endpoint reports tooling", async () => {
    const response = await fetch(`${BASE}/api/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.ffprobe, true);
    assert.equal(body.musicDir, musicDir);
});

test("library listing parses tags and hides non-audio files", async () => {
    const response = await fetch(`${BASE}/api/tracks`);
    const body = await response.json();

    assert.equal(response.status, 200);

    const titles = body.tracks.map((track) => track.title).sort();
    assert.deepEqual(titles, ["Alpha Song", "Beta Song"]);

    const alpha = body.tracks.find((track) => track.title === "Alpha Song");
    assert.equal(alpha.artist, "Fixture Artist");
    assert.equal(alpha.album, "Fixture Album");
    assert.equal(alpha.hasCover, true);
    assert.ok(alpha.size > 1000);

    const beta = body.tracks.find((track) => track.title === "Beta Song");
    assert.equal(beta.hasCover, false);

    assert.deepEqual(
        body.folders.map((folder) => folder.name),
        ["Nested Folder"]
    );

    assert.equal(
        body.tracks.some((track) => track.name === "notes.txt" || track.name.startsWith(".")),
        false
    );
});

test("recursive listing walks subfolders", async () => {
    const body = await (await fetch(`${BASE}/api/tracks?recursive=1`)).json();

    const titles = body.tracks.map((track) => track.title).sort();
    assert.deepEqual(titles, ["Alpha Song", "Beta Song", "Gamma Song"]);

    const nested = body.tracks.find((track) => track.title === "Gamma Song");
    assert.equal(nested.path, "Nested Folder/Gamma Song.mp3");
});

test("streaming returns the whole file with range support advertised", async () => {
    const response = await fetch(`${BASE}/api/stream?path=${encodeURIComponent("Alpha Song.mp3")}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.equal(response.headers.get("accept-ranges"), "bytes");

    const buffer = Buffer.from(await response.arrayBuffer());
    assert.ok(buffer.length > 1000);
    assert.equal(buffer[0], 0x49, "starts with an ID3 tag");
});

test("range requests return partial content that matches the file bytes", async () => {
    const full = Buffer.from(await (await fetch(`${BASE}/api/stream?path=${encodeURIComponent("Alpha Song.mp3")}`)).arrayBuffer());

    const response = await fetch(`${BASE}/api/stream?path=${encodeURIComponent("Alpha Song.mp3")}`, {
        headers: { Range: "bytes=100-199" }
    });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-length"), "100");
    assert.equal(response.headers.get("content-range"), `bytes 100-199/${full.length}`);

    const slice = Buffer.from(await response.arrayBuffer());
    assert.equal(slice.length, 100);
    assert.ok(slice.equals(full.subarray(100, 200)));
});

test("suffix ranges return the tail of the file", async () => {
    const full = Buffer.from(await (await fetch(`${BASE}/api/stream?path=${encodeURIComponent("Beta Song.mp3")}`)).arrayBuffer());

    const response = await fetch(`${BASE}/api/stream?path=${encodeURIComponent("Beta Song.mp3")}`, {
        headers: { Range: "bytes=-64" }
    });

    assert.equal(response.status, 206);
    const slice = Buffer.from(await response.arrayBuffer());
    assert.equal(slice.length, 64);
    assert.ok(slice.equals(full.subarray(full.length - 64)));
});

test("unsatisfiable ranges are rejected", async () => {
    const response = await fetch(`${BASE}/api/stream?path=${encodeURIComponent("Beta Song.mp3")}`, {
        headers: { Range: "bytes=99999999-" }
    });

    assert.equal(response.status, 416);
});

test("path traversal is refused", async () => {
    for (const attempt of ["../etc/passwd", "/etc/passwd", "../../root/.bashrc"]) {
        const response = await fetch(`${BASE}/api/stream?path=${encodeURIComponent(attempt)}`);
        assert.ok(response.status === 400 || response.status === 404, `${attempt} -> ${response.status}`);
    }
});

test("cover art is served from ID3 APIC frames and 404s when absent", async () => {
    const withCover = await fetch(`${BASE}/api/cover?path=${encodeURIComponent("Alpha Song.mp3")}`);
    assert.equal(withCover.status, 200);
    assert.equal(withCover.headers.get("content-type"), "image/jpeg");
    const coverBytes = Buffer.from(await withCover.arrayBuffer());
    assert.ok(coverBytes.length > 100);

    const withoutCover = await fetch(`${BASE}/api/cover?path=${encodeURIComponent("Beta Song.mp3")}`);
    assert.equal(withoutCover.status, 404);
});

test("duration endpoint probes audio with ffprobe", async () => {
    const body = await (await fetch(`${BASE}/api/duration?path=${encodeURIComponent("Alpha Song.mp3")}`)).json();

    assert.equal(body.path, "Alpha Song.mp3");
    assert.ok(body.duration > 1 && body.duration < 4, `unexpected duration ${body.duration}`);
});

test("download endpoint rejects non-YouTube URLs", async () => {
    const bad = await fetch(`${BASE}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/watch?v=aaaaaaaaaaa" })
    });
    assert.equal(bad.status, 400);

    const malformed = await fetch(`${BASE}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "not a url" })
    });
    assert.equal(malformed.status, 400);
});

test("job queue is created and cancelable", async () => {
    const response = await fetch(`${BASE}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })
    });

    assert.equal(response.status, 202);
    const job = await response.json();
    assert.ok(job.id);
    assert.equal(job.videoId, "dQw4w9WgXcQ");
    assert.ok(["queued", "downloading"].includes(job.status));

    const listed = await (await fetch(`${BASE}/api/jobs`)).json();
    assert.ok(listed.jobs.some((entry) => entry.id === job.id));

    const canceled = await fetch(`${BASE}/api/jobs/${job.id}`, { method: "DELETE" });
    assert.equal(canceled.status, 200);
    assert.equal((await canceled.json()).status, "canceled");

    const missing = await fetch(`${BASE}/api/jobs/does-not-exist`);
    assert.equal(missing.status, 404);
});

test("deleting a track removes it from disk", async () => {
    const target = path.join(musicDir, "Nested Folder", "Gamma Song.mp3");
    assert.ok(fs.existsSync(target));

    const response = await fetch(`${BASE}/api/track?path=${encodeURIComponent("Nested Folder/Gamma Song.mp3")}`, { method: "DELETE" });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(target), false);
});

test("PWA assets are served (shell, manifest, service worker)", async () => {
    const shell = await fetch(`${BASE}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-type"), /text\/html/);
    assert.match(await shell.text(), /manifest\.webmanifest/);

    const manifest = await fetch(`${BASE}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    const manifestBody = await manifest.json();
    assert.equal(manifestBody.display, "standalone");
    assert.ok(manifestBody.icons.some((icon) => icon.sizes === "512x512"));

    const sw = await fetch(`${BASE}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get("cache-control"), /no-cache/);
    assert.match(await sw.text(), /addEventListener\("fetch"/);

    const icon = await fetch(`${BASE}/icons/icon-192.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
});

test("client-side routes fall back to the app shell", async () => {
    const response = await fetch(`${BASE}/library/some/deep/route`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<div id="app">/);

    const apiMiss = await fetch(`${BASE}/api/nope`);
    assert.equal(apiMiss.status, 404);
});
