// Identity + sharing for the web app.
//
// A username is NOT authentication — it only selects which library the server
// shows you (`x-resonance-user` header, or `?user=` on media URLs, since
// <audio>/<img> cannot send headers). It is remembered per browser.

import { el, toast } from "./util.js";

const USER_KEY = "resonance.user";

export function currentUser() {
  try {
    return (localStorage.getItem(USER_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function setCurrentUser(name) {
  const clean = String(name || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");

  try {
    if (clean) localStorage.setItem(USER_KEY, clean);
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* private mode */
  }

  window.dispatchEvent(new CustomEvent("resonance:user", { detail: clean }));
  return clean;
}

export function identityHeaders() {
  const user = currentUser();
  return user ? { "x-resonance-user": user } : {};
}

/** Appends the identity to a media URL so plain <audio>/<img> can use it. */
export function withUser(url) {
  if (!url || typeof url !== "string") return url || null;

  const user = currentUser();
  if (!user) return url;
  if (/[?&]user=/.test(url)) return url;

  const [head, hash = ""] = url.split("#");
  const joiner = head.includes("?") ? "&" : "?";
  return `${head}${joiner}user=${encodeURIComponent(user)}${hash ? `#${hash}` : ""}`;
}

/** fetch() with the identity header, JSON in/out, errors surfaced. */
export async function apiFetch(path, options = {}) {
  const headers = { ...identityHeaders(), ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error(data?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }

  return data;
}

/* ------------------------------------------------------------------- users */

export const listUsers = () => apiFetch("/api/users");

export const createUser = (name) =>
  apiFetch("/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name })
  });

/* ------------------------------------------------------------------ shares */

export const listShares = () => apiFetch("/api/shares");

export const shareTrack = (trackPath, to, note) =>
  apiFetch("/api/share", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trackPath, to, note: note || undefined })
  });

export const revokeShare = (id) => apiFetch(`/api/shares/${id}`, { method: "DELETE" });

export const importShare = (id) => apiFetch(`/api/shares/${id}/import`, { method: "POST" });

/* ----------------------------------------------------------------- dialogs */

function openModalCard(card, onDismiss) {
  const modal = document.querySelector("#modal");
  modal.innerHTML = "";
  modal.append(card);
  modal.hidden = false;
  modal.onpointerdown = (event) => {
    if (event.target === modal) onDismiss();
  };
  return modal;
}

function closeModal() {
  const modal = document.querySelector("#modal");
  if (!modal) return;
  modal.hidden = true;
  modal.innerHTML = "";
  modal.onpointerdown = null;
}

/**
 * Pick one of `options` (strings or {value,label,meta}) or type a new one.
 * Resolves with the chosen value, or null when dismissed.
 */
export function chooseFrom({ title, message, options = [], allowNew = false, newLabel = "New…", placeholder = "Name" }) {
  return new Promise((resolve) => {
    const finish = (value) => {
      closeModal();
      resolve(value || null);
    };

    const card = el("div", { class: "modal-card" });

    const body = el("div", { class: "chooser-list" });

    for (const option of options) {
      const value = typeof option === "string" ? option : option.value;
      const label = typeof option === "string" ? option : option.label || option.value;
      const meta = typeof option === "string" ? "" : option.meta || "";

      body.append(
        el("button", {
          class: "chooser-row",
          onclick: () => finish(value),
          html: `<span class="chooser-name"></span><span class="chooser-meta"></span>`
        })
      );

      const row = body.lastElementChild;
      row.querySelector(".chooser-name").textContent = label;
      row.querySelector(".chooser-meta").textContent = meta;
    }

    const actions = el("div", { class: "modal-actions" }, [
      el("button", { class: "btn ghost", text: "Cancel", onclick: () => finish(null) }),
      allowNew
        ? el("button", {
            class: "btn soft",
            text: newLabel,
            onclick: () => {
              card.innerHTML = "";
              buildNewForm();
            }
          })
        : null
    ]);

    const buildNewForm = () => {
      const input = el("input", { type: "text", placeholder, autocomplete: "off", spellcheck: "false" });
      const error = el("p", { class: "row-sub chooser-error", hidden: "hidden" });

      const submit = async () => {
        const name = input.value.trim();
        if (!name) return;

        try {
          const created = await createUser(name);
          finish(created.name);
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      };

      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
        if (event.key === "Escape") finish(null);
      });

      card.append(
        el("h3", { text: "Your name" }),
        el("p", { class: "row-sub", text: "Letters, digits, dots, dashes and underscores. Each name gets its own library." }),
        input,
        error,
        el("div", { class: "modal-actions" }, [
          el("button", { class: "btn ghost", text: "Back", onclick: () => finish(null) }),
          el("button", { class: "btn primary", text: "Use this name", onclick: submit })
        ])
      );

      input.focus();
    };

    card.append(el("h3", { text: title }), message ? el("p", { class: "row-sub", text: message }) : null, body, actions);
    openModalCard(card, () => finish(null));

    if (!options.length && allowNew) {
      card.innerHTML = "";
      buildNewForm();
    }
  });
}

/** Ask who is listening; returns the username or null when dismissed. */
export async function chooseUser() {
  let users = [];
  let defaultUser = "";

  try {
    const data = await listUsers();
    users = data.users || [];
    defaultUser = data.defaultUser || "";
  } catch {
    return null;
  }

  const picked = await chooseFrom({
    title: "Who's listening?",
    message: users.length
      ? "Pick your library, or add a new name. Everyone on this server gets their own library and can share songs with each other."
      : "Add a name to start your own library.",
    options: users.map((user) => ({
      value: user.name,
      label: user.name,
      meta: `${user.tracks} ${user.tracks === 1 ? "song" : "songs"}${user.isDefault ? " · server owner" : ""}`
    })),
    allowNew: true,
    newLabel: "New name…"
  });

  if (picked) {
    setCurrentUser(picked);
    return picked;
  }

  return null;
}

/** Share one track: pick a person (or everyone), add an optional note. */
export async function shareTrackDialog(track, { me } = {}) {
  let users = [];

  try {
    const data = await listUsers();
    users = (data.users || []).filter((user) => user.name !== me);
  } catch (error) {
    toast(error.message);
    return false;
  }

  const options = [
    { value: "*", label: "Everyone", meta: "anyone on this server" },
    ...users.map((user) => ({ value: user.name, label: user.name, meta: `${user.tracks} ${user.tracks === 1 ? "song" : "songs"}` }))
  ];

  const who = await chooseFrom({
    title: `Share “${track.title || track.path}”`,
    message: users.length ? "They will find it under Shared with me." : "There is nobody else here yet — share with everyone, or add a name from the user chip.",
    options,
    allowNew: true,
    newLabel: "New name…"
  });

  if (!who) return false;

  try {
    await shareTrack(track.path, who);
    toast(who === "*" ? "Shared with everyone" : `Shared with ${who}`);
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}
