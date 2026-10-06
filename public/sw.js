// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// Encrypted contents in parts. A page hands this worker an item's body key
// (a CryptoKey, never its bytes) and gets back an address, <site>/k/stream/
// <token>, to give a <video> or a download link. Each request for it fetches
// only the sealed segments it needs (with Range), opens them as they arrive
// and answers with the contents: a video plays from where it is sought and
// a large file downloads without ever being whole in memory.
//
// Keys stay in this worker's memory. A browser may stop an idle worker; the
// page that asked is then asked again. The body format is the protocol's
// (see /k/protocol): segments of 65,536 bytes, each with a 16-byte AES-GCM
// tag and a nonce of its number, 1 marking the last.

const SEGMENT_BYTES = 65_536;
const TAG_BYTES = 16;
const SEALED_SEGMENT_BYTES = SEGMENT_BYTES + TAG_BYTES;
const STREAM_PATH = "k/stream/";

/**
 * What each token reads: { url, key, sealedSize, size, mime, filename }, url
 * being the sealed contents on the server.
 */
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

/** The segment's nonce: its number in 11 big-endian bytes, then 1 if it is the last. */
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

/** The stream a token names, asking the page that made it if this worker restarted since. */
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

/**
 * The contents' bytes [start, end] asked by a Range header, or the whole of
 * them; null when the range lies outside.
 */
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

/**
 * The contents [start, end], as a stream: the segments holding them are
 * fetched with one Range request, opened one by one as they arrive, and cut
 * to the bytes asked.
 */
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

/** A download's Content-Disposition, as the server writes them (RFC 6266). */
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
    "Content-Type": stream.mime || "application/octet-stream",
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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(`${scope.pathname}${STREAM_PATH}`)) {
    return;
  }
  const token = url.pathname.slice(scope.pathname.length + STREAM_PATH.length);
  event.respondWith(
    answer(
      event.request,
      event.clientId || event.resultingClientId,
      token,
      url.searchParams.has("download"),
    ).catch((error) => new Response(String(error?.message ?? error), { status: 502 })),
  );
});
