// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Encrypted contents in parts: a page hands over a body key (a CryptoKey,
// never its bytes) and gets an address for a <video> or a download. Each
// request fetches only the segments it needs, so videos seek and large files
// never sit whole in memory. Keys live only in this worker's memory; a
// restarted worker asks the page again.

const SEGMENT_BYTES = 65_536;
const TAG_BYTES = 16;
const SEALED_SEGMENT_BYTES = SEGMENT_BYTES + TAG_BYTES;
const STREAM_PATH = "k/stream/";
/** Kept on the device until a page takes it, so a share never reaches the server. */
const SHARE_PATH = "k/share";
const SHARE_CACHE = "kurobako-shares";
const SHARE_TTL_MS = 24 * 60 * 60 * 1000;

const streams = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const { type, token, stream } = event.data ?? {};
  if (type === "stream" && token && stream) {
    streams.set(token, stream);
    event.ports[0]?.postMessage({ ok: true });
  }
  if (type === "forget" && token) streams.delete(token);
});

const nonceOf = (index, last) => {
  const nonce = new Uint8Array(12);
  let rest = index;
  for (let at = 10; at >= 0 && rest > 0; at -= 1) {
    nonce[at] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  nonce[11] = last ? 1 : 0;
  return nonce;
};

/** A browser may stop an idle worker; the page that made the token is asked again. */
const streamOf = async (token, clientId) => {
  const known = streams.get(token);
  if (known) return known;
  const client = clientId ? await self.clients.get(clientId) : null;
  const pages = client ? [client] : await self.clients.matchAll({ type: "window" });
  for (const page of pages) {
    const channel = new MessageChannel();
    const answer = new Promise((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data?.stream ?? null);
      setTimeout(() => resolve(null), 2000);
    });
    page.postMessage({ type: "stream-needed", token }, [channel.port2]);
    const stream = await answer;
    if (stream) {
      streams.set(token, stream);
      return stream;
    }
  }
  return null;
};

const rangeOf = (header, size) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return { start: 0, end: size - 1, partial: false };
  if (!match[1]) {
    const length = Math.min(Number(match[2]), size);
    return length > 0 ? { start: size - length, end: size - 1, partial: true } : null;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start < size && start <= end ? { start, end, partial: true } : null;
};

/** One Range request, opened segment by segment as it arrives. */
const openedStream = (stream, start, end) => {
  const count = Math.ceil(stream.sealedSize / SEALED_SEGMENT_BYTES);
  const first = Math.floor(start / SEGMENT_BYTES);
  const last = Math.floor(end / SEGMENT_BYTES);
  const from = first * SEALED_SEGMENT_BYTES;
  const to = Math.min((last + 1) * SEALED_SEGMENT_BYTES, stream.sealedSize) - 1;
  let reader = null;
  let pending = new Uint8Array(0);
  let index = first;

  const openSegment = async (sealed) => {
    const opened = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonceOf(index, index === count - 1) },
        stream.key,
        sealed,
      ),
    );
    // Only the asked bytes of the first and last segments.
    const offset = index * SEGMENT_BYTES;
    const cut = opened.subarray(
      Math.max(0, start - offset),
      Math.min(opened.length, end - offset + 1),
    );
    index += 1;
    return cut;
  };

  return new ReadableStream({
    async start() {
      const response = await fetch(stream.url, {
        headers: { Range: `bytes=${from}-${to}` },
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok || !response.body)
        throw new Error(`The server answered ${response.status}.`);
      reader = response.body.getReader();
    },
    async pull(controller) {
      while (true) {
        const size =
          index === count - 1
            ? stream.sealedSize - index * SEALED_SEGMENT_BYTES
            : SEALED_SEGMENT_BYTES;
        if (index > last) {
          controller.close();
          await reader.cancel().catch(() => {});
          return;
        }
        if (pending.length >= size) {
          const sealed = pending.slice(0, size);
          pending = pending.subarray(size);
          controller.enqueue(await openSegment(sealed));
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.error(new Error("The contents ended early."));
          return;
        }
        const joined = new Uint8Array(pending.length + value.length);
        joined.set(pending);
        joined.set(value, pending.length);
        pending = joined;
      }
    },
    cancel() {
      return reader?.cancel();
    },
  });
};

/** As the server writes them (RFC 6266). */
const attachment = (filename) => {
  const ascii = filename.normalize("NFKD").replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

const answer = async (request, clientId, token, download) => {
  const stream = await streamOf(token, clientId);
  if (!stream) return new Response("This page no longer holds that item's key.", { status: 404 });
  const range = rangeOf(request.headers.get("range"), stream.size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${stream.size}` },
    });
  }
  const headers = {
    // The sender chose the type: as on the server, nothing in it may run here.
    "Content-Type": stream.mime || "application/octet-stream",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(range.end - range.start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stream.size}`;
  if (download) headers["Content-Disposition"] = attachment(stream.filename || "file");
  return new Response(openedStream(stream, range.start, range.end), {
    status: range.partial ? 206 : 200,
    headers,
  });
};

const forgetOldShares = async (cache) => {
  const requests = await cache.keys();
  const stale = [];
  for (const request of requests) {
    const id = /\/k\/share\/([0-9a-f]{32})$/.exec(new URL(request.url).pathname)?.[1];
    if (!id) continue;
    const details = await (await cache.match(request))?.json().catch(() => null);
    if (!details || Date.now() - details.at > SHARE_TTL_MS) stale.push(id);
  }
  await Promise.all(
    requests
      .filter((request) => stale.some((id) => request.url.includes(`/k/share/${id}`)))
      .map((request) => cache.delete(request)),
  );
};

const keepShare = async (request, scope) => {
  const form = await request.formData();
  const field = (name) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const files = form.getAll("files").filter((value) => typeof value !== "string" && value.size);
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const address = `${scope}${SHARE_PATH}/${id}`;
  const cache = await caches.open(SHARE_CACHE);
  await forgetOldShares(cache);
  await Promise.all(
    files.map((file, index) =>
      cache.put(
        `${address}/${index}`,
        new Response(file, {
          headers: { "Content-Type": file.type || "application/octet-stream" },
        }),
      ),
    ),
  );
  // Written last: a share whose details are there has all its files.
  await cache.put(
    address,
    Response.json({
      title: field("title"),
      text: field("text"),
      url: field("url"),
      files: files.map((file) => ({ name: file.name, type: file.type })),
      at: Date.now(),
    }),
  );
  return Response.redirect(`${scope}${SHARE_PATH}?id=${id}`, 303);
};

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);
  if (event.request.method === "POST" && path === SHARE_PATH) {
    event.respondWith(
      keepShare(event.request, scope.href).catch(() =>
        Response.redirect(`${scope.href}${SHARE_PATH}?lost`, 303),
      ),
    );
    return;
  }
  if (!path.startsWith(STREAM_PATH)) return;
  const token = path.slice(STREAM_PATH.length);
  event.respondWith(
    answer(
      event.request,
      event.clientId || event.resultingClientId,
      token,
      url.searchParams.has("download"),
    ).catch((error) => new Response(String(error?.message ?? error), { status: 502 })),
  );
});

// --- Push notifications (src/core/push.ts) ---------------------------------

const PUSH_CACHE = "kurobako-push";

const notify = async (message) => {
  const scope = self.registration.scope;
  const key = message ? `${message.space}:${message.name}` : "";
  const followed = key
    ? await (await (await caches.open(PUSH_CACHE)).match(`${scope}k/push/${key}`))
        ?.json()
        .catch(() => null)
    : null;
  // Browsers insist a push shows something, even for a namespace no longer followed.
  await self.registration.showNotification(followed?.title ?? "Kurobako", {
    body: message?.preview ?? (message?.kind === "file" ? "New file" : "New item"),
    // One per namespace: a newer send replaces it.
    tag: key || "kurobako",
    renotify: true,
    icon: `${scope}icon-192.png`,
    data: { url: followed?.url ?? scope, id: message?.id ?? null },
  });
};

self.addEventListener("push", (event) => {
  let message = null;
  try {
    message = event.data?.json() ?? null;
  } catch {}
  event.waitUntil(notify(message));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url, id } = event.notification.data ?? {};
  const target = new URL(url ?? self.registration.scope);
  if (id) target.searchParams.set("copy", id);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Rather than another copy of the page.
      const open = windows.find((client) => {
        const shown = new URL(client.url);
        return shown.pathname === target.pathname && shown.hash === target.hash;
      });
      if (open) {
        await open.focus();
        await open.navigate(target.href).catch(() => {});
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
