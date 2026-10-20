// Small DOM + formatting helpers shared by the app.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Inline <svg> that references the sprite sheet in index.html. */
export function icon(name, className = "i") {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }

  return node;
}

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export function clockTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return fmtTime(seconds);
}

export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function fmtSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return `${fmtBytes(bytesPerSecond)}/s`;
}

export function fmtEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return `ETA ${fmtTime(seconds)}`;
}

export function fmtDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return date.toLocaleDateString();
}

/** Deterministic gradient + initials used when a track has no cover art. */
export function placeholderCover(seed = "") {
  const text = String(seed || "?");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }

  const hue = hash;
  const initials = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("") || "♪";

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue} 62% 34%)"/><stop offset="1" stop-color="hsl(${(hue + 58) % 360} 66% 20%)"/>
</linearGradient></defs>
<rect width="180" height="180" fill="url(#g)"/>
<text x="90" y="90" fill="rgba(255,255,255,0.86)" font-family="system-ui, sans-serif" font-size="66" font-weight="700"
 text-anchor="middle" dominant-baseline="central">${initials.replace(/[<>&]/g, "")}</text></svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Sets an <img> source and flags it "loaded" once it can be painted. */
export function setCover(img, url, seed) {
  if (!img) return;

  if (!url) {
    img.removeAttribute("src");
    img.classList.remove("loaded");
    return;
  }

  img.addEventListener(
    "error",
    () => {
      img.src = placeholderCover(seed);
      img.classList.add("loaded");
    },
    { once: true }
  );

  img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
  img.src = url;
}

let toastTimer = null;

export function toast(message, { actionLabel, onAction, timeout = 4200 } = {}) {
  const node = $("#toast");
  node.innerHTML = "";
  node.append(el("span", { text: message }));

  if (actionLabel) {
    node.append(
      el("button", {
        text: actionLabel,
        onclick: () => {
          hideToast();
          onAction?.();
        }
      })
    );
  }

  node.hidden = false;
  clearTimeout(toastTimer);

  if (timeout > 0) {
    toastTimer = setTimeout(hideToast, timeout);
  }
}

export function hideToast() {
  const node = $("#toast");
  if (node) node.hidden = true;
}

let closeMenuHandler = null;

/** Floating action menu anchored to an element (or to explicit coordinates). */
export function openMenu(target, items, { title } = {}) {
  closeMenu();

  const menu = $("#menu");
  menu.innerHTML = "";

  if (title) menu.append(el("div", { class: "menu-title", text: title }));

  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      menu.append(el("div", { class: "menu-title", text: item.separator }));
      continue;
    }
    menu.append(
      el("button", {
        class: item.danger ? "danger" : "",
        role: "menuitem",
        html: `${item.icon ? icon(item.icon) : ""}<span></span>`,
        onclick: () => {
          closeMenu();
          item.onSelect?.();
        }
      })
    );
    const label = menu.lastElementChild.querySelector("span");
    if (label) label.textContent = item.label;
  }

  menu.hidden = false;

  const rect = target instanceof Element ? target.getBoundingClientRect() : { left: target.x, right: target.x, top: target.y, bottom: target.y, width: 0 };
  const menuRect = menu.getBoundingClientRect();
  const margin = 8;

  let left = Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - margin);
  left = Math.max(margin, left);
  let top = rect.bottom + 6;

  if (top + menuRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - menuRect.height - 6);
  }

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  closeMenuHandler = (event) => {
    if (!menu.contains(event.target)) closeMenu();
  };

  setTimeout(() => {
    document.addEventListener("pointerdown", closeMenuHandler);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
  }, 0);
}

export function closeMenu() {
  const menu = $("#menu");
  if (menu) menu.hidden = true;

  if (closeMenuHandler) {
    document.removeEventListener("pointerdown", closeMenuHandler);
    window.removeEventListener("resize", closeMenu);
    window.removeEventListener("scroll", closeMenu, true);
    closeMenuHandler = null;
  }
}

/** Promise-based text prompt rendered in the app's own modal. */
export function promptDialog({ title, value = "", placeholder = "", confirmLabel = "Save" }) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    const input = el("input", { type: "text", value, placeholder, autocomplete: "off" });
    const card = el("div", { class: "modal-card" }, [
      el("h3", { text: title }),
      input,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn ghost", text: "Cancel", onclick: () => done(null) }),
        el("button", { class: "btn primary", text: confirmLabel, onclick: () => done(input.value.trim() || null) })
      ])
    ]);

    function done(result) {
      modal.hidden = true;
      modal.innerHTML = "";
      resolve(result);
    }

    modal.innerHTML = "";
    modal.append(card);
    modal.hidden = false;
    modal.onpointerdown = (event) => {
      if (event.target === modal) done(null);
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") done(input.value.trim() || null);
      if (event.key === "Escape") done(null);
    });

    input.focus();
    input.select?.();
  });
}

export function confirmDialog({ title, message, confirmLabel = "Delete" }) {
  return new Promise((resolve) => {
    const modal = $("#modal");
    const card = el("div", { class: "modal-card" }, [
      el("h3", { text: title }),
      message ? el("p", { class: "row-sub", text: message }) : null,
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn ghost", text: "Cancel", onclick: () => done(false) }),
        el("button", { class: "btn primary", text: confirmLabel, onclick: () => done(true) })
      ])
    ]);

    function done(result) {
      modal.hidden = true;
      modal.innerHTML = "";
      resolve(result);
    }

    modal.innerHTML = "";
    modal.append(card);
    modal.hidden = false;
    modal.onpointerdown = (event) => {
      if (event.target === modal) done(false);
    };
  });
}

export function emptyState(text, hint = "") {
  return el("li", { class: "empty" }, [
    el("div", { html: icon("music"), class: "" }),
    el("strong", { text }),
    hint ? el("p", { text: hint }) : null
  ]);
}

/** Runs async tasks with a small concurrency cap (used for lazy metadata). */
export function pool(items, limit, worker) {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      try {
        await worker(item);
      } catch {
        /* keep going */
      }
    }
  });
  return Promise.all(runners);
}
