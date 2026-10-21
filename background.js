// Junta las fotos del lugar abierto en Maps, por pestaña.
// Llegan por dos lados: las peticiones de red (webRequest) y content.js,
// que encuentra las que salieron de la caché.

const PHOTO_HOST_RE = /(^|\.)(googleusercontent\.com|ggpht\.com)$/;
const AVATAR_PATH_RE = /^\/(a|a-|ogw)\//; // fotos de perfil, no del lugar

const ICONS = {
  idle: { 16: "icons/idle-16.png", 32: "icons/idle-32.png", 48: "icons/idle-48.png", 128: "icons/idle-128.png" },
  active: { 16: "icons/active-16.png", 32: "icons/active-32.png", 48: "icons/active-48.png", 128: "icons/active-128.png" }
};

function placeKeyFromUrl(url) {
  const m = new URL(url).pathname.match(/\/maps\/place\/([^/]+)/);
  return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
}

// .../p/AF1Qip...=w408-h306-k-no  ->  "=s0" da la resolución original
function parsePhoto(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!PHOTO_HOST_RE.test(u.hostname) || AVATAR_PATH_RE.test(u.pathname)) return null;

  const path = u.pathname.split("=")[0];
  const id = path.split("/").pop();
  if (!id || id.length < 20) return null; // íconos y cosas chicas

  const base = `https://${u.hostname}${path}`;
  return {
    key: u.hostname.replace(/^lh\d+\./, "lh.") + path, // lh3 y lh5 son la misma foto
    thumb: `${base}=w320-h320-k-no`,
    full: `${base}=s0`
  };
}

// --- Estado por pestaña ---

const states = new Map();
let queue = Promise.resolve();

// Todo pasa por una cola para que los eventos no se pisen entre sí.
function enqueue(fn) {
  queue = queue.then(fn).catch((err) => console.error(err));
  return queue;
}

const emptyState = () => ({ placeKey: null, placeName: "", photos: [] });

async function loadState(tabId) {
  if (!states.has(tabId)) {
    const k = `tab_${tabId}`;
    const stored = (await chrome.storage.session.get(k))[k];
    states.set(tabId, stored || emptyState());
  }
  return states.get(tabId);
}

async function saveState(tabId, s) {
  states.set(tabId, s);
  await chrome.storage.session.set({ [`tab_${tabId}`]: s });

  const n = s.photos.length;
  try {
    await chrome.action.setIcon({ tabId, path: n ? ICONS.active : ICONS.idle });
    await chrome.action.setBadgeText({ tabId, text: n ? String(Math.min(n, 999)) : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1e8e3e" });
  } catch {
    // la pestaña se cerró
  }
}

function addPhotos(s, urls) {
  const known = new Set(s.photos.map((p) => p.key));
  let added = 0;
  for (const url of urls) {
    const p = parsePhoto(url);
    if (p && !known.has(p.key)) {
      known.add(p.key);
      s.photos.push(p);
      added++;
    }
  }
  return added;
}

async function setPlace(tabId, placeKey, placeName) {
  const s = await loadState(tabId);
  if (s.placeKey === placeKey) {
    if (placeName && placeName !== s.placeName) {
      s.placeName = placeName;
      await saveState(tabId, s);
    }
    return s;
  }
  const fresh = { placeKey, placeName: placeName || placeKey || "", photos: [] };
  await saveState(tabId, fresh);
  return fresh;
}

// --- Eventos ---

chrome.tabs.onUpdated.addListener((tabId, { url }) => {
  if (!url) return;
  enqueue(async () => {
    const key = placeKeyFromUrl(url);
    if (key) await setPlace(tabId, key);
    else await saveState(tabId, emptyState());
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  states.delete(tabId);
  chrome.storage.session.remove(`tab_${tabId}`);
});

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode !== 200) return;
    enqueue(async () => {
      const s = await loadState(details.tabId);
      if (s.placeKey && addPhotos(s, [details.url])) await saveState(details.tabId, s);
    });
  },
  {
    urls: ["*://*.googleusercontent.com/*", "*://*.ggpht.com/*"],
    types: ["image", "xmlhttprequest", "other"]
  }
);

async function download(tabId, keys) {
  const s = await loadState(tabId);
  const wanted = new Set(keys || []);
  const { nextDownloadNumber } = await chrome.storage.local.get("nextDownloadNumber");
  let n = Math.max(1, Number(nextDownloadNumber) || 1);
  const jobs = [];

  for (const p of s.photos.filter((p) => wanted.has(p.key))) {
    try {
      const id = await chrome.downloads.download({
        url: p.full,
        filename: `MapsPhotoDownloader${String(n).padStart(4, "0")}.jpg`,
        conflictAction: "uniquify"
      });
      jobs.push({ id });
      n++;
    } catch (e) {
      jobs.push({ error: e.message || String(e) });
    }
  }
  await chrome.storage.local.set({ nextDownloadNumber: n });
  return { ok: true, jobs };
}

async function downloadStatus(ids) {
  const results = await Promise.all(
    ids.map(async (id) => {
      const [item] = await chrome.downloads.search({ id });
      return { id, state: item?.state || "unknown" };
    })
  );
  return { results };
}

// Mensajes de content.js y del panel lateral.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "domPhotos":
      if (!sender.tab) return false;
      enqueue(async () => {
        const s = await setPlace(sender.tab.id, msg.placeKey, msg.placeName);
        if (addPhotos(s, msg.urls)) await saveState(sender.tab.id, s);
      });
      return false;

    case "getState":
      enqueue(async () => sendResponse(await loadState(msg.tabId)));
      return true;

    case "download":
      enqueue(() =>
        download(msg.tabId, msg.keys)
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: e.message }))
      );
      return true;

    case "downloadStatus":
      downloadStatus(msg.ids || []).then(sendResponse);
      return true;

    case "clear":
      enqueue(async () => {
        const s = await loadState(msg.tabId);
        s.photos = [];
        await saveState(msg.tabId, s);
        sendResponse({ ok: true });
      });
      return true;
  }
  return false;
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
