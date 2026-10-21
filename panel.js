const FLAGS = { es: "🇪🇸", en: "🇬🇧", pt: "🇧🇷", fr: "🇫🇷", de: "🇩🇪" };

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const consent = $("authorized");

let lang = "es";
let tabId = null;
let state = { placeKey: null, placeName: "", photos: [] };
let currentPlace = null;
let busy = false;
let viewedKey = null;

const selected = new Set();
const thumbs = new Map(); // key -> elemento

function t(key, vars = {}) {
  const text = LANGS[lang][key] || LANGS.es[key] || key;
  return text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

// --- Idioma ---

function applyLanguage() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-html]").forEach((el) => (el.innerHTML = t(el.dataset.i18nHtml)));
  document.querySelectorAll(".thumb .open").forEach((el) => (el.textContent = t("details")));
  $("flag").textContent = FLAGS[lang];
  $("language").value = lang;
  render();
}

chrome.storage.local.get("uiLanguage").then(({ uiLanguage }) => {
  if (LANGS[uiLanguage]) lang = uiLanguage;
  applyLanguage();
});

$("language").addEventListener("change", (e) => {
  lang = e.target.value;
  chrome.storage.local.set({ uiLanguage: lang });
  applyLanguage();
});

$("version").textContent = "v" + chrome.runtime.getManifest().version;

// --- Galería ---

function updateButtons() {
  $("selected").textContent = `${selected.size} ${t("selected")}`;
  $("download").disabled = busy || !selected.size || !consent.checked || tabId === null;
  $("download").textContent = busy ? t("starting") : t("download", { n: selected.size });
}

function toggle(key) {
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  thumbs.get(key)?.classList.toggle("selected", selected.has(key));
  updateButtons();
}

function createThumb(photo) {
  const el = document.createElement("div");
  el.className = "thumb";
  el.tabIndex = 0;

  const img = document.createElement("img");
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.src = photo.thumb;

  const check = document.createElement("span");
  check.className = "check";
  check.textContent = "✓";

  const open = document.createElement("button");
  open.type = "button";
  open.className = "open";
  open.textContent = t("details");
  open.addEventListener("click", (e) => {
    e.stopPropagation();
    showViewer(photo);
  });

  el.append(img, check, open);
  el.addEventListener("click", () => toggle(photo.key));
  el.addEventListener("keydown", (e) => {
    if (e.target === el && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      toggle(photo.key);
    }
  });
  return el;
}

function render() {
  if (state.placeKey !== currentPlace) {
    currentPlace = state.placeKey;
    selected.clear();
    thumbs.clear();
    grid.replaceChildren();
    $("status").textContent = "";
  }

  $("place").textContent = state.placeName || t("place");
  $("count").textContent = `${state.photos.length} ${t("photos")}`;

  if (!state.placeKey) $("empty").textContent = t("empty");
  else $("empty").textContent = state.photos.length ? "" : t("emptyPlace");

  const keys = new Set(state.photos.map((p) => p.key));
  for (const [key, el] of thumbs) {
    if (!keys.has(key)) {
      el.remove();
      thumbs.delete(key);
      selected.delete(key);
    }
  }
  for (const photo of state.photos) {
    if (!thumbs.has(photo.key)) {
      const el = createThumb(photo);
      thumbs.set(photo.key, el);
      grid.append(el);
    }
  }
  updateButtons();
}

async function refresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = tab?.id ?? null;
    if (id !== tabId) {
      tabId = id;
      state = { placeKey: null, placeName: "", photos: [] };
    }
    if (tabId !== null) {
      const next = await chrome.runtime.sendMessage({ type: "getState", tabId });
      if (next) state = next;
    }
    render();
  } catch (e) {
    $("status").textContent = t("updateError", { e: e.message });
  }
}

// --- Visor ---

function showViewer(photo) {
  viewedKey = photo.key;
  const img = $("viewerImg");
  img.removeAttribute("src");
  $("viewerInfo").textContent = t("loading");
  $("viewerOpen").href = photo.full;
  $("viewerSelect").textContent = t(selected.has(photo.key) ? "deselect" : "select");

  img.onload = () => {
    if (viewedKey === photo.key) {
      $("viewerInfo").textContent = t("resolution", { w: img.naturalWidth, h: img.naturalHeight });
    }
  };
  img.onerror = () => ($("viewerInfo").textContent = t("imageError"));
  img.referrerPolicy = "no-referrer";
  img.src = photo.full;
  $("viewer").showModal();
}

$("closeViewer").addEventListener("click", () => $("viewer").close());
$("viewer").addEventListener("close", () => {
  viewedKey = null;
  $("viewerImg").removeAttribute("src");
});
$("viewerSelect").addEventListener("click", () => {
  toggle(viewedKey);
  $("viewerSelect").textContent = t(selected.has(viewedKey) ? "deselect" : "select");
});

// --- Botones ---

document.querySelector(".legal strong").addEventListener("click", () => {
  document.querySelector(".legal").classList.toggle("expanded");
});

$("all").addEventListener("click", () => {
  for (const [key, el] of thumbs) {
    selected.add(key);
    el.classList.add("selected");
  }
  updateButtons();
});

$("none").addEventListener("click", () => {
  selected.clear();
  thumbs.forEach((el) => el.classList.remove("selected"));
  updateButtons();
});

$("clear").addEventListener("click", async () => {
  if (tabId === null || !confirm(t("confirmClear"))) return;
  await chrome.runtime.sendMessage({ type: "clear", tabId });
  await refresh();
});

consent.addEventListener("change", updateButtons);

$("download").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  updateButtons();
  try {
    const res = await chrome.runtime.sendMessage({ type: "download", tabId, keys: [...selected] });
    if (!res?.ok) throw new Error(res?.error || "?");

    const ids = res.jobs.filter((j) => j.id !== undefined).map((j) => j.id);
    const failed = res.jobs.length - ids.length;
    if (!ids.length) throw new Error(res.jobs[0]?.error || "?");

    let tries = 0;
    const check = async () => {
      try {
        const { results } = await chrome.runtime.sendMessage({ type: "downloadStatus", ids });
        const done = results.filter((r) => r.state === "complete").length;
        const interrupted = results.filter((r) => r.state === "interrupted").length;
        const running = ids.length - done - interrupted;
        $("status").textContent = t("completed", { c: done, f: interrupted + failed, r: running });
        if (running > 0 && tries++ < 40) setTimeout(check, 1500);
      } catch (e) {
        $("status").textContent = t("statusError", { e: e.message });
      }
    };
    check();
  } catch (e) {
    $("status").textContent = t("downloadError", { e: e.message });
  } finally {
    busy = false;
    updateButtons();
  }
});

refresh();
setInterval(refresh, 1200);
