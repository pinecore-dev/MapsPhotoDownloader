// Busca fotos en la página por si alguna vino de la caché
// y no pasó por webRequest.

(() => {
  const URL_RE = /https?:\/\/[^"')\s]*(?:googleusercontent\.com|ggpht\.com)[^"')\s]*/g;
  let timer = null;
  let lastSignature = "";

  function placeKey() {
    const m = location.pathname.match(/\/maps\/place\/([^/]+)/);
    return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
  }

  function scan() {
    const key = placeKey();
    if (!key) return;

    const urls = new Set();
    document.querySelectorAll("img[src]").forEach((img) => {
      if (/googleusercontent\.com|ggpht\.com/.test(img.src)) urls.add(img.src);
    });
    document.querySelectorAll('[style*="background-image"]').forEach((el) => {
      (el.style.backgroundImage.match(URL_RE) || []).forEach((u) => urls.add(u));
    });

    const list = [...urls];
    const signature = key + "|" + list.length + "|" + list.slice(-3).join("|");
    if (signature === lastSignature) return;
    lastSignature = signature;

    const h1 = document.querySelector('div[role="main"] h1') || document.querySelector("h1");
    const name = h1?.textContent.trim() || key;

    try {
      chrome.runtime.sendMessage({ type: "domPhotos", placeKey: key, placeName: name, urls: list }).catch(() => {});
    } catch {
      observer.disconnect(); // se recargó la extensión
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 700);
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "style"]
  });

  scan();
})();
