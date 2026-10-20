// Audio engine: queue, playback, Media Session integration, offline source
// resolution and an optional canvas spectrum visualiser.

import * as offline from "./offline.js";

const STATE_KEY = "resonance.player.v1";

export function trackId(track) {
  if (!track) return null;
  if (track.source === "local") return `local:${track.path}`;
  return `yt:${track.videoId}`;
}

export function streamUrlFor(track) {
  if (track?.path) return `/api/stream?path=${encodeURIComponent(track.path)}`;
  return track?.url || null;
}

export class Player extends EventTarget {
  constructor() {
    super();

    this.audio = new Audio();
    this.audio.preload = "metadata";
    this.audio.setAttribute("playsinline", "");

    // iOS suspends media that is not part of the document, so the element lives
    // in the DOM (visually hidden, non-interactive) on every platform.
    this.audio.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";

    if (document.body) {
      document.body.append(this.audio);
    } else {
      document.addEventListener("DOMContentLoaded", () => document.body.append(this.audio), { once: true });
    }

    this.queue = [];
    this.index = -1;
    this.shuffle = false;
    this.repeat = "off"; // off | all | one

    this._shuffleOrder = [];
    this._loadToken = 0;
    this._blobUrl = null;
    this._canonicalUrl = null;
    this._playingFromCache = false;
    this._audioCtx = null;
    this._analyser = null;
    this._rafId = 0;
    this._saveTimer = 0;
    this._sessionTick = 0;
    this._nativeTick = 0;

    this._bindAudio();
    this._restore();
  }

  /* ------------------------------------------------------------- getters */

  get current() {
    return this.queue[this.index] || null;
  }

  get isPlaying() {
    return !this.audio.paused && !this.audio.ended && this.audio.readyState > 2;
  }

  get duration() {
    const value = this.audio.duration;
    return Number.isFinite(value) ? value : this.current?.duration || null;
  }

  get position() {
    return Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
  }

  get usingOfflineCopy() {
    return this._playingFromCache;
  }

  /* -------------------------------------------------------------- binding */

  _bindAudio() {
    const audio = this.audio;

    audio.addEventListener("play", () => {
      this._updateSessionState();
      this.emit("play");
      this._reportNative("playing");
      this._startVisualizerLoop();
    });

    audio.addEventListener("pause", () => {
      this._updateSessionState();
      this.emit("pause");
      this._reportNative("paused");
      this._save({ position: true });
    });

    audio.addEventListener("ended", () => {
      if (this.repeat === "one") {
        audio.currentTime = 0;
        this.play().catch(() => {});
        return;
      }
      this.next({ auto: true });
    });

    audio.addEventListener("timeupdate", () => {
      this.emit("time", { position: this.position, duration: this.duration });

      if (Date.now() - this._sessionTick > 1000) {
        this._sessionTick = Date.now();
        this._updatePositionState();
        this._save({ position: true });
      }

      // Keep the native lock-screen scrubber honest (throttled).
      if (Date.now() - this._nativeTick > 5000) {
        this._nativeTick = Date.now();
        this._reportNative(this.audio.paused ? "paused" : "progress");
      }
    });

    audio.addEventListener("loadedmetadata", () => {
      const track = this.current;
      if (track && Number.isFinite(audio.duration) && !track.duration) {
        track.duration = audio.duration;
      }
      this.emit("time", { position: this.position, duration: this.duration });
      this._updatePositionState();
    });

    audio.addEventListener("error", () => {
      const code = audio.error?.code;
      const message =
        code === 4
          ? "This track could not be played (unsupported format or missing file)"
          : "Playback error";
      this.emit("error", { message, track: this.current });
    });
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /* ------------------------------------------------------------ queue API */

  setQueue(tracks, startIndex = 0, { play = true } = {}) {
    this.queue = tracks.slice();
    this.index = tracks.length ? Math.max(0, Math.min(startIndex, tracks.length - 1)) : -1;
    this._rebuildShuffleOrder();
    this.emit("queue", { queue: this.queue });

    if (this.index >= 0) {
      this._load(this.queue[this.index], { autoplay: play });
    } else {
      this._teardownAudio();
      this.emit("track", { track: null, index: -1 });
    }
  }

  enqueue(track, { play = false } = {}) {
    this.queue.push(track);
    this._rebuildShuffleOrder();
    this.emit("queue", { queue: this.queue });

    if (this.index === -1) {
      this.index = 0;
      this._load(track, { autoplay: play });
    } else if (play) {
      this.jumpTo(this.queue.length - 1);
    }

    this._save();
    return this.queue.length - 1;
  }

  playNext(track) {
    const at = this.index < 0 ? this.queue.length : this.index + 1;
    this.queue.splice(at, 0, track);
    this._rebuildShuffleOrder();
    this.emit("queue", { queue: this.queue });
    this._save();
    return at;
  }

  removeAt(index) {
    if (index < 0 || index >= this.queue.length) return;

    const wasCurrent = index === this.index;
    this.queue.splice(index, 1);

    if (this.queue.length === 0) {
      this.setQueue([], 0, { play: false });
      return;
    }

    if (index < this.index) this.index -= 1;
    if (wasCurrent) {
      this.index = Math.min(this.index, this.queue.length - 1);
      this._load(this.queue[this.index], { autoplay: this.isPlaying });
    }

    this._rebuildShuffleOrder();
    this.emit("queue", { queue: this.queue });
    this._save();
  }

  clearQueue() {
    this.setQueue([], 0, { play: false });
    this._save();
  }

  jumpTo(index, { play = true } = {}) {
    if (index < 0 || index >= this.queue.length) return;
    this.index = index;
    this._load(this.queue[index], { autoplay: play });
  }

  /* ---------------------------------------------------------- transport */

  async play() {
    if (this.index < 0 && this.queue.length) {
      this.index = 0;
      this._load(this.queue[0], { autoplay: true });
      return;
    }

    if (!this.current) return;

    try {
      await this._ensureSource();
      await this.audio.play();
      await this._resumeAudioContext();
    } catch (error) {
      if (error?.name !== "AbortError") {
        this.emit("error", { message: error?.message || "Playback failed", track: this.current });
      }
    }
  }

  pause() {
    this.audio.pause();
  }

  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  next({ auto = false } = {}) {
    if (!this.queue.length) return;

    const nextIndex = this._nextIndex();

    if (nextIndex === null) {
      // End of queue without repeat: stop on the last track.
      this.pause();
      if (auto) this.emit("queueend", {});
      return;
    }

    this.jumpTo(nextIndex);
  }

  prev() {
    if (!this.queue.length) return;

    // Restart the track when we are past the first few seconds.
    if (this.position > 3) {
      this.seekTo(0);
      return;
    }

    const order = this.shuffle ? this._shuffleOrder : this.queue.map((_, index) => index);
    const at = order.indexOf(this.index);
    const previous = at <= 0 ? order[order.length - 1] : order[at - 1];
    this.jumpTo(previous);
  }

  seekTo(seconds) {
    if (!Number.isFinite(seconds)) return;
    const max = this.duration || seconds;
    this.audio.currentTime = Math.max(0, Math.min(seconds, max));
    this.emit("time", { position: this.position, duration: this.duration });
    this._updatePositionState();
  }

  seekBy(delta) {
    this.seekTo(this.position + delta);
  }

  setVolume(value) {
    const volume = Math.max(0, Math.min(1, value));
    this.audio.volume = volume;
    this.audio.muted = volume === 0;
    this.emit("volume", { volume });
    this._save();
  }

  get volume() {
    return this.audio.muted ? 0 : this.audio.volume;
  }

  setShuffle(enabled) {
    this.shuffle = Boolean(enabled);
    this._rebuildShuffleOrder();
    this.emit("mode", { shuffle: this.shuffle, repeat: this.repeat });
    this._save();
  }

  setRepeat(mode) {
    this.repeat = ["off", "all", "one"].includes(mode) ? mode : "off";
    this.emit("mode", { shuffle: this.shuffle, repeat: this.repeat });
    this._save();
  }

  cycleRepeat() {
    this.setRepeat(this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off");
  }

  _nextIndex() {
    const order = this.shuffle && this._shuffleOrder.length ? this._shuffleOrder : this.queue.map((_, index) => index);
    const at = order.indexOf(this.index);
    const next = order[at + 1];

    if (next !== undefined) return next;
    return this.repeat === "all" ? order[0] : null;
  }

  _rebuildShuffleOrder() {
    const indices = this.queue.map((_, index) => index).filter((index) => index !== this.index);

    for (let i = indices.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    this._shuffleOrder = this.index >= 0 ? [this.index, ...indices] : indices;
  }

  /* ---------------------------------------------------------- source load */

  async _load(track, { autoplay = false } = {}) {
    this._loadToken += 1;
    const token = this._loadToken;

    this._releaseBlob();
    this._canonicalUrl = streamUrlFor(track);
    this._playingFromCache = false;

    this.emit("track", { track, index: this.index });
    this.emit("srcstate", { track, status: "loading", offline: false });
    this._updateMediaSession();
    this._reportNative("track");

    await this._setSourceFor(track, token);

    if (autoplay && token === this._loadToken) {
      await this.play();
    }

    this._save();
  }

  /** Points <audio> at the offline copy when one exists, otherwise the stream. */
  async _setSourceFor(track, token) {
    const url = this._canonicalUrl;
    if (!url) return;

    let blobUrl = null;

    if (track.source === "local") {
      blobUrl = await offline.objectUrl(url).catch(() => null);
    }

    if (token !== this._loadToken) {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      return;
    }

    if (blobUrl) {
      this._blobUrl = blobUrl;
      this._playingFromCache = true;
      this.audio.src = blobUrl;
      this.emit("srcstate", { track, status: "ready", offline: true });
    } else {
      this.audio.src = url;
      this.emit("srcstate", { track, status: "ready", offline: false });
    }

    this.audio.load();
  }

  async _ensureSource() {
    if (this.audio.src && this.audio.src !== location.href) return;
    await this._setSourceFor(this.current, this._loadToken);
  }

  /**
   * Re-resolve the source for the current track (used after its offline copy is
   * added or removed) while keeping the playback position and state.
   */
  async refreshSource() {
    const track = this.current;
    if (!track) return;

    const wasPlaying = !this.audio.paused;
    const position = this.position;
    const previousBlob = this._blobUrl;

    this._blobUrl = null;
    this._playingFromCache = false;

    await this._setSourceFor(track, this._loadToken);

    // The element has already moved on to the new resource.
    if (previousBlob && previousBlob !== this._blobUrl) URL.revokeObjectURL(previousBlob);

    this.emit("srcstate", { track, status: "ready", offline: this._playingFromCache });

    const restore = () => {
      try {
        this.audio.currentTime = position;
      } catch {
        /* ignore */
      }
    };

    if (this.audio.readyState >= 1) restore();
    else this.audio.addEventListener("loadedmetadata", restore, { once: true });

    if (wasPlaying) await this.play();
  }

  _releaseBlob() {
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
  }

  _teardownAudio() {
    this._loadToken += 1;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this._releaseBlob();
    this._canonicalUrl = null;
    this._playingFromCache = false;
    this._updateMediaSession();
  }

  /* -------------------------------------------------------- native shell hook */

  /**
   * Hands playback state to the iOS/Android shell, which owns the audio session,
   * the lock-screen "now playing" entry and the remote-control commands.
   */
  _reportNative(state) {
    const bridge = window.__resonanceNative;
    if (!bridge || typeof bridge.onPlayback !== "function") return;

    const track = this.current;

    try {
      bridge.onPlayback({
        state,
        title: track?.title || "",
        artist: track?.artist || "",
        album: track?.album || "",
        artwork: absoluteUrl(track?.cover || track?.thumbnail || ""),
        duration: this.duration || track?.duration || 0,
        position: this.position,
        rate: 1
      });
    } catch {
      /* the shell is not listening */
    }
  }

  /**
   * Re-sends the current state to the native shell. Used after the system rebuilt
   * the audio pipeline (which wipes the lock-screen now-playing entry).
   */
  reportToShell() {
    this._reportNative(this.audio.paused ? "paused" : "playing");
  }

  /* -------------------------------------------------------- media session */

  _updateMediaSession() {
    if (!("mediaSession" in navigator)) return;

    const track = this.current;

    if (!track) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      return;
    }

    const cover = track.cover || track.thumbnail;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "Unknown track",
      artist: track.artist || "Unknown artist",
      album: track.album || "Resonance",
      artwork: cover
        ? [
            { src: cover, sizes: "96x96", type: "image/jpeg" },
            { src: cover, sizes: "192x192", type: "image/jpeg" },
            { src: cover, sizes: "512x512", type: "image/jpeg" }
          ]
        : []
    });

    const handlers = {
      play: () => this.play(),
      pause: () => this.pause(),
      stop: () => {
        this.pause();
        this.seekTo(0);
      },
      previoustrack: () => this.prev(),
      nexttrack: () => this.next(),
      seekbackward: (event) => this.seekBy(-(event?.seekOffset || 10)),
      seekforward: (event) => this.seekBy(event?.seekOffset || 10),
      seekto: (event) => {
        if (typeof event?.seekTime === "number") this.seekTo(event.seekTime);
      }
    };

    for (const [name, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(name, handler);
      } catch {
        /* unsupported action on this browser */
      }
    }

    this._updateSessionState();
  }

  _updateSessionState() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = this.audio.paused ? "paused" : "playing";
  }

  _updatePositionState() {
    if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;

    const duration = this.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: this.audio.playbackRate || 1,
        position: Math.min(this.position, duration)
      });
    } catch {
      /* ignore invalid states */
    }
  }

  /* ---------------------------------------------------------- visualiser */

  async enableVisualizer(canvas) {
    this._canvas = canvas;

    try {
      if (!this._audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        this._audioCtx = new Ctx();

        const source = this._audioCtx.createMediaElementSource(this.audio);
        let tail = source;

        try {
          this._analyser = this._audioCtx.createAnalyser();
          this._analyser.fftSize = 128;
          this._analyser.smoothingTimeConstant = 0.8;
          source.connect(this._analyser);
          tail = this._analyser;
        } catch {
          this._analyser = null;
        }

        tail.connect(this._audioCtx.destination);
      }

      await this._resumeAudioContext();
      this._startVisualizerLoop();
    } catch {
      // Falls back to plain element playback.
    }
  }

  async _resumeAudioContext() {
    if (this._audioCtx?.state === "suspended") {
      try {
        await this._audioCtx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  _startVisualizerLoop() {
    if (!this._analyser || !this._canvas || this._rafId) return;

    const canvas = this._canvas;
    const ctx = canvas.getContext("2d");
    const analyser = this._analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    // Safari/WKWebView < 16.4 has no CanvasRenderingContext2D.roundRect().
    const canRoundRect = typeof ctx.roundRect === "function";

    const draw = () => {
      this._rafId = requestAnimationFrame(draw);

      if (document.hidden || canvas.offsetParent === null) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      analyser.getByteFrequencyData(data);

      const bars = 28;
      const gap = 3;
      const barWidth = (width - gap * (bars - 1)) / bars;
      const step = Math.floor(data.length / bars);
      const gradient = ctx.createLinearGradient(0, height, 0, 0);
      gradient.addColorStop(0, "rgba(124, 92, 255, 0.65)");
      gradient.addColorStop(1, "rgba(255, 77, 141, 0.9)");
      ctx.fillStyle = gradient;

      for (let i = 0; i < bars; i += 1) {
        const value = data[i * step] / 255;
        const barHeight = Math.max(2, value * (height - 8));
        const x = i * (barWidth + gap);

        if (canRoundRect) {
          ctx.beginPath();
          ctx.roundRect(x, height - barHeight, barWidth, barHeight, 2);
          ctx.fill();
        } else {
          ctx.fillRect(x, height - barHeight, barWidth, barHeight);
        }
      }
    };

    this._rafId = requestAnimationFrame(draw);
  }

  stopVisualizer() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  /* ------------------------------------------------------------ persistence */

  _save({ position = false } = {}) {
    if (this._saveTimer && !position) return;

    const write = () => {
      try {
        localStorage.setItem(
          STATE_KEY,
          JSON.stringify({
            queue: this.queue,
            index: this.index,
            volume: this.volume,
            shuffle: this.shuffle,
            repeat: this.repeat,
            position: this.position,
            updatedAt: Date.now()
          })
        );
      } catch {
        /* storage full or unavailable */
      }
    };

    clearTimeout(this._saveTimer);

    if (position) {
      // Throttle position writes so we do not hammer localStorage.
      this._saveTimer = setTimeout(() => {
        this._saveTimer = 0;
        write();
      }, 5000);
      return;
    }

    this._saveTimer = 0;
    write();
  }

  _restore() {
    let state = null;

    try {
      state = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    } catch {
      state = null;
    }

    if (!state) {
      this.audio.volume = 1;
      return;
    }

    this.queue = Array.isArray(state.queue) ? state.queue.filter(Boolean) : [];
    this.index = Number.isInteger(state.index) ? Math.min(state.index, this.queue.length - 1) : this.queue.length ? 0 : -1;
    this.shuffle = Boolean(state.shuffle);
    this.repeat = ["off", "all", "one"].includes(state.repeat) ? state.repeat : "off";
    this.audio.volume = Number.isFinite(state.volume) ? state.volume : 1;
    this.audio.muted = this.audio.volume === 0;
    this._rebuildShuffleOrder();

    const track = this.current;

    if (track) {
      this._canonicalUrl = streamUrlFor(track);
      // Prepare the source (metadata only) so the mini player is accurate.
      this._setSourceFor(track, this._loadToken).then(() => {
        const position = Number.isFinite(state.position) ? state.position : 0;
        if (position > 0 && position < (track.duration || Infinity) - 5) {
          try {
            this.audio.currentTime = position;
          } catch {
            /* ignore */
          }
        }
      });
    }
  }
}

export const player = new Player();

/** Absolute URL for media that the native shell has to fetch itself. */
function absoluteUrl(url) {
  if (!url) return "";
  try {
    return new URL(url, location.href).href;
  } catch {
    return "";
  }
}

/**
 * Commands issued by the native shell's lock-screen / headset controls. A single
 * string entry point keeps the native `evaluateJavaScript` call trivial.
 */
window.__resonanceRemote = {
  command(name, value) {
    switch (name) {
      case "play":
        player.play();
        break;
      case "pause":
        player.pause();
        break;
      case "toggle":
        player.toggle();
        break;
      case "next":
        player.next();
        break;
      case "previous":
        player.prev();
        break;
      case "seek":
        if (Number.isFinite(value)) player.seekTo(value);
        break;
      case "seekBy":
        if (Number.isFinite(value)) player.seekBy(value);
        break;
      case "refresh":
        player.reportToShell();
        break;
      default:
        break;
    }
  }
};
