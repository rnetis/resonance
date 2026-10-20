// Resonance — PWA music player UI. Talks to the local Express API in server.js
// (YouTube search + yt-dlp downloads + a tagged local library) and delegates
// playback to player.js.

import { player, streamUrlFor } from "./player.js";
import * as offline from "./offline.js";
import {
  $,
  icon,
  el,
  fmtTime,
  fmtBytes,
  fmtSpeed,
  fmtEta,
  fmtDate,
  setCover,
  placeholderCover,
  toast,
  openMenu,
  closeMenu,
  promptDialog,
  confirmDialog,
  emptyState,
  pool
} from "./util.js";
import {
  currentUser,
  setCurrentUser,
  identityHeaders,
  withUser,
  apiFetch,
  listShares,
  revokeShare,
  importShare,
  chooseUser,
  chooseFrom,
  shareTrackDialog
} from "./social.js";

const LS = {
  recursive: "resonance.recursive",
  playlists: "resonance.playlists.v1",
  lastTab: "resonance.tab",
  iosHint: "resonance.iosHint"
};

// The iOS/Android shell injects window.__resonanceNative before page scripts run.
const NATIVE = Boolean(window.__resonanceNative);

const SEARCH_SUGGESTIONS = [
  "lofi hip hop",
  "coldplay",
  "pink floyd",
  "irani song",
  "jazz cafe",
  "synthwave"
];

const state = {
  tab: "search",
  libPath: "",
  recursive: localStorage.getItem(LS.recursive) === "1",
  filter: "",
  searchResults: [],
  library: { folders: [], tracks: [] },
  jobs: new Map(),
  jobNodes: new Map(),
  autoPlayed: new Set(),
  queueAfterVideo: new Set(),
  playlists: [],
  offlineTracks: [],
  installPrompt: null,
  serverOnline: null,
  scope: "library",       // library | shared (the read-only area everyone sees)
  shareScope: "incoming", // incoming | outgoing
  shares: { incoming: [], outgoing: [] }
};

const dom = {};

/* --------------------------------------------------------------- utilities */

function cache(key, value) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function readCache(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function prettyName(path) {
  const base = String(path).split("/").pop() || "";
  return base
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/\s*\[[a-zA-Z0-9_-]{11}\]$/, "")
    .trim();
}

function jobStatusLabel(job) {
  const speed = fmtSpeed(job.progress?.speed);
  const eta = fmtEta(job.progress?.eta);

  switch (job.status) {
    case "queued":
      return "Waiting in queue";
    case "downloading": {
      if ((job.progress?.percent || 0) >= 100) return job.phase || "Converting audio";
      const parts = [`Downloading ${job.progress?.percent ? `${job.progress.percent.toFixed(1)}%` : ""}`.trim()];
      if (speed) parts.push(speed);
      if (eta) parts.push(eta);
      return parts.join(" · ");
    }
    case "processing":
      return job.phase || "Converting audio";
    case "completed":
      return job.file ? `Saved · ${prettyName(job.file)}` : "Saved";
    case "failed":
      return job.error || "Download failed";
    case "canceled":
      return "Canceled";
    default:
      return job.phase || job.status;
  }
}

function isJobActive(job) {
  return job.status === "queued" || job.status === "downloading" || job.status === "processing";
}

/** Library API row -> player track. */
function toPlayerTrack(row) {
  return {
    id: `local:${row.scope === "shared" ? "shared:" : ""}${row.path}`,
    source: "local",
    path: row.path,
    scope: row.scope || "library",
    title: row.title || prettyName(row.path),
    artist: row.artist || row.album || null,
    album: row.album || null,
    duration: row.duration ?? null,
    // The server hands back URLs that already carry the right ?user= / ?scope=,
    // which matters because <audio> and <img> cannot send headers.
    url: row.url || null,
    hls: row.hls || null,
    cover: row.hasCover ? row.cover : null,
    size: row.size ?? null
  };
}

function trackFromJob(job) {
  if (!job.file) return null;

  return {
    id: `local:${job.file}`,
    source: "local",
    path: job.file,
    title: job.title || prettyName(job.file),
    artist: job.artist || job.channel || null,
    album: job.album || null,
    duration: job.duration ?? null,
    url: withUser(`/api/stream?path=${encodeURIComponent(job.file)}`),
    cover: job.hasCover ? withUser(`/api/cover?path=${encodeURIComponent(job.file)}`) : null,
    size: null
  };
}

function jobForVideo(videoId) {
  const matches = [...state.jobs.values()].filter((job) => job.videoId === videoId);
  if (!matches.length) return null;
  matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return matches[0];
}

function settled(value) {
  return value !== undefined && value !== null && value !== "";
}

/** True for assets served by a third party (YouTube thumbnails). */
function isRemoteAsset(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) && !url.startsWith(location.origin);
}

function trackSubtitle(track) {
  const bits = [track.artist, track.album].filter(settled);
  return bits.length ? bits.join(" · ") : "Unknown artist";
}

// Every API call carries the current identity (see social.js).
const api = (path, options) => apiFetch(path, options);

function setStatus(node, message, { error = false, spinning = false } = {}) {
  if (!message) {
    node.hidden = true;
    node.textContent = "";
    node.className = "status";
    return;
  }

  node.hidden = false;
  node.textContent = message;
  node.className = `status${error ? " error" : ""}${spinning ? " spin" : ""}`;
}

/* ------------------------------------------------------------------- rows */

function buildTrackRow(track, { subtitle, meta, onActivate, menu, cover, current = false } = {}) {
  const fragment = document.getElementById("trackTemplate").content.cloneNode(true);
  const li = fragment.querySelector(".track-row");
  const main = fragment.querySelector(".row-main");
  const img = fragment.querySelector("img");
  const titleNode = fragment.querySelector(".row-title");
  const subNode = fragment.querySelector(".row-sub");
  const metaNode = fragment.querySelector(".row-meta");
  const action = fragment.querySelector(".row-action");

  li.dataset.trackId = track.id || "";
  li.classList.toggle("current", current);

  titleNode.textContent = track.title || "Unknown";
  const sub = subtitle ?? trackSubtitle(track);
  subNode.textContent = sub || "";
  subNode.hidden = !sub;
  metaNode.textContent = meta || (track.duration ? fmtTime(track.duration) : "");

  const coverUrl = cover === undefined ? track.cover || track.thumbnail || placeholderCover(track.title) : cover;

  // Local cover art is cheap and must appear immediately; remote thumbnails
  // (YouTube search results) are deferred so long lists stay light.
  img.loading = isRemoteAsset(coverUrl) ? "lazy" : "eager";
  setCover(img, coverUrl || placeholderCover(track.title), track.title);

  main.addEventListener("click", () => onActivate?.());

  action.innerHTML = icon("more");
  action.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(action, menu ? menu() : [], { title: track.title });
  });

  return { li, metaNode, subNode, titleNode, action, bars: fragment.querySelector(".playing-bars") };
}

function buildFolderRow(folder) {
  const fragment = document.getElementById("folderTemplate").content.cloneNode(true);
  const li = fragment.querySelector(".folder-row");
  const main = fragment.querySelector(".row-main");
  fragment.querySelector(".row-title").textContent = folder.name;
  main.addEventListener("click", () => loadLibrary(folder.path));
  return li;
}

/* --------------------------------------------------------------- player UI */

function bindPlayer() {
  player.addEventListener("track", () => {
    syncSheet();
    syncMini();
    syncRows();
  });

  player.addEventListener("queue", () => {
    renderQueue();
  });

  player.addEventListener("play", () => {
    syncTransportButtons();
    syncRows();
  });

  player.addEventListener("pause", () => {
    syncTransportButtons();
    syncRows();
  });

  player.addEventListener("time", ({ detail }) => {
    if (!dom.seeking) {
      const duration = detail.duration || 0;
      const percent = duration ? (detail.position / duration) * 1000 : 0;
      dom.seekBar.value = String(Math.max(0, Math.min(1000, percent)));
      setRangeFill(dom.seekBar);
      dom.seekCurrent.textContent = fmtTime(detail.position);
    }
    dom.seekTotal.textContent = detail.duration ? fmtTime(detail.duration) : "--:--";

    const duration = detail.duration || 0;
    const percent = duration ? (detail.position / duration) * 100 : 0;
    dom.miniProgressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  });

  player.addEventListener("error", ({ detail }) => {
    toast(detail.message || "Playback error");
  });

  player.addEventListener("srcstate", ({ detail }) => {
    if (detail.offline) syncSheet();
  });

  player.addEventListener("mode", syncTransportButtons);
  player.addEventListener("volume", ({ detail }) => {
    dom.volumeBar.value = String(Math.round(detail.volume * 100));
    setRangeFill(dom.volumeBar);
  });
}

function setRangeFill(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value || 0);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--fill", `${percent}%`);
}

function syncTransportButtons() {
  const playing = player.isPlaying;
  dom.playBtn.innerHTML = icon(playing ? "pause" : "play");
  dom.miniPlay.innerHTML = icon(playing ? "pause" : "play");
  dom.shuffleBtn.classList.toggle("active", player.shuffle);
  dom.repeatBtn.classList.toggle("active", player.repeat !== "off");
  dom.repeatBtn.innerHTML = icon(player.repeat === "one" ? "repeat-one" : "repeat");
  dom.volumeBar.value = String(Math.round(player.volume * 100));
  setRangeFill(dom.volumeBar);
}

function syncMini() {
  const track = player.current;

  if (!track) {
    dom.mini.hidden = true;
    document.body.classList.remove("has-mini");
    return;
  }

  dom.mini.hidden = false;
  document.body.classList.add("has-mini");
  dom.miniTitle.textContent = track.title || "Unknown";
  dom.miniArtist.textContent = trackSubtitle(track);
  setCover(dom.miniCover, track.cover || track.thumbnail || placeholderCover(track.title), track.title);
  dom.miniCoverWrap.classList.toggle("offline", player.usingOfflineCopy);
  syncTransportButtons();
}

function syncSheet() {
  const track = player.current;
  const panel = dom.sheetPanel;

  if (!track) {
    dom.sheet.hidden = true;
    return;
  }

  dom.sheetTitle.textContent = track.title || "Unknown";
  dom.sheetArtist.textContent = trackSubtitle(track);

  const source = [];
  if (player.usingOfflineCopy) source.push("Offline copy");
  else if (track.source === "local") source.push("Local library");
  else source.push("Streaming");
  if (track.path) source.push(track.path);
  dom.sheetSource.textContent = source.join(" · ");

  const cover = track.cover || track.thumbnail || placeholderCover(track.title);
  setCover(dom.sheetCover, cover, track.title);

  const art = track.cover || track.thumbnail;
  panel.style.backgroundImage = art
    ? `linear-gradient(180deg, rgba(24,24,34,0.88), rgba(10,10,16,0.97)), url("${art}")`
    : "";

  dom.seekTotal.textContent = player.duration ? fmtTime(player.duration) : "--:--";
  syncOfflineButton();
  syncTransportButtons();
}

function syncOfflineButton() {
  const track = player.current;
  if (!track) return;

  if (track.source !== "local") {
    dom.offlineToggleBtn.disabled = true;
    dom.offlineToggleLabel.textContent = "Download first";
    dom.offlineToggleBtn.classList.remove("active");
    return;
  }

  const url = streamUrlFor(track);
  const saved = offline.has(url);
  const supported = offline.supported();

  dom.offlineToggleBtn.disabled = !supported;
  dom.offlineToggleBtn.classList.toggle("active", saved);
  dom.offlineToggleLabel.textContent = !supported ? "Offline needs HTTPS" : saved ? "Saved offline" : "Save offline";
}

function syncRows() {
  const currentId = player.current?.id || null;
  const playing = player.isPlaying;

  for (const row of document.querySelectorAll(".track-row")) {
    const isCurrent = row.dataset.trackId && row.dataset.trackId === currentId;
    row.classList.toggle("current", isCurrent);

    const bars = row.querySelector(".playing-bars");
    if (bars) bars.hidden = !(isCurrent && playing);
  }
}

/* ---------------------------------------------------------------- actions */

function playLibraryTrack(track, list, index) {
  if (list && list.length) player.setQueue(list, index, { play: true });
  else player.setQueue([track], 0, { play: true });
}

async function playSearchResult(item, { queue = false } = {}) {
  const existing = jobForVideo(item.id);

  if (existing && isJobActive(existing)) {
    toast("That track is already downloading");
    return;
  }

  if (existing && existing.status === "completed") {
    const track = trackFromJob(existing);
    if (track) {
      if (queue) player.enqueue(track, { play: player.current ? false : true });
      else player.setQueue([track], 0, { play: true });
      toast(`Playing ${track.title}`);
      return;
    }
  }

  await startDownload(item, { autoPlay: !queue });
}

async function startDownload(item, { autoPlay = false } = {}) {
  try {
    const job = await api("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url, autoPlay })
    });

    state.jobs.set(job.id, job);
    toast("Download queued");
    renderJobs();
    renderSearchResults();
    startJobPolling();
  } catch (error) {
    toast(error.message);
  }
}

function retryJob(job) {
  state.jobs.delete(job.id);
  const node = state.jobNodes.get(job.id);
  node?.remove();
  state.jobNodes.delete(job.id);
  startDownload({ url: job.url, name: job.title, id: job.videoId }, { autoPlay: job.autoPlay });
}

async function cancelJob(job) {
  try {
    const updated = await api(`/api/jobs/${job.id}`, { method: "DELETE" });
    state.jobs.set(updated.id, updated);
    renderJobs();
  } catch (error) {
    toast(error.message);
  }
}

async function toggleOffline(track) {
  if (!offline.supported()) {
    toast("Offline saving is not supported in this browser");
    return;
  }

  const url = streamUrlFor(track);
  if (!url) return;

  // Check the cache itself, not just the index, before deciding save vs remove.
  const savedAlready = await offline.verify(url);

  if (savedAlready) {
    await offline.remove(url);
    toast("Removed from offline storage");

    // Fall back to streaming if this was the loaded track.
    if (streamUrlFor(player.current) === url) await player.refreshSource();

    await refreshOffline();
    syncOfflineButton();
    if (state.tab === "playlists") renderPlaylists();
    return;
  }

  toast("Saving for offline playback…", { timeout: 0 });

  try {
    const entry = await offline.save(url, track);
    toast(`Saved offline · ${fmtBytes(entry.size)}`);
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

    // Switch the loaded track to the cached copy right away.
    if (streamUrlFor(player.current) === url) await player.refreshSource();
  } catch (error) {
    toast(error.message);
  }

  await refreshOffline();
  syncOfflineButton();
  if (state.tab === "playlists") renderPlaylists();
  renderQueue();
}

async function refreshOffline() {
  // Self-heal the index when cached audio disappeared (eviction, cleared data).
  await offline.prune().catch(() => {});

  state.offlineTracks = offline.list().map((entry) => ({
    id: `local:${entry.path}`,
    source: "local",
    path: entry.path,
    title: entry.title,
    artist: entry.artist,
    album: entry.album,
    duration: entry.duration,
    cover: null,
    offline: true,
    size: entry.size
  }));
}

/* --------------------------------------------------------------- playlists */

function loadPlaylists() {
  state.playlists = readCache(LS.playlists, []).filter((playlist) => playlist && playlist.id);
  return state.playlists;
}

function savePlaylists() {
  cache(LS.playlists, state.playlists);
}

function createPlaylist(name) {
  const playlist = { id: `pl-${Date.now().toString(36)}`, name, tracks: [], createdAt: new Date().toISOString() };
  state.playlists.unshift(playlist);
  savePlaylists();
  renderPlaylists();
  return playlist;
}

function addToPlaylist(playlistId, track) {
  const playlist = state.playlists.find((entry) => entry.id === playlistId);
  if (!playlist) return;

  if (playlist.tracks.some((entry) => entry.id === track.id)) {
    toast("Already in that playlist");
    return;
  }

  playlist.tracks.push(track);
  savePlaylists();
  renderPlaylists();
  toast(`Added to ${playlist.name}`);
}

function playlistMenuItems(track) {
  const items = state.playlists.map((playlist) => ({
    label: `${playlist.name} (${playlist.tracks.length})`,
    icon: "plus",
    onSelect: () => addToPlaylist(playlist.id, track)
  }));

  items.push({
    label: "New playlist…",
    icon: "plus",
    onSelect: async () => {
      const name = await promptDialog({ title: "New playlist", placeholder: "Playlist name", confirmLabel: "Create" });
      if (name) addToPlaylist(createPlaylist(name).id, track);
    }
  });

  return items;
}

/* ------------------------------------------------------------ view: search */

function renderSearchChips() {
  dom.searchChips.innerHTML = "";

  for (const suggestion of SEARCH_SUGGESTIONS) {
    dom.searchChips.append(
      el("button", {
        class: "chip",
        type: "button",
        text: suggestion,
        onclick: () => {
          dom.searchInput.value = suggestion;
          runSearch(suggestion);
        }
      })
    );
  }
}

function renderSearchResults() {
  const list = dom.searchResults;
  list.innerHTML = "";

  if (!state.searchResults.length) {
    if (!dom.searchStatus.hidden) return;
    list.append(emptyState("Search YouTube", "Type a song, artist or album name — then download it into your library."));
    return;
  }

  for (const item of state.searchResults) {
    const job = jobForVideo(item.id);
    let meta = item.length || "";

    if (job) {
      if (isJobActive(job)) meta = `${job.progress?.percent ? `${job.progress.percent.toFixed(0)}%` : "…"}`;
      else if (job.status === "completed") meta = "Downloaded";
      else if (job.status === "failed") meta = "Failed";
    }

    const { li } = buildTrackRow(
      {
        id: `yt:${item.id}`,
        title: item.name,
        artist: item.channel,
        thumbnail: item.thumbnail,
        duration: null
      },
      {
        subtitle: [item.channel, item.views].filter(settled).join(" · "),
        meta,
        cover: item.thumbnail,
        onActivate: () => playSearchResult(item),
        menu: () => [
          { label: "Download & play", icon: "play", onSelect: () => startDownload(item, { autoPlay: true }) },
          { label: "Download only", icon: "download", onSelect: () => startDownload(item) },
          {
            label: "Download, then queue",
            icon: "list",
            onSelect: () => {
              state.queueAfterVideo.add(item.id);
              startDownload(item);
            }
          },
          { separator: "More" },
          { label: "Open on YouTube", icon: "music", onSelect: () => window.open(item.url, "_blank", "noopener") },
          {
            label: "Copy link",
            icon: "list",
            onSelect: async () => {
              try {
                await navigator.clipboard.writeText(item.url);
                toast("Link copied");
              } catch {
                toast("Could not copy link");
              }
            }
          }
        ]
      }
    );

    list.append(li);
  }
}

async function runSearch(query) {
  const trimmed = query.trim();
  if (!trimmed) return;

  closeMenu();
  setStatus(dom.searchStatus, `Searching for “${trimmed}”…`, { spinning: true });
  dom.searchResults.innerHTML = "";

  try {
    const results = await api(`/api/search?q=${encodeURIComponent(trimmed)}`);
    state.searchResults = results;
    setStatus(dom.searchStatus, results.length ? `${results.length} results` : "No results");
    renderSearchResults();

    setTimeout(() => {
      if (dom.searchStatus.textContent.endsWith("results")) setStatus(dom.searchStatus, "");
    }, 2500);
  } catch (error) {
    setStatus(dom.searchStatus, error.message, { error: true });
    dom.searchResults.innerHTML = "";
  }
}

/* ----------------------------------------------------------- view: library */

function renderCrumbs() {
  dom.libCrumbs.innerHTML = "";
  const parts = state.libPath ? state.libPath.split("/") : [];

  dom.libCrumbs.append(
    el("button", {
      text: state.scope === "shared" ? "Shared area" : "Music",
      onclick: () => loadLibrary("")
    })
  );

  parts.forEach((part, index) => {
    dom.libCrumbs.append(el("span", { class: "sep", text: "/" }));
    dom.libCrumbs.append(
      el("button", {
        text: part,
        onclick: () => loadLibrary(parts.slice(0, index + 1).join("/"))
      })
    );
  });
}

async function loadLibrary(path = state.libPath, { quiet = false } = {}) {
  state.libPath = path;
  renderCrumbs();

  if (!quiet) setStatus(dom.libraryStatus, "Loading library…", { spinning: true });

  try {
    const scope = state.scope === "shared" ? "&scope=shared" : "";
    const data = await api(`/api/tracks?path=${encodeURIComponent(path)}${state.recursive ? "&recursive=1" : ""}${scope}`);
    state.library = data;
    state.serverOnline = true;
    setStatus(dom.libraryStatus, "");
    renderLibrary();
    probeDurations();
  } catch (error) {
    state.serverOnline = false;
    setStatus(dom.libraryStatus, `Library unavailable: ${error.message}`, { error: true });
    dom.libraryList.innerHTML = "";
    dom.libraryList.append(emptyState("Library unavailable", "Make sure the server (server.js) is running, then refresh."));
  }
}

function visibleLibrary() {
  const needle = state.filter.trim().toLowerCase();
  const tracks = state.library.tracks || [];
  if (!needle) return tracks;

  return tracks.filter((track) =>
    [track.title, track.artist, track.album, track.name].filter(Boolean).some((value) => value.toLowerCase().includes(needle))
  );
}

function renderLibrary() {
  const list = dom.libraryList;
  list.innerHTML = "";

  const folders = state.library.folders || [];
  const tracks = visibleLibrary();

  if (!folders.length && !tracks.length) {
    list.append(
      emptyState(
        state.filter ? "No matches" : "No music here yet",
        state.filter ? "Try a different filter." : "Use the Search tab to download songs into /music."
      )
    );
    updateLibraryActions();
    return;
  }

  for (const folder of folders) {
    const li = buildFolderRow(folder);
    li.querySelector(".row-meta").textContent = "folder";
    list.append(li);
  }

  const trackList = tracks.map(toPlayerTrack);

  tracks.forEach((row, index) => {
    const track = trackList[index];

    const { li } = buildTrackRow(track, {
      subtitle: trackSubtitle(track),
      meta: track.duration ? fmtTime(track.duration) : "",
      onActivate: () => playLibraryTrack(track, trackList, index),
      menu: () => libraryMenu(track, trackList, index)
    });

    list.append(li);
  });

  updateLibraryActions();
  syncRows();
}

/** Row menu for a library track. The shared area is read-only. */
function libraryMenu(track, trackList, index) {
  const mine = (track.scope || "library") !== "shared";
  const mediaUrl = streamUrlFor(track);
  const saved = mediaUrl ? offline.has(mediaUrl) : false;

  const items = [
    { label: "Play", icon: "play", onSelect: () => player.setQueue(trackList, index, { play: true }) },
    { label: "Play next", icon: "next", onSelect: () => player.playNext(track) },
    { label: "Add to queue", icon: "list", onSelect: () => player.enqueue(track) },
    { separator: "Playlists" },
    ...playlistMenuItems(track)
  ];

  if (mine) {
    items.push(
      { separator: "Sharing" },
      { label: "Share with…", icon: "share", onSelect: () => shareTrackDialog(track, { me: currentUser() }) }
    );
  }

  items.push(
    { separator: "Storage" },
    {
      label: saved ? "Remove offline copy" : "Save for offline",
      icon: saved ? "trash" : "download",
      onSelect: () => toggleOffline(track)
    },
    {
      label: "Download file",
      icon: "download",
      onSelect: () => {
        if (!mediaUrl) return;
        const link = document.createElement("a");
        link.href = `${mediaUrl}${mediaUrl.includes("?") ? "&" : "?"}download=1`;
        link.download = "";
        document.body.append(link);
        link.click();
        link.remove();
      }
    }
  );

  if (mine) {
    items.push(
      { separator: "Danger" },
      {
        label: "Delete from library",
        icon: "trash",
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: "Delete track?",
            message: `${track.title} will be removed from your library.`,
            confirmLabel: "Delete"
          });
          if (!ok) return;

          try {
            await api(`/api/track?path=${encodeURIComponent(track.path)}`, { method: "DELETE" });
            await offline.remove(mediaUrl).catch(() => {});
            toast("Track deleted");
            loadLibrary(state.libPath, { quiet: true });
            refreshOffline();
          } catch (error) {
            toast(error.message);
          }
        }
      }
    );
  }

  return items;
}

function updateLibraryActions() {
  const count = visibleLibrary().length;
  dom.playAllBtn.disabled = !count;
  dom.shuffleAllBtn.disabled = !count;
}

function probeDurations() {
  const pending = (state.library.tracks || []).filter((row) => row.duration === null || row.duration === undefined);
  if (!pending.length) return;

  pool(pending, 3, async (row) => {
    const data = await api(`/api/duration?path=${encodeURIComponent(row.path)}`).catch(() => null);
    if (!data?.duration) return;

    row.duration = data.duration;
    const li = [...document.querySelectorAll(".track-row")].find((node) => node.dataset.trackId === `local:${row.path}`);
    const meta = li?.querySelector(".row-meta");
    if (meta) meta.textContent = fmtTime(data.duration);
  });
}

/* --------------------------------------------------------- view: downloads */

function buildJobNode(job) {
  const fragment = document.getElementById("jobTemplate").content.cloneNode(true);
  const node = fragment.querySelector(".job");
  node.dataset.jobId = job.id;

  node.elements = {
    bar: node.querySelector(".job-bar span"),
    title: node.querySelector(".row-title"),
    sub: node.querySelector(".row-sub"),
    actions: node.querySelector(".job-actions"),
    img: node.querySelector("img")
  };

  return node;
}

function patchJobNode(node, job) {
  const { bar, title, sub, actions, img } = node.elements;

  node.classList.toggle("done", job.status === "completed");
  node.classList.toggle("failed", job.status === "failed" || job.status === "canceled");

  title.textContent = job.title || (job.file ? prettyName(job.file) : "YouTube audio");
  sub.textContent = jobStatusLabel(job);
  sub.classList.toggle("error", job.status === "failed");
  bar.style.width = `${job.status === "completed" ? 100 : job.progress?.percent || (job.status === "queued" ? 4 : 0)}%`;

  setCover(img, job.thumbnail || placeholderCover(job.title || job.videoId), job.title || "YouTube");

  const signature = `${job.status}:${job.file || ""}:${isJobActive(job)}:${job.autoPlay}`;
  if (node.dataset.signature === signature) return;
  node.dataset.signature = signature;

  actions.innerHTML = "";

  if (isJobActive(job)) {
    actions.append(
      el("button", { class: "icon-btn", innerHTML: icon("close"), title: "Cancel", onclick: () => cancelJob(job) })
    );
    return;
  }

  if (job.status === "completed") {
    actions.append(
      el("button", {
        class: "icon-btn",
        innerHTML: icon("play"),
        title: "Play",
        onclick: () => {
          const track = trackFromJob(job);
          if (!track) return toast("That file is no longer in the library");
          player.setQueue([track], 0, { play: true });
        }
      }),
      el("button", {
        class: "icon-btn",
        innerHTML: icon("list"),
        title: "Add to queue",
        onclick: () => {
          const track = trackFromJob(job);
          if (track) player.enqueue(track);
        }
      })
    );
    return;
  }

  actions.append(
    el("button", { class: "icon-btn", innerHTML: icon("refresh"), title: "Retry", onclick: () => retryJob(job) }),
    el("button", {
      class: "icon-btn",
      innerHTML: icon("trash"),
      title: "Remove from list",
      onclick: async () => {
        await api(`/api/jobs/${job.id}`, { method: "DELETE" }).catch(() => {});
        state.jobs.delete(job.id);
        state.jobNodes.get(job.id)?.remove();
        state.jobNodes.delete(job.id);
        renderJobs();
      }
    })
  );
}

function renderJobs() {
  const list = dom.downloadList;
  const jobs = [...state.jobs.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const seen = new Set();

  if (!jobs.length) {
    for (const node of state.jobNodes.values()) node.remove();
    state.jobNodes.clear();
    list.innerHTML = "";
    list.append(emptyState("No downloads yet", "Search for a song and tap it to download into your library."));
    updateDownloadsBadge();
    return;
  }

  if (list.querySelector(".empty")) list.innerHTML = "";

  for (const job of jobs) {
    let node = state.jobNodes.get(job.id);

    if (!node) {
      node = buildJobNode(job);
      state.jobNodes.set(job.id, node);
    }

    patchJobNode(node, job);
    list.append(node);
    seen.add(job.id);
  }

  for (const [id, node] of state.jobNodes) {
    if (!seen.has(id)) {
      node.remove();
      state.jobNodes.delete(id);
    }
  }

  updateDownloadsBadge();
}

function updateDownloadsBadge() {
  const active = [...state.jobs.values()].filter(isJobActive).length;
  const badge = $("#downloadsBadge");
  badge.hidden = active === 0;
  badge.textContent = String(active);
}

/* --------------------------------------------------------- view: playlists */

function renderPlaylists() {
  const list = dom.playlistList;
  list.innerHTML = "";

  const usage = state.offlineTracks.reduce((total, track) => total + (track.size || 0), 0);
  const playOffline = () => {
    if (!state.offlineTracks.length) {
      toast("Nothing saved for offline playback yet");
      return;
    }
    player.setQueue(state.offlineTracks, 0, { play: true });
  };

  const offlineRow = el("li", { class: "row folder-row" });
  const offlineMain = el("button", { class: "row-main" }, [
    el("span", { class: "cover", html: icon("download") }),
    el("span", { class: "row-text" }, [
      el("span", { class: "row-title", text: "Offline library" }),
      el("span", { class: "row-sub", text: `${state.offlineTracks.length} tracks · ${fmtBytes(usage)}` })
    ])
  ]);
  const offlineMore = el("button", { class: "icon-btn", innerHTML: icon("more"), title: "More" });

  offlineMain.addEventListener("click", playOffline);
  offlineRow.append(
    offlineMain,
    el("button", { class: "icon-btn", innerHTML: icon("play"), title: "Play offline tracks", onclick: playOffline }),
    offlineMore
  );

  offlineMore.addEventListener("click", () =>
    openMenu(
      offlineMore,
      state.offlineTracks.map((track, index) => ({
        label: track.title,
        icon: "play",
        onSelect: () => player.setQueue(state.offlineTracks, index, { play: true })
      })).concat([
        { separator: "Storage" },
        {
          label: "Clear offline storage",
          icon: "trash",
          danger: true,
          onSelect: async () => {
            const ok = await confirmDialog({ title: "Clear all offline tracks?", confirmLabel: "Clear" });
            if (!ok) return;
            await offline.clearAll();
            await refreshOffline();
            renderPlaylists();
            toast("Offline storage cleared");
          }
        }
      ]),
      { title: "Offline library" }
    )
  );

  list.append(offlineRow);

  if (!state.playlists.length) {
    list.append(emptyState("No playlists yet", "Create one, then add tracks from a track's ⋮ menu."));
    return;
  }

  for (const playlist of state.playlists) {
    const row = el("li", { class: "row folder-row" }, [
      el("button", { class: "row-main" }, [
        el("span", { class: "cover", html: icon("list") }),
        el("span", { class: "row-text" }, [
          el("span", { class: "row-title", text: playlist.name }),
          el("span", { class: "row-sub", text: `${playlist.tracks.length} tracks · created ${fmtDate(playlist.createdAt)}` })
        ])
      ]),
      el("button", { class: "icon-btn", innerHTML: icon("play"), title: "Play" }),
      el("button", { class: "icon-btn", innerHTML: icon("more"), title: "More" })
    ]);

    const [main, playBtn, moreBtn] = row.querySelectorAll("button");

    main.addEventListener("click", () => openPlaylist(playlist));
    playBtn.addEventListener("click", () => {
      if (!playlist.tracks.length) return toast("That playlist is empty");
      player.setQueue(playlist.tracks, 0, { play: true });
    });

    moreBtn.addEventListener("click", () => {
      openMenu(moreBtn, [
        { label: "Play", icon: "play", onSelect: () => playlist.tracks.length && player.setQueue(playlist.tracks, 0, { play: true }) },
        { label: "Shuffle play", icon: "shuffle", onSelect: () => { player.setShuffle(true); playlist.tracks.length && player.setQueue(playlist.tracks, 0, { play: true }); } },
        { separator: "Manage" },
        {
          label: "Rename",
          icon: "plus",
          onSelect: async () => {
            const name = await promptDialog({ title: "Rename playlist", value: playlist.name, confirmLabel: "Rename" });
            if (!name) return;
            playlist.name = name;
            savePlaylists();
            renderPlaylists();
          }
        },
        {
          label: "Delete playlist",
          icon: "trash",
          danger: true,
          onSelect: async () => {
            const ok = await confirmDialog({ title: `Delete “${playlist.name}”?`, confirmLabel: "Delete" });
            if (!ok) return;
            state.playlists = state.playlists.filter((entry) => entry.id !== playlist.id);
            savePlaylists();
            renderPlaylists();
          }
        }
      ], { title: playlist.name });
    });

    list.append(row);
  }
}

function openPlaylist(playlist) {
  const list = dom.playlistList;
  list.innerHTML = "";

  const header = el("li", { class: "lib-toolbar" }, [
    el("div", { class: "crumbs" }, [
      el("button", { text: "Playlists", onclick: renderPlaylists }),
      el("span", { class: "sep", text: "/" }),
      el("button", { text: playlist.name })
    ]),
    el("button", {
      class: "btn soft small",
      html: `${icon("play")}Play all`,
      onclick: () => playlist.tracks.length && player.setQueue(playlist.tracks, 0, { play: true })
    })
  ]);

  list.append(header);

  if (!playlist.tracks.length) {
    list.append(emptyState("Empty playlist", "Add tracks from the Library tab's ⋮ menu."));
    return;
  }

  playlist.tracks.forEach((track, index) => {
    const { li } = buildTrackRow(track, {
      onActivate: () => player.setQueue(playlist.tracks, index, { play: true }),
      menu: () => [
        { label: "Play", icon: "play", onSelect: () => player.setQueue(playlist.tracks, index, { play: true }) },
        { label: "Play next", icon: "next", onSelect: () => player.playNext(track) },
        { label: "Add to queue", icon: "list", onSelect: () => player.enqueue(track) },
        { separator: "Manage" },
        {
          label: "Remove from playlist",
          icon: "trash",
          danger: true,
          onSelect: () => {
            playlist.tracks = playlist.tracks.filter((entry) => entry.id !== track.id);
            savePlaylists();
            openPlaylist(playlist);
          }
        }
      ]
    });
    list.append(li);
  });
}

/* ----------------------------------------------------------------- view: queue */

function renderQueue() {
  const list = dom.queueList;
  if (!list) return;

  list.innerHTML = "";
  const queue = player.queue;
  dom.queueCount.textContent = queue.length ? `${queue.length} tracks` : "";

  if (!queue.length) {
    list.append(emptyState("Queue is empty", "Tap a track in your library to start playing."));
    return;
  }

  queue.forEach((track, index) => {
    const { li } = buildTrackRow(track, {
      subtitle: trackSubtitle(track),
      current: index === player.index,
      onActivate: () => player.jumpTo(index),
      menu: () => [
        { label: "Play now", icon: "play", onSelect: () => player.jumpTo(index) },
        {
          label: "Remove from queue",
          icon: "trash",
          danger: true,
          onSelect: () => player.removeAt(index)
        }
      ]
    });
    list.append(li);
  });

  syncRows();
}

/* ------------------------------------------------------- identity + sharing */

function updateUserChip() {
  const user = currentUser();
  dom.userChipName.textContent = user || "Guest";
  dom.userChip.title = user ? `Library of ${user} — tap to switch` : "Pick your library";
  dom.userChip.classList.toggle("active", Boolean(user));
}

function syncScopeButton() {
  const shared = state.scope === "shared";
  dom.scopeBtn.classList.toggle("active", shared);
  dom.scopeBtn.setAttribute("aria-pressed", String(shared));
  dom.scopeBtn.textContent = shared ? "My library" : "Everyone's songs";
}

/**
 * Switching identity swaps the whole library, so anything derived from the
 * previous one (queue, jobs, search results) is dropped.
 */
async function switchUser(name, { force = false } = {}) {
  const previous = currentUser();
  if (name === previous && !force) return;

  setCurrentUser(name);
  updateUserChip();

  player.clearQueue();
  state.jobs.clear();
  state.jobNodes.clear();
  state.searchResults = [];
  state.library = { folders: [], tracks: [] };
  state.shares = { incoming: [], outgoing: [] };
  state.libPath = "";
  state.scope = "library";
  state.autoPlayed.clear();

  jobsSeeded = false;
  syncScopeButton();
  renderSearchResults();
  renderQueue();
  updateDownloadsBadge();

  await refreshOffline();
  await loadLibrary("", { quiet: true });
  await refreshShares({ quiet: true });
  renderShares();
  renderPlaylists();
}

async function refreshShares({ quiet = false } = {}) {
  if (!quiet) setStatus(dom.sharesStatus, "Loading…", { spinning: true });

  try {
    const data = await listShares();
    state.shares = { incoming: data.incoming || [], outgoing: data.outgoing || [] };
    setStatus(dom.sharesStatus, "");
  } catch (error) {
    state.shares = { incoming: [], outgoing: [] };
    setStatus(dom.sharesStatus, `Sharing unavailable: ${error.message}`, { error: true });
  }

  updateSharesBadge();
}

function updateSharesBadge() {
  const count = state.shares.incoming.length;
  dom.sharesBadge.hidden = !count;
  dom.sharesBadge.textContent = count > 9 ? "9+" : String(count);
}

/** A shared track is playable straight from the sender's library. */
function shareToTrack(share) {
  return {
    id: `share:${share.id}`,
    source: "local",
    path: share.trackPath,
    scope: "share",
    shareId: share.id,
    title: share.title || prettyName(share.trackPath),
    artist: share.artist || `from ${share.from}`,
    album: share.album || null,
    duration: share.duration ?? null,
    url: withUser(share.stream),
    hls: withUser(share.hls),
    cover: share.hasCover ? withUser(share.cover) : null,
    size: null
  };
}

function renderShares() {
  const list = dom.shareList;
  list.innerHTML = "";

  for (const chip of dom.shareTabs.querySelectorAll(".chip")) {
    chip.setAttribute("aria-pressed", String(chip.dataset.scope === state.shareScope));
  }

  const incoming = state.shareScope === "incoming";
  const shares = (incoming ? state.shares.incoming : state.shares.outgoing) || [];

  if (!shares.length) {
    list.append(
      incoming
        ? emptyState("Nothing shared with you yet", "When someone sends you a song it shows up here. Share your own tracks from the Library tab.")
        : emptyState("You have not shared anything yet", "Open a track in your Library and choose “Share with…”.")
    );
    return;
  }

  const tracks = incoming ? shares.map(shareToTrack) : [];

  shares.forEach((share, index) => {
    const person = incoming
      ? `from ${share.from}`
      : share.to === "*"
        ? "with everyone"
        : `with ${share.to}`;

    const subtitle = [share.artist, person].filter(Boolean).join(" · ");
    const playable = incoming && share.available;

    const { li, subNode } = buildTrackRow(
      {
        id: `share:${share.id}`,
        title: share.title || prettyName(share.trackPath),
        artist: share.artist,
        album: share.album,
        duration: share.duration ?? null,
        cover: share.hasCover ? withUser(share.cover) : null
      },
      {
        subtitle: share.available ? subtitle : `${person} · file is gone`,
        meta: share.duration ? fmtTime(share.duration) : "",
        onActivate: playable ? () => player.setQueue(tracks, index, { play: true }) : undefined,
        menu: () => [
          playable ? { label: "Play", icon: "play", onSelect: () => player.setQueue(tracks, index, { play: true }) } : null,
          playable ? { label: "Save to my library", icon: "download", onSelect: () => saveShared(share) } : null,
          { label: incoming ? "Dismiss" : "Revoke", icon: "trash", danger: true, onSelect: () => dropShare(share.id) }
        ].filter(Boolean)
      }
    );

    if (share.note) subNode.textContent = `${subtitle} — “${share.note}”`;
    if (!share.available) li.classList.add("muted");

    list.append(li);
  });
}

async function saveShared(share) {
  try {
    const result = await importShare(share.id);
    toast(`Saved “${result?.track?.title || share.title}” to your library`);
    loadLibrary(state.libPath, { quiet: true });
  } catch (error) {
    toast(error.message);
  }
}

async function dropShare(id) {
  try {
    await revokeShare(id);
    await refreshShares({ quiet: true });
    renderShares();
  } catch (error) {
    toast(error.message);
  }
}

/* -------------------------------------------------------------- tab routing */

function switchTab(tab, { focus = false } = {}) {
  state.tab = tab;
  cache(LS.lastTab, tab);

  for (const section of document.querySelectorAll(".view")) {
    section.hidden = section.id !== `view-${tab}`;
  }

  for (const button of document.querySelectorAll(".tab")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }

  if (tab === "downloads") {
    startJobPolling();
    renderJobs();
  } else if (tab === "library") {
    if (!state.library.tracks.length && !state.library.folders.length) loadLibrary(state.libPath);
  } else if (tab === "playlists") {
    refreshOffline().then(renderPlaylists);
  } else if (tab === "shared") {
    refreshShares({ quiet: true }).then(renderShares);
  } else if (tab === "search") {
    // Refresh download badges on existing results.
    if (state.searchResults.length) renderSearchResults();
    if (focus) dom.searchInput.focus();
  }

  history.replaceState(null, "", `#${tab}`);
}

/* ------------------------------------------------------------ job polling */

let jobTimer = null;
let jobsSeeded = false;

function startJobPolling() {
  if (jobTimer) return;
  pollJobs();
  jobTimer = setInterval(pollJobs, 1100);
}

function stopJobPolling() {
  clearInterval(jobTimer);
  jobTimer = null;
}

async function pollJobs() {
  const hadJobs = state.jobs.size;

  // The first poll after a page load only seeds existing history: jobs that
  // finished in an earlier session must not trigger playback now.
  const seeding = !jobsSeeded;
  jobsSeeded = true;

  try {
    const data = await api("/api/jobs");
    const serverJobs = data.jobs || [];

    for (const job of serverJobs) {
      const previous = state.jobs.get(job.id);
      state.jobs.set(job.id, job);

      if (!seeding && previous && isJobActive(previous) && job.status === "completed") {
        onJobCompleted(job);
      }
    }

    if (state.tab === "downloads") renderJobs();
    else updateDownloadsBadge();
    if (state.tab === "search") renderSearchResults();

    const active = serverJobs.filter(isJobActive).length;
    if (!active && state.tab !== "downloads") stopJobPolling();
  } catch {
    stopJobPolling();
    if (hadJobs) setStatus(dom.downloadsStatus, "Lost connection to the server", { error: true });
  }
}

function onJobCompleted(job) {
  const track = trackFromJob(job);

  if (state.queueAfterVideo.has(job.videoId)) {
    state.queueAfterVideo.delete(job.videoId);
    state.autoPlayed.add(job.id);
    if (track) {
      player.enqueue(track, { play: !player.current });
      toast(`Added to queue · ${track.title}`);
    }
    return;
  }

  if (state.autoPlayed.has(job.id)) return;
  state.autoPlayed.add(job.id);

  if (job.autoPlay && track) {
    player.setQueue([track], 0, { play: true });
    toast(`Now playing · ${track.title}`);
  } else {
    toast(`Downloaded · ${job.title || prettyName(job.file || "track")}`);
  }

  if (state.tab === "library") loadLibrary(state.libPath, { quiet: true });
  if (state.tab === "search") renderSearchResults();
}

async function clearFinishedJobs() {
  const finished = [...state.jobs.values()].filter((job) => !isJobActive(job));

  if (!finished.length) return toast("Nothing to clear");

  await Promise.all(finished.map((job) => api(`/api/jobs/${job.id}`, { method: "DELETE" }).catch(() => {})));

  for (const job of finished) {
    state.jobs.delete(job.id);
    state.jobNodes.get(job.id)?.remove();
    state.jobNodes.delete(job.id);
  }

  renderJobs();
  toast("Cleared finished downloads");
}

/* --------------------------------------------------------------- sheet/UI */

/** True when routing audio through Web Audio is safe (not iOS/WKWebView). */
function visualizerAllowed() {
  const bridge = window.__resonanceNative;

  // The spectrum analyser re-routes the <audio> element through an AudioContext,
  // which iOS suspends once the app is backgrounded — playback then goes silent
  // while the track keeps "playing". The native shell opts out, and iOS Safari
  // behaves the same way.
  if (bridge && bridge.visualizer === false) return false;
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return false;

  return typeof (window.AudioContext || window.webkitAudioContext) === "function";
}

function openSheet() {
  if (!player.current) return;
  dom.sheet.hidden = false;
  document.body.style.overflow = "hidden";
  syncSheet();
  renderQueue();

  if (visualizerAllowed()) {
    player.enableVisualizer(dom.visualizer);
  } else {
    dom.visualizer.hidden = true;
  }
}

function closeSheet() {
  dom.sheet.hidden = true;
  document.body.style.overflow = "";
  player.stopVisualizer();
}

/* ------------------------------------------------------------- PWA wiring */

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.register("/sw.js");

    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;

      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          toast("A new version is ready", {
            actionLabel: "Reload",
            timeout: 0,
            onAction: () => {
              worker.postMessage({ type: "SKIP_WAITING" });
              navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
            }
          });
        }
      });
    });
  } catch (error) {
    console.warn("Service worker registration failed:", error.message);
  }
}

function wireInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    dom.installBtn.hidden = false;
  });

  dom.installBtn.addEventListener("click", async () => {
    if (!state.installPrompt) {
      toast("Use your browser menu → “Install app”");
      return;
    }
    state.installPrompt.prompt();
    const choice = await state.installPrompt.userChoice;
    if (choice?.outcome === "accepted") toast("Installing Resonance…");
    state.installPrompt = null;
    dom.installBtn.hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    dom.installBtn.hidden = true;
    toast("Resonance installed — it now works offline");
  });

  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

  // Inside the native shell there is nothing to install.
  if (!NATIVE && !standalone && ios && !localStorage.getItem(LS.iosHint)) {
    cache(LS.iosHint, "1");
    setTimeout(() => toast("Install: Share → Add to Home Screen", { timeout: 8000 }), 2500);
  }
}

/** Native shell wiring: settings entry point, no install affordances. */
function wireNativeShell() {
  if (!NATIVE) return;

  document.documentElement.classList.add("native-shell");
  dom.installBtn.hidden = true;
  dom.nativeSettingsBtn.hidden = false;

  dom.nativeSettingsBtn.addEventListener("click", () => {
    try {
      window.__resonanceNative?.openSettings?.();
    } catch {
      /* shell refused */
    }
  });
}

function wireConnectivity() {
  const update = () => {
    dom.netBadge.hidden = navigator.onLine;
    if (navigator.onLine && state.serverOnline === false) loadLibrary(state.libPath, { quiet: true });
  };

  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

function wireKeyboard() {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

    if (typing && event.key !== "Escape") return;

    switch (event.key) {
      case " ":
        if (typing) return;
        event.preventDefault();
        player.toggle();
        break;
      case "ArrowRight":
        player.seekBy(event.shiftKey ? 30 : 5);
        break;
      case "ArrowLeft":
        player.seekBy(event.shiftKey ? -30 : -5);
        break;
      case "n":
        player.next();
        break;
      case "p":
        player.prev();
        break;
      case "s":
        player.setShuffle(!player.shuffle);
        break;
      case "r":
        player.cycleRepeat();
        break;
      case "m":
        player.setVolume(player.volume > 0 ? 0 : 1);
        break;
      case "Escape":
        closeSheet();
        closeMenu();
        break;
      default:
        break;
    }
  });
}

/* ------------------------------------------------------------------- boot */

function cacheDom() {
  Object.assign(dom, {
    views: $("#views"),
    searchForm: $("#searchForm"),
    searchInput: $("#searchInput"),
    searchChips: $("#searchChips"),
    searchStatus: $("#searchStatus"),
    searchResults: $("#searchResults"),

    libCrumbs: $("#libCrumbs"),
    libFilter: $("#libFilter"),
    libraryStatus: $("#libraryStatus"),
    libraryList: $("#libraryList"),
    recursiveBtn: $("#recursiveBtn"),
    scopeBtn: $("#scopeBtn"),
    userChip: $("#userChip"),
    userChipName: $("#userChipName"),

    shareTabs: $("#shareTabs"),
    sharesStatus: $("#sharesStatus"),
    shareList: $("#shareList"),
    sharesBadge: $("#sharesBadge"),
    refreshSharesBtn: $("#refreshSharesBtn"),
    playAllBtn: $("#playAllBtn"),
    shuffleAllBtn: $("#shuffleAllBtn"),

    downloadsStatus: $("#downloadsStatus"),
    downloadList: $("#downloadList"),
    clearJobsBtn: $("#clearJobsBtn"),

    playlistList: $("#playlistList"),
    newPlaylistBtn: $("#newPlaylistBtn"),

    mini: $("#mini"),
    miniExpand: $("#miniExpand"),
    miniCover: $("#miniCover"),
    miniCoverWrap: $("#miniCoverWrap"),
    miniTitle: $("#miniTitle"),
    miniArtist: $("#miniArtist"),
    miniPlay: $("#miniPlay"),
    miniNext: $("#miniNext"),
    miniProgressBar: $("#miniProgressBar"),

    sheet: $("#sheet"),
    sheetPanel: $(".sheet-panel"),
    sheetBackdrop: $("#sheetBackdrop"),
    sheetClose: $("#sheetClose"),
    sheetQueueBtn: $("#sheetQueueBtn"),
    sheetCover: $("#sheetCover"),
    sheetTitle: $("#sheetTitle"),
    sheetArtist: $("#sheetArtist"),
    sheetSource: $("#sheetSource"),
    visualizer: $("#visualizer"),

    seekBar: $("#seekBar"),
    seekCurrent: $("#seekCurrent"),
    seekTotal: $("#seekTotal"),
    volumeBar: $("#volumeBar"),
    playBtn: $("#playBtn"),
    prevBtn: $("#prevBtn"),
    nextBtn: $("#nextBtn"),
    shuffleBtn: $("#shuffleBtn"),
    repeatBtn: $("#repeatBtn"),

    queuePanel: $("#queuePanel"),
    queueList: $("#queueList"),
    queueCount: $("#queueCount"),

    offlineToggleBtn: $("#offlineToggleBtn"),
    offlineToggleLabel: $("#offlineToggleLabel"),
    playlistAddBtn: $("#playlistAddBtn"),

    installBtn: $("#installBtn"),
    nativeSettingsBtn: $("#nativeSettingsBtn"),
    refreshBtn: $("#refreshBtn"),
    netBadge: $("#netBadge")
  });
}

function wireEvents() {
  dom.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch(dom.searchInput.value);
    dom.searchInput.blur();
  });

  for (const button of document.querySelectorAll(".tab")) {
    button.addEventListener("click", () => switchTab(button.dataset.tab, { focus: true }));
  }

  dom.refreshBtn.addEventListener("click", () => {
    if (state.tab === "library") loadLibrary(state.libPath);
    else if (state.tab === "downloads") pollJobs();
    else if (state.tab === "playlists") refreshOffline().then(renderPlaylists);
    else if (state.tab === "search" && state.searchResults.length) runSearch(dom.searchInput.value);
    toast("Refreshed");
  });

  dom.recursiveBtn.addEventListener("click", () => {
    state.recursive = !state.recursive;
    dom.recursiveBtn.classList.toggle("active", state.recursive);
    dom.recursiveBtn.setAttribute("aria-pressed", String(state.recursive));
    loadLibrary(state.libPath);
  });

  dom.scopeBtn.addEventListener("click", () => {
    state.scope = state.scope === "shared" ? "library" : "shared";
    state.libPath = "";
    syncScopeButton();
    loadLibrary("");
  });

  dom.userChip.addEventListener("click", async () => {
    const before = currentUser();
    const picked = await chooseUser();
    if (picked && picked !== before) switchUser(picked);
  });

  dom.refreshSharesBtn.addEventListener("click", async () => {
    await refreshShares();
    renderShares();
  });

  for (const chip of dom.shareTabs.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      state.shareScope = chip.dataset.scope;
      renderShares();
    });
  }

  dom.libFilter.addEventListener("input", () => {
    state.filter = dom.libFilter.value;
    renderLibrary();
  });

  dom.playAllBtn.addEventListener("click", () => {
    const tracks = visibleLibrary().map(toPlayerTrack);
    if (tracks.length) player.setQueue(tracks, 0, { play: true });
  });

  dom.shuffleAllBtn.addEventListener("click", () => {
    const tracks = visibleLibrary().map(toPlayerTrack);
    if (!tracks.length) return;
    player.setShuffle(true);
    player.setQueue(tracks, Math.floor(Math.random() * tracks.length), { play: true });
  });

  dom.clearJobsBtn.addEventListener("click", clearFinishedJobs);
  dom.newPlaylistBtn.addEventListener("click", async () => {
    const name = await promptDialog({ title: "New playlist", placeholder: "Playlist name", confirmLabel: "Create" });
    if (name) createPlaylist(name);
  });

  dom.miniExpand.addEventListener("click", openSheet);
  dom.miniPlay.addEventListener("click", (event) => {
    event.stopPropagation();
    player.toggle();
  });
  dom.miniNext.addEventListener("click", (event) => {
    event.stopPropagation();
    player.next();
  });

  dom.sheetClose.addEventListener("click", closeSheet);
  dom.sheetBackdrop.addEventListener("click", closeSheet);
  dom.sheetQueueBtn.addEventListener("click", () => {
    dom.queuePanel.hidden = !dom.queuePanel.hidden;
    if (!dom.queuePanel.hidden) {
      renderQueue();
      dom.queuePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  dom.playBtn.addEventListener("click", () => player.toggle());
  dom.prevBtn.addEventListener("click", () => player.prev());
  dom.nextBtn.addEventListener("click", () => player.next());
  dom.shuffleBtn.addEventListener("click", () => player.setShuffle(!player.shuffle));
  dom.repeatBtn.addEventListener("click", () => player.cycleRepeat());

  dom.sheetQueueBtn.addEventListener("dblclick", () => player.clearQueue());

  const beginSeek = () => {
    dom.seeking = true;
  };

  const endSeek = () => {
    dom.seeking = false;
  };

  dom.seekBar.addEventListener("pointerdown", beginSeek);
  dom.seekBar.addEventListener("pointerup", endSeek);
  dom.seekBar.addEventListener("touchstart", beginSeek, { passive: true });
  dom.seekBar.addEventListener("change", () => {
    const duration = player.duration || 0;
    player.seekTo((Number(dom.seekBar.value) / 1000) * duration);
    endSeek();
  });
  dom.seekBar.addEventListener("input", () => {
    const duration = player.duration || 0;
    dom.seekCurrent.textContent = fmtTime((Number(dom.seekBar.value) / 1000) * duration);
    setRangeFill(dom.seekBar);
  });

  dom.volumeBar.addEventListener("input", () => {
    player.setVolume(Number(dom.volumeBar.value) / 100);
  });

  dom.offlineToggleBtn.addEventListener("click", () => {
    const track = player.current;
    if (track) toggleOffline(track);
  });

  dom.playlistAddBtn.addEventListener("click", () => {
    const track = player.current;
    if (!track) return;
    openMenu(dom.playlistAddBtn, playlistMenuItems(track), { title: track.title });
  });

  window.addEventListener("hashchange", () => {
    const tab = location.hash.replace("#", "");
    if (tab && tab !== state.tab) switchTab(tab);
  });
}

function restoreUiState() {
  const tab = location.hash.replace("#", "") || localStorage.getItem(LS.lastTab) || "search";
  switchTab(["search", "library", "downloads", "shared", "playlists"].includes(tab) ? tab : "search");

  dom.recursiveBtn.classList.toggle("active", state.recursive);
  dom.recursiveBtn.setAttribute("aria-pressed", String(state.recursive));

  renderSearchChips();
  renderSearchResults();
  renderPlaylists();
  renderQueue();
  syncMini();
  syncSheet();
  syncTransportButtons();
  setRangeFill(dom.seekBar);
  setRangeFill(dom.volumeBar);
}

async function init() {
  cacheDom();
  loadPlaylists();
  bindPlayer();
  wireEvents();
  wireInstallPrompt();
  wireNativeShell();
  wireConnectivity();
  wireKeyboard();
  registerServiceWorker();

  restoreUiState();
  await refreshOffline();

  // First run on this device: ask who is listening, so each person gets their
  // own library. Skipped when the server is unreachable or a name is stored.
  if (!currentUser()) {
    const picked = await chooseUser().catch(() => null);
    if (picked) await switchUser(picked, { force: true });
  }

  updateUserChip();
  syncScopeButton();

  if (state.tab === "library") loadLibrary(state.libPath);
  if (state.tab === "playlists") renderPlaylists();

  startJobPolling();
  refreshShares({ quiet: true }).then(renderShares);

  api("/api/health")
    .then((health) => {
      state.serverOnline = true;
      if (!health.ytDlp) toast("Server: yt-dlp is missing — downloads will fail", { timeout: 7000 });
      if (!offline.supported()) toast("Offline saving needs HTTPS or localhost", { timeout: 7000 });
    })
    .catch(() => {
      state.serverOnline = false;
      toast("Cannot reach the music server", { timeout: 7000 });
    });

  // Debug handle for troubleshooting on real devices: open the app with ?debug=1
  if (new URLSearchParams(location.search).has("debug")) {
    window.__app = { player, state, api, offline };
    console.info("Resonance debug handle at window.__app");
  }
}

init();
