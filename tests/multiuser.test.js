"use strict";

/**
 * Multi-user / sharing / chunked-streaming tests.
 *
 * Spins up server.js against a throwaway library and exercises:
 *   - per-user libraries (isolated folders, shared area kept separate)
 *   - sharing a track with another person (stream, cover, import, revoke)
 *   - chunked (HLS) streaming: playlist + segment fetch
 *
 * Run with: npm test
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.TEST_PORT_USERS) || 3400;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, "..");
const OWNER = "owner";

let server;
let musicDir;
let shareId;
let hlsKey;
let hlsSegment;

function ffmpeg(args) {
    const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}

function makeMp3(target, { title, artist = "Fixture Artist", album = "Fixture Album", seconds = 2 }) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    ffmpeg([
        "-y",
        "-f", "lavfi",
        "-i", `sine=frequency=440:duration=${seconds}`,
        "-metadata", `title=${title}`,
        "-metadata", `artist=${artist}`,
        "-metadata", `album=${album}`,
        "-c:a", "libmp3lame",
        "-b:a", "64k",
        target
    ]);
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

function as(user, extra = {}) {
    return { "x-resonance-user": user, ...extra };
}

async function api(pathname, { user, ...options } = {}) {
    const response = await fetch(`${BASE}${pathname}`, {
        ...options,
        headers: { ...(user ? as(user) : {}), ...(options.headers || {}) }
    });

    const type = response.headers.get("content-type") || "";
    const body = type.includes("application/json") ? await response.json() : await response.arrayBuffer();

    return { response, body };
}

before(async () => {
    if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
        throw new Error("ffmpeg is required to build the test fixtures");
    }

    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-users-"));

    // The owner keeps the pre-existing root library.
    makeMp3(path.join(musicDir, "Alpha Song.mp3"), { title: "Alpha Song" });
    makeMp3(path.join(musicDir, "Beta Song.mp3"), { title: "Beta Song" });

    // A folder that exists before the server starts proves nothing leaks out.
    makeMp3(path.join(musicDir, "users", "bob", "Bobs Own Tune.mp3"), { title: "Bobs Own Tune" });

    // The shared area is readable by everyone.
    makeMp3(path.join(musicDir, "shared", "House Anthem.mp3"), { title: "House Anthem" });

    server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", MUSIC_DIR: musicDir, DEFAULT_USER: OWNER, HLS_SEGMENT_SECONDS: "1" },
        stdio: ["ignore", "pipe", "pipe"]
    });

    server.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

    await waitForHealth();
});

after(() => {
    server?.kill("SIGTERM");
    if (musicDir) fs.rmSync(musicDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------- users */

test("health reports the multi-user and chunked-streaming capabilities", async () => {
    const { response, body } = await api("/api/health");

    assert.equal(response.status, 200);
    assert.equal(body.defaultUser, OWNER);
    assert.equal(body.chunked, true, "ffmpeg is present so chunked streaming is available");
    assert.equal(typeof body.users, "number");
    assert.ok(body.segmentSeconds >= 1);
});

test("the user list includes the owner, who owns the pre-existing library", async () => {
    const { response, body } = await api("/api/users");

    assert.equal(response.status, 200);

    const owner = body.users.find((entry) => entry.name === OWNER);
    assert.ok(owner, "owner should be listed");
    assert.equal(owner.isDefault, true);
    assert.equal(owner.tracks, 2, "the two root tracks belong to the owner");
});

test("new people can claim a username and get their own library", async () => {
    const created = await api("/api/users", { method: "POST", body: JSON.stringify({ name: "Carol" }), headers: { "content-type": "application/json" } });

    assert.equal(created.response.status, 201);
    assert.equal(created.body.name, "carol", "usernames are normalised to lowercase");
    assert.ok(fs.existsSync(path.join(musicDir, "users", "carol")));

    const bad = await api("/api/users", { method: "POST", body: JSON.stringify({ name: "../../etc/passwd" }), headers: { "content-type": "application/json" } });
    assert.equal(bad.response.status, 400, "path-ish usernames are rejected");
});

test("every user sees exactly their own library", async () => {
    const owner = await api("/api/tracks", { user: OWNER });
    assert.deepEqual(owner.body.tracks.map((track) => track.title).sort(), ["Alpha Song", "Beta Song"]);

    const bob = await api("/api/tracks", { user: "bob" });
    assert.deepEqual(bob.body.tracks.map((track) => track.title), ["Bobs Own Tune"]);
    assert.equal(bob.body.user, "bob");

    const carol = await api("/api/tracks", { user: "carol" });
    assert.deepEqual(carol.body.tracks, [], "a new person starts empty");

    // `users/` and `shared/` are structure, not music.
    assert.equal(owner.body.folders.some((folder) => ["users", "shared"].includes(folder.name)), false);
});

test("the shared area is readable by everyone and not part of anyone's library", async () => {
    const shared = await api("/api/tracks?scope=shared", { user: "carol" });

    assert.equal(shared.response.status, 200);
    assert.deepEqual(shared.body.tracks.map((track) => track.title), ["House Anthem"]);
    assert.equal(shared.body.scope, "shared");
    assert.equal(shared.body.writable, false, "the shared area is read-only through the library API");

    const stream = await api(`/api/stream?path=${encodeURIComponent("House Anthem.mp3")}&scope=shared`, { user: "carol" });
    assert.equal(stream.response.status, 200);
    assert.ok(stream.body.byteLength > 0);

    const carol = await api("/api/tracks", { user: "carol" });
    assert.deepEqual(carol.body.tracks, [], "the shared area never shows up in a personal library");
});

test("downloads land in the requesting person's library", async () => {
    const created = await api("/api/download", {
        user: "carol",
        method: "POST",
        body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
        headers: { "content-type": "application/json" }
    });

    assert.equal(created.response.status, 202);
    assert.equal(created.body.user, "carol");

    const mine = await api("/api/jobs", { user: "carol" });
    assert.equal(mine.body.jobs.length, 1, "carol sees her own queue");

    const other = await api("/api/jobs", { user: "bob" });
    assert.equal(other.body.jobs.length, 0, "someone else's queue stays private");

    await api(`/api/jobs/${created.body.id}`, { method: "DELETE" });
});

/* ----------------------------------------------------------------- sharing */

test("a track can be shared with another person", async () => {
    const shared = await api("/api/share", {
        user: OWNER,
        method: "POST",
        body: JSON.stringify({ trackPath: "Alpha Song.mp3", to: "bob", note: "give this a listen" }),
        headers: { "content-type": "application/json" }
    });

    assert.equal(shared.response.status, 201);
    assert.equal(shared.body.from, OWNER);
    assert.equal(shared.body.to, "bob");
    assert.equal(shared.body.title, "Alpha Song");
    assert.equal(shared.body.available, true);

    shareId = shared.body.id;

    const missing = await api("/api/share", {
        user: OWNER,
        method: "POST",
        body: JSON.stringify({ trackPath: "Alpha Song.mp3", to: "nobody" }),
        headers: { "content-type": "application/json" }
    });
    assert.equal(missing.response.status, 404, "you cannot share with someone who does not exist");
});

test("the recipient sees it as incoming, the sender as outgoing", async () => {
    const bob = await api("/api/shares", { user: "bob" });
    assert.equal(bob.body.incoming.length, 1);
    assert.equal(bob.body.incoming[0].title, "Alpha Song");
    assert.equal(bob.body.incoming[0].from, OWNER);
    assert.equal(bob.body.outgoing.length, 0);

    const owner = await api("/api/shares", { user: OWNER });
    assert.equal(owner.body.outgoing.length, 1);
    assert.equal(owner.body.outgoing[0].to, "bob");

    const carol = await api("/api/shares", { user: "carol" });
    assert.equal(carol.body.incoming.length, 0, "shares are not broadcast");
});

test("the recipient can play and download a shared track", async () => {
    const stream = await api(`/api/stream?share=${shareId}`, { user: "bob" });
    assert.equal(stream.response.status, 200);
    assert.ok(stream.body.byteLength > 0);

    const cover = await api(`/api/cover?share=${shareId}`, { user: "bob" });
    assert.equal(cover.response.status, 404, "this fixture has no cover art");

    const forbidden = await api(`/api/stream?share=${shareId}`, { user: "carol" });
    assert.equal(forbidden.response.status, 403, "only the people involved can play a share");
});

test("the recipient can import a shared track into their own library", async () => {
    const imported = await api(`/api/shares/${shareId}/import`, { user: "bob", method: "POST" });

    assert.equal(imported.response.status, 201);
    assert.equal(imported.body.track.title, "Alpha Song");

    const bob = await api("/api/tracks", { user: "bob" });
    assert.deepEqual(bob.body.tracks.map((track) => track.title).sort(), ["Alpha Song", "Bobs Own Tune"]);
    assert.equal(imported.body.path, "Alpha Song.mp3", "a free name is kept as-is");

    // Importing the same thing twice must not clobber the first copy.
    const again = await api(`/api/shares/${shareId}/import`, { user: "bob", method: "POST" });
    assert.equal(again.response.status, 201);
    assert.ok(again.body.path.includes(`from ${OWNER}`), `the second copy is renamed: ${again.body.path}`);

    // The owner's copy is untouched.
    const owner = await api("/api/tracks", { user: OWNER });
    assert.equal(owner.body.tracks.length, 2);
    assert.equal(fs.existsSync(path.join(musicDir, "Alpha Song.mp3")), true);
});

test("a share can be revoked by either side", async () => {
    const revoked = await api(`/api/shares/${shareId}`, { user: "bob", method: "DELETE" });
    assert.equal(revoked.response.status, 200);

    const bob = await api("/api/shares", { user: "bob" });
    assert.equal(bob.body.incoming.length, 0);
});

/* --------------------------------------------------- chunked (HLS) stream */

test("chunked streaming exposes a playlist of small segments", async () => {
    const { response, body } = await api(`/api/playlist?path=${encodeURIComponent("Alpha Song.mp3")}`, { user: OWNER });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /mpegurl/);

    const playlist = Buffer.from(body).toString("utf8");

    assert.match(playlist, /^#EXTM3U/);
    assert.match(playlist, /#EXTINF:/);
    assert.match(playlist, /\/api\/chunk\?key=[0-9a-f]{40}&name=seg\d+\.ts/);

    const match = /\/api\/chunk\?key=([0-9a-f]{40})&name=(seg\d+\.ts)/.exec(playlist);
    assert.ok(match, "the playlist points at the chunk endpoint");

    hlsKey = match[1];
    hlsSegment = match[2];
});

test("segments are fetchable and range-addressable", async () => {
    const { response, body } = await api(`/api/chunk?key=${hlsKey}&name=${hlsSegment}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "video/mp2t");
    assert.ok(body.byteLength > 0, "the segment carries audio bytes");

    const ranged = await fetch(`${BASE}/api/chunk?key=${hlsKey}&name=${hlsSegment}`, { headers: { Range: "bytes=0-99" } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);

    const bad = await api("/api/chunk?key=../../etc&name=passwd");
    assert.equal(bad.response.status, 400, "chunk references cannot escape the cache");
});

test("a shared track can be streamed as chunks too", async () => {
    const shared = await api("/api/share", {
        user: OWNER,
        method: "POST",
        body: JSON.stringify({ trackPath: "Beta Song.mp3", to: "*" }),
        headers: { "content-type": "application/json" }
    });

    assert.equal(shared.response.status, 201);

    const { response, body } = await api(`/api/playlist?share=${shared.body.id}`, { user: "carol" });

    assert.equal(response.status, 200);
    assert.match(Buffer.from(body).toString("utf8"), /\/api\/chunk\?key=/);

    const everyone = await api("/api/shares", { user: "carol" });
    assert.equal(everyone.body.incoming.length, 1, "a broadcast share reaches every user");
});
