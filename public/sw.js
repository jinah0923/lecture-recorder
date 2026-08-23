// Minimal static-asset cache — just enough for install-ability and instant
// repeat loads of the app shell. Deliberately NOT a full offline/app-shell
// strategy: this is a client-rendered SPA backed by IndexedDB, and the
// Gemini/Notion API calls below must always hit the network live.
const CACHE_NAME = "lecture-recorder-static-v1";

// Matches only same-origin static assets — Next's hashed build output
// (/_next/static/...), the manifest, and app icons.
const STATIC_ASSET_PATTERNS = [/^\/_next\/static\//, /^\/icons\//, /^\/manifest\.webmanifest$/];

function isStaticAsset(url) {
  return url.origin === self.location.origin && STATIC_ASSET_PATTERNS.some((pattern) => pattern.test(url.pathname));
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // [중요] Gemini 분석, 노션 연동 등 /api/* 요청은 절대 캐시하지 않고 네트워크로
  // 직접 통과시킨다 (NetworkOnly) — respondWith를 호출하지 않으면 이 서비스
  // 워커는 완전히 관여하지 않고 브라우저가 기본 fetch를 그대로 수행한다.
  if (url.pathname.startsWith("/api/")) return;

  if (!isStaticAsset(url)) return;

  // Cache-first: static, content-hashed assets never change under the same
  // URL, so a cache hit is always safe to serve without revalidation.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    }),
  );
});
