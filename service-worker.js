const CACHE_NAME = "merch-till-pwa-v14c";

const APP_SHELL = [
    "./",
    "./index.html",
    "./style.css?v=priority14c",
    "./manifest.webmanifest",
    "./icons/icon-180.png",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/icon-512-maskable.png",
    "./js/app.js?v=priority14c"
];

self.addEventListener("install", function (event) {
    self.skipWaiting();

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(function (cache) {
                return cache.addAll(APP_SHELL);
            })
    );
});

self.addEventListener("activate", function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (keys) {
                return Promise.all(
                    keys
                        .filter(function (key) {
                            return key !== CACHE_NAME;
                        })
                        .map(function (key) {
                            return caches.delete(key);
                        })
                );
            })
            .then(function () {
                return self.clients.claim();
            })
    );
});

self.addEventListener("fetch", function (event) {
    const request = event.request;

    if (
        request.method !== "GET" ||
        !request.url.startsWith(self.location.origin)
    ) {
        return;
    }

    const url = new URL(request.url);

    /*
     * Navigation is network-first. This helps the installed app pick up new
     * GitHub deployments, but still lets the Till open when offline.
     */
    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request)
                .then(function (response) {
                    const copy = response.clone();

                    caches.open(CACHE_NAME)
                        .then(function (cache) {
                            cache.put("./index.html", copy);
                        });

                    return response;
                })
                .catch(function () {
                    return caches.match("./index.html");
                })
        );

        return;
    }

    /*
     * Same-origin app assets: cache first, refresh in the background.
     * The Till's operational data remains governed by IndexedDB/Supabase;
     * this cache is only for the application shell.
     */
    event.respondWith(
        caches.match(request)
            .then(function (cached) {
                const networkFetch =
                    fetch(request)
                        .then(function (response) {
                            if (response && response.ok) {
                                const copy =
                                    response.clone();

                                caches.open(CACHE_NAME)
                                    .then(function (cache) {
                                        cache.put(
                                            request,
                                            copy
                                        );
                                    });
                            }

                            return response;
                        });

                return (
                    cached ||
                    networkFetch
                );
            })
    );
});
