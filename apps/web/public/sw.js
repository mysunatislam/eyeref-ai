/* EyeRef service worker: makes the installed app open and run assessments offline.
 *
 * Caches only app code, static pages, icons, the bundled validation report and the
 * MediaPipe runtime/model. It never caches camera frames, results or any API call:
 * results live in the browser's own storage, and requests to the research API (another
 * origin) are not intercepted at all.
 */
const VERSION = "eyeref-v1";
const SHELL = [
  "/",
  "/assess",
  "/results",
  "/history",
  "/research",
  "/validation",
  "/calibration",
  "/vision-test",
  "/safety",
  "/dataset",
];
const MODEL_HOSTS = ["cdn.jsdelivr.net", "storage.googleapis.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = (await caches.match(req, { ignoreSearch: true })) || (await caches.match("/"));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    // MediaPipe WASM and face model only (versioned URLs, safe to keep)
    if (MODEL_HOSTS.includes(url.hostname) && /mediapipe|tasks-vision/.test(url.pathname)) {
      event.respondWith(cacheFirst(req));
    }
    return;
  }
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/mediapipe/")
  ) {
    event.respondWith(cacheFirst(req));
  } else if (
    req.mode === "navigate" ||
    url.pathname.startsWith("/reports/") ||
    url.searchParams.has("_rsc")
  ) {
    event.respondWith(networkFirst(req));
  }
});
