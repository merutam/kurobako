// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
// Source and license: https://github.com/merutam/kurobako

// End-to-end encryption for /e#name namespaces: the one implementation of
// /k/protocol. Pages import it, and it is a command-line client too (Node 20+
// or Bun, no dependencies), taking curl's own options and paths:
//
//   curl -O https://<site>/k.mjs
//   node k.mjs https://<site>/e#<name>/ls
//   node k.mjs -d 'hello' https://<site>/e#<name>/new
//
// PBKDF2 turns the secret name into K; HKDF derives the namespace key and the
// write key; the ID is a one-way hash of the write key. A read-only link
// carries the ID and namespace key, never K, so it cannot lead to the write
// key. Salt, iterations and HKDF labels are protocol: changing them makes
// every encrypted namespace unreadable.
//
// Each item has its own random key, wrapped by the namespace key (AES-KW), so
// a share link's item key reveals that one item and nothing else.

// ============================================================================
// SECTION 01 - Protocol parameters and shared primitives
// ============================================================================

const PROTOCOL_SALT = "kurobako/v4";
const PBKDF2_ITERATIONS = 600_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Each segment has its own tag, so part of a body can be read and checked alone. */
export const SEGMENT_BYTES = 65_536;
export const sealedSize = (size) => size + TAG_BYTES * Math.ceil(size / SEGMENT_BYTES);
export const contentSize = (sealed) =>
  Math.max(0, sealed - TAG_BYTES * Math.ceil(sealed / (SEGMENT_BYTES + TAG_BYTES)));
/**
 * One PBKDF2 block: a second would double the cost of opening a namespace
 * without costing a guesser anything, since the ID alone checks a guess.
 * AES-128 throughout: the name, not the key, is what a guesser faces.
 */
const DERIVED_BITS = 256;
const ID_BYTES = 16;
const NAMESPACE_KEY_BYTES = 16;
const WRITE_KEY_BYTES = 16;
const NAMESPACE_KEY_INFO = "kurobako/v4/namespace";
const WRITE_KEY_INFO = "kurobako/v4/write";
/** AES-128 keeps a share link short (22 characters after the #). */
const ITEM_KEY_BYTES = 16;

// ============================================================================
// SECTION 02 - Encodings and common utilities
// ============================================================================

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const isLimited = (item) => Boolean(item.burn || item.readsLeft !== undefined);

const toBase64Url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromBase64Url = (text) => {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** Extractable: a share link carries one, and the namespace key wraps them. */
const importKey = (raw) =>
  crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);

/** Only wraps item keys (AES-KW, RFC 3394), so it never touches contents. */
const importWrappingKey = (raw) =>
  crypto.subtle.importKey("raw", raw, "AES-KW", false, ["wrapKey", "unwrapKey"]);

// ============================================================================
// SECTION 03 - Item metadata validation and serialization
// ============================================================================

/**
 * Only what cannot be told otherwise: the size comes from the body. Each
 * replacement gets a random `bodyId` so concurrent edits never share a body key.
 */
const packMetadata = ({ kind, title, filename, mime, rev, bodyId }) => ({
  ...(kind === "file"
    ? { filename, ...(mime && mime !== OCTET_STREAM ? { mime } : {}) }
    : title
      ? { title }
      : {}),
  ...(rev ? { rev } : {}),
  ...(bodyId ? { bodyId } : {}),
});

const validBodyId = (bodyId) => {
  if (typeof bodyId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(bodyId)) return false;
  const bytes = fromBase64Url(bodyId);
  return bytes.byteLength === 16 && toBase64Url(bytes) === bodyId;
};

const unpackMetadata = (packed, bodySize) => {
  if (!packed || typeof packed !== "object" || Array.isArray(packed)) {
    throw new Error("Invalid encrypted item metadata.");
  }
  const size = contentSize(bodySize ?? 0);
  const rev = packed.rev ?? 0;
  if (
    !Number.isSafeInteger(rev) ||
    rev < 0 ||
    (rev === 0 ? packed.bodyId !== undefined : !validBodyId(packed.bodyId))
  ) {
    throw new Error("Invalid encrypted item metadata.");
  }
  return typeof packed.filename === "string"
    ? {
        kind: "file",
        title: packed.filename,
        filename: packed.filename,
        mime: packed.mime ?? OCTET_STREAM,
        size,
        rev,
        ...(rev ? { bodyId: packed.bodyId } : {}),
      }
    : {
        kind: "text",
        title: packed.title ?? "",
        size,
        rev,
        ...(rev ? { bodyId: packed.bodyId } : {}),
      };
};
const OCTET_STREAM = "application/octet-stream";

// ============================================================================
// SECTION 04 - Authenticated encryption and segmented bodies
// ============================================================================

/** As additional data, so a metadata seal never opens as contents, nor the reverse. */
const METADATA_LABEL = encoder.encode("kurobako/v4/metadata");
/** Replacements add a random body ID, so no two revisions share a key. */
const BODY_INFO = "kurobako/v4/body/";

/** `label` is authenticated, not sent. */
const sealWith = async (key, label, bytes) => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: label }, key, bytes),
  );
  const sealed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(ciphertext, IV_BYTES);
  return sealed;
};

/** Numbered, last marked: segments cannot be moved, cut off or swapped between bodies. */
const segmentNonce = (index, last) => {
  const nonce = new Uint8Array(IV_BYTES);
  let rest = index;
  for (let at = IV_BYTES - 2; at >= 0 && rest > 0; at -= 1) {
    nonce[at] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  nonce[IV_BYTES - 1] = last ? 1 : 0;
  return nonce;
};

export const bodyKey = async (itemKeyBytes, rev = 0, bodyId) => {
  if (
    !Number.isSafeInteger(rev) ||
    rev < 0 ||
    (rev === 0 ? bodyId !== undefined : !validBodyId(bodyId))
  ) {
    throw new Error("Invalid encrypted body revision.");
  }
  return crypto.subtle.importKey(
    "raw",
    await hkdf(itemKeyBytes, `${BODY_INFO}${rev}${rev ? `/${bodyId}` : ""}`, ITEM_KEY_BYTES),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
};

const sealBody = async (key, bytes) => {
  if (!bytes.byteLength) throw new Error("The content is empty.");
  const count = Math.ceil(bytes.byteLength / SEGMENT_BYTES);
  const body = new Uint8Array(sealedSize(bytes.byteLength));
  for (let index = 0; index < count; index += 1) {
    const piece = bytes.subarray(index * SEGMENT_BYTES, (index + 1) * SEGMENT_BYTES);
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: segmentNonce(index, index === count - 1) },
      key,
      piece,
    );
    body.set(new Uint8Array(sealed), index * (SEGMENT_BYTES + TAG_BYTES));
  }
  return body;
};

/** Takes what a Range request for those segments returns. */
export const openSegments = async (key, bytes, first = 0, last = true) => {
  const sealed = new Uint8Array(bytes);
  const step = SEGMENT_BYTES + TAG_BYTES;
  if (
    !sealed.byteLength ||
    (!last && sealed.byteLength % step !== 0) ||
    (last && (sealed.byteLength - 1) % step < TAG_BYTES)
  ) {
    throw new Error("This item could not be decrypted.");
  }
  const count = Math.ceil(sealed.byteLength / step);
  const contents = new Uint8Array(Math.max(0, sealed.byteLength - TAG_BYTES * count));
  try {
    for (let index = 0; index < count; index += 1) {
      const opened = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: segmentNonce(first + index, last && index === count - 1) },
        key,
        sealed.subarray(index * step, (index + 1) * step),
      );
      contents.set(new Uint8Array(opened), index * SEGMENT_BYTES);
    }
  } catch {
    throw new Error("This item could not be decrypted.");
  }
  return contents;
};

/** A segment at a time, so a body is never whole in memory. Stopping early cancels `chunks`. */
export async function* openStream(
  key,
  chunks,
  { sealedSize, first = 0, start = first * SEGMENT_BYTES, end = contentSize(sealedSize) - 1 },
) {
  const step = SEGMENT_BYTES + TAG_BYTES;
  const count = Math.ceil(sealedSize / step);
  const lastWanted = Math.floor(end / SEGMENT_BYTES);
  const sizeOf = (index) => (index === count - 1 ? sealedSize - index * step : step);
  let index = first;
  let pending = new Uint8Array(0);
  for await (const chunk of chunks) {
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    pending = joined;
    while (index <= lastWanted && pending.length >= sizeOf(index)) {
      const size = sizeOf(index);
      const opened = await openSegments(key, pending.subarray(0, size), index, index === count - 1);
      pending = pending.subarray(size);
      // Only the bytes asked, of the first and last segments.
      const offset = index * SEGMENT_BYTES;
      yield opened.subarray(Math.max(0, start - offset), Math.min(opened.length, end - offset + 1));
      index += 1;
    }
    if (index > lastWanted) return;
  }
  if (index <= lastWanted) throw new Error("The contents ended early.");
}

const openWith = async (key, label, sealed) => {
  const bytes = new Uint8Array(sealed);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: label },
        key,
        bytes.subarray(IV_BYTES),
      ),
    );
  } catch {
    throw new Error("This item could not be decrypted.");
  }
};

// ============================================================================
// SECTION 05 - Secret names, text titles and URL fragments
// ============================================================================

/** The same name must give the same key on every device and keyboard. */
export const normalizeSecretName = (name) => name.normalize("NFC").trim();

/** "/" ends the secret name in a link (/e#name/ls), so a name can never contain one. */
export const NAME_PATH_SEPARATOR = "/";

export const secretNameProblem = (name, maxLength) => {
  if (!name) return "Enter a name.";
  if (name.includes(NAME_PATH_SEPARATOR)) return 'A name cannot contain "/".';
  if (maxLength && name.length > maxLength) return `Name too long. Max ${maxLength} characters.`;
  return null;
};

/** The server uses the same convention for plain texts; it is not part of decryption. */
const DEFAULT_NAME_CHARS = 80;
export const defaultTextName = (text) => {
  const flat = text.replace(/\s+/g, " ").trim();
  let end = 0;
  let count = 0;
  for (const point of flat) {
    if (count === DEFAULT_NAME_CHARS) break;
    end += point.length;
    count += 1;
  }
  if (end === flat.length) return flat;
  const cut = flat.slice(0, end);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?–—-]+$/u, "");
};

/** "name/path", or a read-only link's "/token/path". */
export const splitFragment = (fragment) => {
  if (fragment.startsWith(NAME_PATH_SEPARATOR)) {
    const rest = fragment.slice(1);
    const cut = rest.indexOf(NAME_PATH_SEPARATOR);
    return {
      name: "",
      readToken: cut === -1 ? rest : rest.slice(0, cut),
      path: cut === -1 ? "" : rest.slice(cut + 1),
    };
  }
  const cut = fragment.indexOf(NAME_PATH_SEPARATOR);
  const name = cut === -1 ? fragment : fragment.slice(0, cut);
  return {
    name: normalizeSecretName(decodeURIComponent(name)),
    path: cut === -1 ? "" : fragment.slice(cut + 1),
  };
};

// ============================================================================
// SECTION 06 - Key derivation and namespace access
// ============================================================================

export const encryptionAvailable = () => Boolean(globalThis.crypto?.subtle);

/** The salt is empty: K is already uniformly random. */
const hkdf = async (secret, info, bytes) => {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode(info) },
      key,
      bytes * 8,
    ),
  );
};

export const deriveNamespaceKeys = async (secretName) => {
  if (!encryptionAvailable()) {
    throw new Error("Encryption needs a secure (https) connection.");
  }
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(normalizeSecretName(secretName)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: encoder.encode(PROTOCOL_SALT),
        iterations: PBKDF2_ITERATIONS,
      },
      material,
      DERIVED_BITS,
    ),
  );
  const writeKey = await hkdf(secret, WRITE_KEY_INFO, WRITE_KEY_BYTES);
  // The ID is bound to the write key, so the server checks a Write-Key without learning K.
  const id = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(toBase64Url(writeKey))),
  ).subarray(0, ID_BYTES);
  return {
    secret,
    id,
    namespaceKey: await hkdf(secret, NAMESPACE_KEY_INFO, NAMESPACE_KEY_BYTES),
    writeKey,
  };
};

export const openSealedSpace = async (secretName) => {
  const keys = await deriveNamespaceKeys(secretName);
  return spaceOf(keys.id, keys.namespaceKey, toBase64Url(keys.writeKey), keys.secret);
};

/** base64url(ID ‖ namespace key): it reads everything but cannot write. */
export const openReadOnlySpace = async (token) => {
  if (!encryptionAvailable()) {
    throw new Error("Encryption needs a secure (https) connection.");
  }
  let bytes;
  try {
    bytes = fromBase64Url(token);
  } catch {
    bytes = new Uint8Array();
  }
  if (bytes.length !== ID_BYTES + NAMESPACE_KEY_BYTES) {
    throw new Error("This read-only link is incomplete or damaged.");
  }
  return spaceOf(bytes.subarray(0, ID_BYTES), bytes.subarray(ID_BYTES), null);
};

/** `writeKey` is null by a read-only link. */
const spaceOf = async (idBytes, namespaceKeyBytes, writeKey, secret = null) => {
  const namespaceKey = await importWrappingKey(namespaceKeyBytes);
  const readToken = new Uint8Array(ID_BYTES + NAMESPACE_KEY_BYTES);
  readToken.set(idBytes);
  readToken.set(namespaceKeyBytes, ID_BYTES);

  return {
    id: toBase64Url(idBytes),
    writeKey,
    readToken: toBase64Url(readToken),

    /** A fresh view ID derives a distinct read key without disclosing the namespace key. */
    viewKey: async (viewId) => {
      if (!secret || !/^[A-Za-z0-9_-]{22}$/.test(viewId)) throw new Error("Invalid view ID.");
      return toBase64Url(await hkdf(secret, `kurobako/v6/view/${viewId}`, 16));
    },
    sealViewEntry: async (viewId, keyText) => {
      if (!secret) throw new Error("A read-only link cannot create a view entry.");
      return sealViewEntry(await hkdf(secret, `kurobako/v6/view/${viewId}`, 16), viewId, keyText);
    },

    /** `keyText`, the item key, is what a share link carries. */
    sealItem: async (bytes, metadata) => {
      const rawKey = crypto.getRandomValues(new Uint8Array(ITEM_KEY_BYTES));
      const itemKey = await importKey(rawKey);
      const wrappedKey = new Uint8Array(
        await crypto.subtle.wrapKey("raw", itemKey, namespaceKey, "AES-KW"),
      );
      const sealedMetadata = await sealWith(
        itemKey,
        METADATA_LABEL,
        encoder.encode(JSON.stringify(packMetadata({ ...metadata, rev: 0, bodyId: undefined }))),
      );
      return {
        header: `${toBase64Url(wrappedKey)}.${toBase64Url(sealedMetadata)}`,
        body: await sealBody(await bodyKey(rawKey, 0), bytes),
        keyText: toBase64Url(rawKey),
      };
    },

    /** `withMetadata` reseals under the same key, so a rename keeps share links working. */
    openItem: async (header, sealedSize) => {
      const [wrappedKey = "", sealedMetadata = ""] = header.split(".");
      let itemKey;
      try {
        itemKey = await crypto.subtle.unwrapKey(
          "raw",
          fromBase64Url(wrappedKey),
          namespaceKey,
          "AES-KW",
          "AES-GCM",
          true,
          ["encrypt", "decrypt"],
        );
      } catch {
        throw new Error("This item could not be decrypted.");
      }
      const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", itemKey));
      const opened = await openItemWithKey(toBase64Url(rawKey), sealedMetadata, sealedSize);
      return {
        ...opened,
        withMetadata: async (changes) =>
          `${wrappedKey}.${await opened.sealMetadata({ ...opened.metadata, ...changes })}`,
        withContents: async (bytes, changes = {}) => {
          const changed = await opened.sealContents(bytes, changes);
          return { ...changed, header: `${wrappedKey}.${changed.sealedMetadata}` };
        },
      };
    },
  };
};

// ============================================================================
// SECTION 07 - Read-only views and shared item access
// ============================================================================

export const newViewId = () => toBase64Url(crypto.getRandomValues(new Uint8Array(16)));

const viewLabel = (viewId) => encoder.encode(`kurobako/v6/view-entry/${viewId}`);
const sealViewEntry = async (viewKey, viewId, keyText) => {
  if (!viewKey || !/^[A-Za-z0-9_-]{22}$/.test(viewId)) throw new Error("Invalid view ID.");
  const itemKey = fromBase64Url(keyText);
  if (itemKey.byteLength !== ITEM_KEY_BYTES) throw new Error("Invalid item key.");
  return toBase64Url(await sealWith(await importKey(viewKey), viewLabel(viewId), itemKey));
};

/** A view link's key opens one item key, never the namespace key. */
export const openViewEntry = async (viewId, viewKeyText, envelope) => {
  const viewKey = fromBase64Url(viewKeyText);
  if (viewKey.byteLength !== 16 || !/^[A-Za-z0-9_-]{22}$/.test(viewId)) {
    throw new Error("Invalid view key.");
  }
  const itemKey = await openWith(
    await importKey(viewKey),
    viewLabel(viewId),
    fromBase64Url(envelope),
  );
  if (itemKey.byteLength !== ITEM_KEY_BYTES) throw new Error("Invalid view entry.");
  return toBase64Url(itemKey);
};

/** As a share link carries the key, after the #, which the server never sees. */
export const openSharedItem = (keyText, header, sealedSize) =>
  openItemWithKey(keyText, header.split(".")[1] ?? "", sealedSize);

const openItemWithKey = async (keyText, sealedMetadata, sealedSize) => {
  if (!encryptionAvailable()) {
    throw new Error("Encryption needs a secure (https) connection.");
  }
  const rawKey = fromBase64Url(keyText);
  const itemKey = await importKey(rawKey);
  const packed = JSON.parse(
    decoder.decode(await openWith(itemKey, METADATA_LABEL, fromBase64Url(sealedMetadata))),
  );
  const metadata = unpackMetadata(packed, sealedSize);
  return {
    metadata,
    keyText,
    bodyKey: () => bodyKey(rawKey, metadata.rev, metadata.bodyId),
    open: async (bytes) =>
      openSegments(await bodyKey(rawKey, metadata.rev, metadata.bodyId), bytes),
    sealMetadata: async (changed) =>
      toBase64Url(
        await sealWith(
          itemKey,
          METADATA_LABEL,
          encoder.encode(JSON.stringify(packMetadata(changed))),
        ),
      ),
    /** Every attempt gets an independent body key, even after the same revision. */
    sealContents: async (bytes, changes = {}) => {
      const changed = {
        ...metadata,
        ...changes,
        size: bytes.byteLength,
        rev: metadata.rev + 1,
        bodyId: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      };
      return {
        metadata: changed,
        sealedMetadata: toBase64Url(
          await sealWith(
            itemKey,
            METADATA_LABEL,
            encoder.encode(JSON.stringify(packMetadata(changed))),
          ),
        ),
        body: await sealBody(await bodyKey(rawKey, changed.rev, changed.bodyId), bytes),
      };
    },
  };
};

// ============================================================================
// SECTION 08 - CLI constants, usage and entry-point detection
// ============================================================================

/** The same as the server it comes from, so mismatches can be reported. */
export const VERSION = "0.8.17";
export const PROTOCOL = 8;
// Only when run directly. It reads like curl, with e#<name> in place of the namespace.

const HELP_INTRO = `Usage: node k.mjs [options] <link>     (or bun k.mjs, or k from Nix)

curl's requests and options, for Kurobako: e#<name> takes the place of the
namespace, and k.mjs encrypts and decrypts on the way. Plain links
(<site>/<namespace>/...) are sent as they are.`;

/** Data, not text, so the columns are always aligned. */
const HELP_SECTIONS = [
  [
    "Reading",
    [
      ["<site>/e#<name>", "the items, one per line"],
      ["<site>/e#<name>/ls", "the items as JSON"],
      ["<site>/e#<name>/1", "an item's contents (1 is the newest)"],
      ["<site>/e#<name>/1.json", "its details and a share link"],
      ["-OJ <site>/e#<name>/1/d", "saved under its own name"],
      ["-O <site>/e#<name>", "every item into this folder (overwrites)"],
      ["<site>/e#<name>/live", "a line per change (new, moved, changed, gone)"],
    ],
  ],
  [
    "Sending and editing",
    [
      ["-d 'hello' <site>/e#<name>/new", "a text (-d @file, -d @- for stdin)"],
      ["-T photo.jpg <site>/e#<name>/", "a file"],
      ["-H burn:1 -d 'once' <site>/e#<name>/new", "deleted by its first read"],
      ["-H Reads:3 -H Expires-In:3600 -d 'hi' <site>/e#<name>/new", "three reads, one hour"],
      ["-d 'changed' <site>/e#<name>/1/e", "edits a text, if unchanged meanwhile"],
      ["-d 'new name' <site>/e#<name>/1/n", "renames it (empty: a text's default)"],
      ["-X DELETE <site>/e#<name>/1", "deletes it"],
    ],
  ],
  [
    "Sharing",
    [
      ["<site>/e#<name>/1/s", "a link to it alone, with its key"],
      ["-X POST <site>/e#<name>/views", "a read-only shared view"],
      ["<site>/e#<name>/views", "its shared views"],
      ["<site>/i/<token>#<key>", "a shared item; /ls for JSON"],
      ["<site>/v/<token>#<view-key>", "a shared view, one line per item; /ls for JSON"],
      ["<site>/v/<token>#<view-key>/2", "one of its items, as in a namespace (/c, /d, .json, /s)"],
      ["<site>/e#/<token>", "an older read-only link: reads, cannot write"],
    ],
  ],
  [
    "Media",
    [
      ["<site>/e#<name>/1 | mpv -", "streams as it arrives"],
      ["play <site>/e#<name>/1", "plays it in mpv, seeking included"],
      ["serve <site>/e#<name>/1", "a local address for any player"],
    ],
  ],
  [
    "Offline backups",
    [
      ["./backup/ls", "an extracted plain backup"],
      ["./backup/plain/<ns>/1", "one namespace of a full backup"],
      ["'./backup#<name>/ls'", "an extracted encrypted backup, decrypted"],
      ["-O './backup#<name>'", "exports it"],
      ["'./backup/.../<id>.sealed#<name>'", "decrypts one item"],
    ],
  ],
  [
    "Options",
    [
      ["-d, --data <text>", "sends a text; --data-binary @file keeps line breaks"],
      ["-T, --upload-file <file>", "sends a file"],
      ["-X, --request <method>", "DELETE, POST, …"],
      ["-H, --header <header>", "Burn, Reads, Expires-In, If-Match, …"],
      ["-o, --output <file>", "writes there (-o - for standard output)"],
      ["-O, -J", "names the file after the URL, or after the item"],
      ["--no-clobber", "never overwrites a file"],
      ["-s -S -L -f -p", "ignored, so curl commands paste as they are"],
      ["-h, --help", "this help"],
    ],
  ],
  [
    "Environment",
    [
      ["KUROBAKO_KEY", "a private instance's key"],
      ["KUROBAKO_WRITE_KEY", "an encrypted namespace's write key, if not from its name"],
      ["KUROBAKO_SECRET", "the secret name, for offline encrypted backups"],
      ["KUROBAKO_PLAYER", "the player for play (mpv by default)"],
    ],
  ],
];

/** Only on a terminal, so pipes and files never get escape codes. NO_COLOR wins. */
const colorsOn = (stream) =>
  !process.env.NO_COLOR && (Boolean(process.env.FORCE_COLOR) || Boolean(stream.isTTY));

/** Longer commands put their description on the next line instead of widening every row. */
const HELP_COLUMN = 36;

const renderHelp = (stream, intro = HELP_INTRO, helpSections = HELP_SECTIONS) => {
  const on = colorsOn(stream);
  const paint = (code, text) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);
  const command = (text) =>
    text.replace(/(^|\s)(--?[\w-]+)/g, (_, space, flag) => space + paint("36", flag));
  const head = intro.replace(/^Usage:/, paint("1", "Usage:"));
  const fitting = helpSections.flatMap(([, rows]) => rows.map(([left]) => left.length));
  const width = Math.min(
    HELP_COLUMN,
    Math.max(...fitting.filter((length) => length <= HELP_COLUMN)),
  );
  const sections = helpSections.map(([title, rows]) => {
    const lines = rows.map(([left, right]) =>
      left.length > width
        ? `  ${command(left)}\n  ${" ".repeat(width)}  ${paint("2", right)}`
        : `  ${command(left)}${" ".repeat(width - left.length)}  ${paint("2", right)}`,
    );
    return [paint("1;33", title), ...lines].join("\n");
  });
  return [head, ...sections].join("\n\n");
};

const TEXT_MIME = "text/plain; charset=utf-8";
/** As on the server. */
export const TEXT_PREVIEW_CHARS = 280;
const ITEM_PATTERN = /^(?:[1-9][0-9]{0,3}|[a-z]{6})$/;
const BURN_VALUES = new Set(["1", "true", "yes"]);
const FIXED_PATHS = new Set([
  "",
  "ls",
  "new",
  "log",
  "log.json",
  "live",
  "zip",
  "tar",
  "import",
  "views",
]);

const runningAsScript = async () => {
  if (typeof document !== "undefined" || !globalThis.process?.argv?.[1]) return false;
  const { realpathSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

// ============================================================================
// SECTION 09 - CLI argument and URL parsing
// ============================================================================

const VALUE_OPTIONS = {
  d: "data",
  T: "upload",
  X: "method",
  H: "header",
  o: "output",
  "--data": "data",
  "--data-raw": "dataRaw",
  "--data-binary": "dataBinary",
  "--upload-file": "upload",
  "--request": "method",
  "--header": "header",
  "--output": "output",
};
const FLAG_OPTIONS = {
  O: "remoteName",
  J: "headerName",
  "--remote-name": "remoteName",
  "--remote-header-name": "headerName",
};
const TOGGLE_OPTIONS = {
  "--no-clobber": ["noClobber", true],
  "--clobber": ["clobber", true],
};
/** Accepted, so curl commands paste as they are. */
const IGNORED = new Set([
  "s",
  "S",
  "L",
  "f",
  "p",
  "--silent",
  "--show-error",
  "--location",
  "--fail",
  "--proxytunnel",
]);

const parseArgs = (args) => {
  const options = {
    data: null,
    dataMode: "data",
    upload: null,
    method: null,
    headers: [],
    output: null,
    remoteName: false,
    headerName: false,
    noClobber: false,
    clobber: false,
  };
  const set = (key, value) => {
    if (key === "header") options.headers.push(value);
    else if (key.startsWith("data")) {
      options.data = value;
      options.dataMode = key;
    } else options[key] = value;
  };
  let link = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      if (index >= args.length) throw new Error(`${arg} needs a value.`);
      return args[index];
    };
    if (arg.startsWith("--")) {
      if (VALUE_OPTIONS[arg]) set(VALUE_OPTIONS[arg], next());
      else if (FLAG_OPTIONS[arg]) options[FLAG_OPTIONS[arg]] = true;
      else if (TOGGLE_OPTIONS[arg]) {
        const [key, value] = TOGGLE_OPTIONS[arg];
        options[key] = value;
      } else if (!IGNORED.has(arg)) throw new Error(`Unknown option ${arg}.`);
    } else if (arg.startsWith("-") && arg.length > 1) {
      // Short options group like curl's: -OJ, -sS, -sd 'text'.
      for (let at = 1; at < arg.length; at += 1) {
        const letter = arg[at];
        if (VALUE_OPTIONS[letter]) {
          set(VALUE_OPTIONS[letter], at + 1 < arg.length ? arg.slice(at + 1) : next());
          break;
        }
        if (FLAG_OPTIONS[letter]) options[FLAG_OPTIONS[letter]] = true;
        else if (!IGNORED.has(letter)) throw new Error(`Unknown option -${letter}.`);
      }
    } else if (link === null) {
      link = arg;
    } else {
      throw new Error(`Unexpected "${arg}": one link at a time. Texts are sent with -d.`);
    }
  }
  if (options.data !== null && options.upload !== null) throw new Error("Use either -d or -T.");
  options.method = (
    options.method ?? (options.upload !== null ? "PUT" : options.data !== null ? "POST" : "GET")
  ).toUpperCase();
  options.burn = options.headers.some((header) => {
    const [name, ...value] = header.split(":");
    return (
      name.trim().toLowerCase() === "burn" && BURN_VALUES.has(value.join(":").trim().toLowerCase())
    );
  });
  options.limited =
    options.burn ||
    options.headers.some((header) => header.split(":", 1)[0].trim().toLowerCase() === "reads");
  return link === null ? null : { link, options };
};

const splitSharedFragment = (fragment) => {
  const decoded = decodeURIComponent(fragment);
  const slash = decoded.indexOf("/");
  return slash === -1
    ? { keyText: decoded, suffix: "" }
    : { keyText: decoded.slice(0, slash), suffix: decoded.slice(slash) };
};

const parseLink = (text) => {
  // What is left of "$BOX/e#name" when BOX is empty.
  if (text.startsWith("/")) {
    throw new Error(
      `"${text}" has no site in front: the variable before it may be empty. A link looks like https://<site>${text}.`,
    );
  }
  const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  const fragment = url.hash.slice(1);
  // A site may live under a path (https://example.com/k).
  const sealed = /^((?:\/[^/]+)*)\/e$/.exec(url.pathname);
  if (sealed && fragment) {
    const { name, readToken, path } = splitFragment(fragment);
    const site = `${url.origin}${sealed[1]}`;
    if (readToken !== undefined) return { kind: "sealed", site, name: "", readToken, path };
    const problem = secretNameProblem(name);
    if (problem) throw new Error(problem);
    return { kind: "sealed", site, name, path };
  }
  const shared = /^((?:\/[^/]+)*)\/i\/([A-Za-z0-9_-]{14})(.*)$/.exec(url.pathname);
  if (shared && fragment) {
    const key = splitSharedFragment(fragment);
    if (shared[3] && key.suffix) throw new Error("Use one path, before or after #.");
    return {
      kind: "shared",
      base: `${url.origin}${shared[1]}/i/${shared[2]}`,
      suffix: (key.suffix || shared[3] || "") + url.search,
      keyText: key.keyText,
    };
  }
  const view = /^((?:\/[^/]+)*)\/v\/([A-Za-z0-9_-]{14})(.*)$/.exec(url.pathname);
  if (view) {
    const key = splitSharedFragment(fragment);
    if (view[3] && key.suffix) throw new Error("Use one path, before or after #.");
    return {
      kind: "view",
      base: `${url.origin}${view[1]}/v/${view[2]}`,
      suffix: (key.suffix || view[3] || "") + url.search,
      keyText: key.keyText,
    };
  }
  return { kind: "plain", url: `${url.origin}${url.pathname}${url.search}` };
};

/** The same split online and offline, so both answer alike. */
const parseNamespacePath = (fullPath) => {
  const [rawPath = "", query = ""] = fullPath.split("?", 2);
  const path = rawPath.replace(/\/+$/, "");
  const [rawFirst = "", second, ...extra] = path.split("/");
  return { path, query, first: decodeURIComponent(rawFirst), second, extra };
};

// ============================================================================
// SECTION 10 - HTTP transport, discovery and protocol compatibility
// ============================================================================

let namespaceWriteKey = null;

/** KUROBAKO_KEY and KUROBAKO_WRITE_KEY go with every request unless the command sends its own. */
const reach = async (url, init = {}) => {
  const key = globalThis.process?.env?.KUROBAKO_KEY;
  const writeKey = globalThis.process?.env?.KUROBAKO_WRITE_KEY ?? namespaceWriteKey;
  const headers = new Headers(init.headers);
  if (key && !headers.has("authorization")) headers.set("authorization", `Bearer ${key}`);
  // Plain routes ignore it.
  if (writeKey && !headers.has("write-key")) headers.set("write-key", writeKey);
  try {
    return await fetch(url, { ...init, headers });
  } catch (error) {
    const reason = error.cause?.code ?? error.cause?.message ?? error.message;
    throw new Error(`Could not reach ${new URL(url).origin} (${reason}).`);
  }
};

export const WELL_KNOWN_PATH = "/.well-known/kurobako";
const described = new Map();

/** The root is tried first: a site under a path may pass it on. */
const kurobakoConfig = (url) => {
  const { origin, pathname } = new URL(url);
  const parts = pathname.split("/").filter(Boolean).slice(0, -1);
  const prefixes = parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`);
  const key = `${origin}${pathname}`;
  if (!described.has(key)) {
    described.set(
      key,
      (async () => {
        for (const prefix of ["", ...prefixes]) {
          try {
            const config = await (await fetch(`${origin}${prefix}${WELL_KNOWN_PATH}`)).json();
            if (config?.namespace?.pattern && config?.live?.ping) return config;
          } catch {}
        }
        return null;
      })(),
    );
  }
  return described.get(key);
};

/** A version mismatch may not be the cause, so it is only a hint. */
const explainFailure = async (url, message) => {
  const { origin } = new URL(url);
  const config = await kurobakoConfig(url);
  if (!config) {
    return `${origin} does not look like a Kurobako server: it has no ${WELL_KNOWN_PATH}.`;
  }
  if (config.protocol !== PROTOCOL) {
    return `${message}\n${protocolMismatch(origin, config)}`;
  }
  if (config.version && config.version !== VERSION) {
    return `${message}\nThis k.mjs is ${VERSION} and the server is ${config.version}; its own matches it: curl -O ${origin}${config.clientUrl}`;
  }
  return message;
};

const protocolMismatch = (origin, config) =>
  `This k.mjs speaks the Kurobako protocol ${PROTOCOL} and the server ${config.protocol ?? "an older one"}; its own speaks it: curl -O ${origin}${config.clientUrl}`;

/** Checked first, rather than failing to decrypt. */
const requireProtocol = async (url) => {
  const config = await kurobakoConfig(url);
  if (config && config.protocol !== PROTOCOL) {
    throw new Error(protocolMismatch(new URL(url).origin, config));
  }
};

/** An answer without Kurobako's JSON means another kind of site. */
const call = async (url, init, { page = false } = {}) => {
  const response = await reach(url, init);
  const isPage = (response.headers.get("content-type") ?? "").startsWith("text/html");
  const body = response.ok ? null : await response.json().catch(() => null);
  if (response.ok && (page || !isPage)) return response;
  const message = body?.error ?? `Server error (${response.status}).`;
  throw new Error(await explainFailure(url, message));
};
const fetchBytes = async (url) => new Uint8Array(await (await call(url)).arrayBuffer());

// ============================================================================
// SECTION 11 - CLI input, output and downloads
// ============================================================================

const readInput = async (source) => {
  if (source === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return new Uint8Array(Buffer.concat(chunks));
  }
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(source));
};

/** As curl reads it: @file without its line breaks, which --data-binary keeps. */
const dataBytes = async ({ data, dataMode }) => {
  if (dataMode === "dataRaw" || !data.startsWith("@")) return encoder.encode(data);
  const bytes = await readInput(data.slice(1));
  return dataMode === "dataBinary" ? bytes : bytes.filter((byte) => byte !== 0x0a && byte !== 0x0d);
};

const writeStdout = (bytes) =>
  new Promise((resolve, reject) =>
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())),
  );

/** RFC 5987's encoded form first, since it keeps any character. */
const contentDispositionName = (header) => {
  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]+)/i
    .exec(header)?.[1]
    ?.trim()
    .replace(/^"|"$/g, "");
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {}
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"])*)"/i.exec(header)?.[1];
  if (quoted !== undefined) return quoted.replace(/\\(.)/g, "$1");
  return /(?:^|;)\s*filename\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim() || null;
};

/**
 * Where curl would put it. Binary data is refused in a terminal; `isText` is
 * known before fetching, so a refused item is never consumed. `parts` streams,
 * so `| mpv -` starts at once and large files are never whole in memory.
 */
const deliver = async ({ options, isText, ownName, urlName, load, parts }) => {
  const forced = options.output === "-";
  const toFile = forced
    ? null
    : (options.output ?? (options.remoteName ? (options.headerName ? ownName : urlName) : null));
  if (!toFile && !forced && !isText && process.stdout.isTTY) {
    throw new Error(
      "Binary output can mess up your terminal: use -o <file>, -OJ, > file, or -o - to print it anyway.",
    );
  }
  const chunks = parts
    ? parts()
    : (async function* () {
        yield await load();
      })();
  if (!toFile) {
    let lastByte;
    for await (const chunk of chunks) {
      if (!chunk.length) continue;
      await writeStdout(chunk);
      lastByte = chunk.at(-1);
    }
    // Keeps the prompt on its own line after a text with no final newline.
    if (process.stdout.isTTY && lastByte !== undefined && lastByte !== 0x0a) {
      process.stdout.write("\n");
    }
    return;
  }
  const { open, unlink } = await import("node:fs/promises");
  // -OJ protects a server-chosen name unless --clobber is explicit.
  const exclusive = options.noClobber || (options.headerName && !options.clobber);
  let file;
  try {
    file = await open(toFile, exclusive ? "wx" : "w");
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`Refusing to overwrite ${toFile}: it already exists.`);
    throw error;
  }
  let written = 0;
  try {
    for await (const chunk of chunks) {
      await file.write(chunk);
      written += chunk.byteLength;
    }
  } catch (error) {
    // Half a file is no file.
    await file.close();
    await unlink(toFile).catch(() => {});
    throw error;
  }
  await file.close();
  console.error(`Saved ${toFile} (${written} bytes).`);
};

// ============================================================================
// SECTION 12 - File, media and MIME detection
// ============================================================================

/** Windows refuses these, whatever the extension. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MP4_BRANDS = [
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "mmp4",
  "dash",
];

/** As the server tells plain files, so encrypted ones are typed alike. */
export const detectMedia = (bytes) => {
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  const image = (extension, mime) => ({ kind: "image", extension, mime });
  const video = (extension, mime) => ({ kind: "video", extension, mime });
  const audio = (extension, mime) => ({ kind: "audio", extension, mime });
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && PNG.every((byte, index) => bytes[index] === byte)) {
    return image("png", "image/png");
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return image("jpg", "image/jpeg");
  }
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return image("gif", "image/gif");
  }
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return image("webp", "image/webp");
  }
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") {
    return audio("wav", "audio/wav");
  }
  if (bytes.length >= 4 && ascii(0, 4) === "fLaC") return audio("flac", "audio/flac");
  if (bytes.length >= 3 && ascii(0, 3) === "ID3") return audio("mp3", "audio/mpeg");
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2) {
    return audio("mp3", "audio/mpeg");
  }
  if (
    bytes.length >= 36 &&
    ascii(0, 4) === "OggS" &&
    (ascii(28, 8) === "OpusHead" || ascii(29, 6) === "vorbis")
  ) {
    return audio("ogg", "audio/ogg");
  }
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") return image("avif", "image/avif");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return image("heic", "image/heic");
    }
    if (brand === "qt  ") return video("mov", "video/quicktime");
    if (brand === "M4A " || brand === "M4B ") return audio("m4a", "audio/mp4");
    if (MP4_BRANDS.includes(brand)) return video("mp4", "video/mp4");
  }
  const EBML = [0x1a, 0x45, 0xdf, 0xa3];
  if (bytes.length >= 4 && EBML.every((byte, index) => bytes[index] === byte)) {
    for (let index = 4; index + 2 < Math.min(bytes.length, 64); index += 1) {
      if (bytes[index] !== 0x42 || bytes[index + 1] !== 0x82) continue;
      const size = bytes[index + 2];
      if (!(size & 0x80)) break;
      const docType = ascii(index + 3, size & 0x7f);
      if (docType === "webm") return video("webm", "video/webm");
      if (docType === "matroska") return video("mkv", "video/x-matroska");
      break;
    }
  }
  // Within the server's SIGNATURE_BYTES; an internal subset ([) declares entities no image needs.
  let text = new TextDecoder().decode(bytes.subarray(0, 1024));
  for (;;) {
    text = text.trimStart();
    if (text.startsWith("<?xml")) {
      const end = text.indexOf("?>");
      if (end === -1) return null;
      text = text.slice(end + 2);
    } else if (text.startsWith("<!--")) {
      const end = text.indexOf("-->", 4);
      if (end === -1) return null;
      text = text.slice(end + 3);
    } else if (/^<!doctype\s/i.test(text)) {
      const end = text.indexOf(">");
      if (end === -1 || text.slice(0, end).includes("[")) return null;
      text = text.slice(end + 1);
    } else {
      return /^<svg[\s/>]/.test(text) ? image("svg", "image/svg+xml") : null;
    }
  }
};

/** By the server's rules for plain files. */
export const BUNDLE_MIME = "application/vnd.kurobako.bundle+tar";
const isBundle = (bytes) => {
  const signature = new TextEncoder().encode("kurobako.json\0");
  return (
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)
  );
};

export const fileMetadata = (bytes, name) => {
  const media = detectMedia(bytes);
  if (!media && isBundle(bytes)) {
    const named = safeName(name, "bundle");
    const filename = named.toLowerCase().endsWith(".tar") ? named : `${named}.tar`;
    return {
      kind: "file",
      title: filename,
      filename,
      mime: BUNDLE_MIME,
      size: bytes.byteLength,
    };
  }
  // As on the server.
  const filename = media
    ? `${safeName(
        String(name || "file")
          .split(/[\\/]/)
          .pop()
          .replace(/\.[^.]+$/, ""),
        media.kind,
      )}.${media.extension}`
    : safeName(name, "file");
  return {
    kind: "file",
    title: filename,
    filename,
    mime: media?.mime ?? "application/octet-stream",
    size: bytes.byteLength,
  };
};

// ============================================================================
// SECTION 13 - Safe filenames and text download names
// ============================================================================

export const safeName = (name, fallback) => {
  const last = String(name || "")
    .split(/[\\/]/)
    .pop();
  // The same rules as the server's.
  const extension = /\.([\p{L}\p{N}]{1,10})$/u.exec(last)?.[1];
  const base = (extension ? last.slice(0, -extension.length - 1) : last)
    .normalize("NFKC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 100);
  const named = base || fallback;
  const safe = WINDOWS_RESERVED.test(named) || named.startsWith("-") ? `_${named}` : named;
  return extension ? `${safe}.${extension}` : safe;
};

/** Its whole first phrase, not a path segment. */
export const textFileBase = (value) =>
  safeName(`${value.replace(/[\\/]/g, "-")}.txt`, "text")
    .replace(/\.txt$/u, "")
    .replace(/[ ._-]+$/u, "") || "text";
export const suggestedTextFileBase = (text) =>
  textFileBase(defaultTextName(text).replace(/[^\p{L}\p{N} ]+/gu, " "));

export const textDownloadName = (title, id = "shared") => {
  const fallback = `text-${id}.txt`;
  if (!title) return fallback;
  const safe = safeName(title, fallback);
  return /\.[\p{L}\p{N}]{1,10}$/u.test(safe) ? safe : `${safe}.txt`;
};

// ============================================================================
// SECTION 14 - Encrypted item listing and lookup
// ============================================================================

const openList = async (space, site) => {
  const items = await (await call(`${site}/e/${space.id}/ls`)).json();
  return Promise.all(
    items.map(async (item, index) => {
      const opened = await space.openItem(item.metadata, item.size).catch(() => null);
      return {
        number: index + 1,
        item,
        opened,
        contentUrl: `${site}/e/${space.id}/${item.id}`,
      };
    }),
  );
};

/** The server cannot look up encrypted names, so the list is decrypted here. */
const lookUpIn = (entries, selector) => {
  if (/^\d+$/.test(selector)) return entries[Number(selector) - 1] ?? null;
  // An exact name first; else a prefix, ignoring case, newest first.
  const nameOf = ({ opened }) => opened?.metadata.filename ?? opened?.metadata.title ?? null;
  const start = selector.toLowerCase();
  return (
    entries.find(({ item }) => item.id === selector) ??
    entries.find((entry) => nameOf(entry) === selector) ??
    entries.find((entry) => nameOf(entry)?.toLowerCase().startsWith(start)) ??
    null
  );
};
const lookUp = async (space, site, selector) => lookUpIn(await openList(space, site), selector);
const requireEntryIn = (entries, selector) => {
  const entry = lookUpIn(entries, selector);
  if (!entry) throw new Error("Item not found.");
  if (!entry.opened) throw new Error("This item could not be decrypted.");
  return entry;
};
const findEntry = async (space, site, selector) =>
  requireEntryIn(await openList(space, site), selector);

// ============================================================================
// SECTION 15 - Item presentation: JSON, contents and streaming
// ============================================================================

/** As the plain API shows it, so scripts read both alike. */
const itemJson = (item, metadata) => {
  const isImage = metadata?.mime?.startsWith("image/");
  return {
    id: item.id,
    createdAt: item.createdAt,
    ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    expiresAt: item.expiresAt,
    ...(item.burn ? { burn: true } : {}),
    ...(item.readsLeft !== undefined ? { readsLeft: item.readsLeft } : {}),
    kind: !metadata ? "unreadable" : metadata.kind === "text" ? "text" : isImage ? "image" : "file",
    ...(metadata?.kind === "text" ? { mime: TEXT_MIME } : {}),
    // As in the plain API.
    ...(metadata?.kind === "text" && !isLimited(item) ? { name: metadata.title } : {}),
    ...(metadata?.kind === "file" ? { mime: metadata.mime, filename: metadata.filename } : {}),
    size: metadata?.size ?? item.size,
  };
};

const textJson = (text, size, { burn = false, summary = false, inlineLimit = Infinity } = {}) => {
  if (burn || text === null) return {};
  if (size > inlineLimit || (summary && text.length > TEXT_PREVIEW_CHARS)) {
    return { preview: text.slice(0, TEXT_PREVIEW_CHARS) };
  }
  return { text };
};

const inlineLimitOf = async (url) => (await kurobakoConfig(url))?.inlineTextBytes ?? Infinity;

/** As the server names plain downloads. */
const ownName = (entry) => {
  const { kind, title, filename } = entry.opened.metadata;
  if (kind !== "text") return safeName(filename, "file");
  return textDownloadName(title, entry.item.id);
};

const contentsOf = async (entry) =>
  entry.opened.open(entry.loadBody ? await entry.loadBody() : await fetchBytes(entry.contentUrl));

/** Reading one consumes nothing. */
const entryText = async (entry, options = {}) => {
  const metadata = entry.opened?.metadata;
  if (metadata?.kind !== "text" || isLimited(entry.item)) return {};
  const text = decoder.decode(await contentsOf(entry));
  return textJson(text, metadata.size, options);
};

const entryJson = async (entry, options = {}) => ({
  ...itemJson(entry.item, entry.opened?.metadata),
  ...(await entryText(entry, options)),
});

const entriesJson = (entries, options = {}) =>
  Promise.all(entries.map((entry) => entryJson(entry, options)));

/** null for a local backup's, read whole from its file. */
const entryParts = (entry) => {
  if (entry.loadBody) return null;
  return async function* () {
    const response = await call(entry.contentUrl);
    if (!entry.opened.bodyKey) {
      yield* response.body;
      return;
    }
    yield* openStream(await entry.opened.bodyKey(), response.body, {
      sealedSize: entry.item.size,
    });
  };
};

const deliverEntry = (entry, options, urlName = ownName(entry)) =>
  deliver({
    options,
    isText: entry.opened.metadata.kind === "text",
    ownName: ownName(entry),
    urlName,
    load: () => contentsOf(entry),
    parts: entryParts(entry),
  });

/** So the output code is shared. */
const plainEntry = (item, index, source) => ({
  number: index + 1,
  item,
  ...(typeof source === "string" ? { contentUrl: source } : { loadBody: source }),
  opened: {
    metadata: {
      kind: item.kind === "text" ? "text" : "file",
      title: item.name ?? item.filename ?? "",
      filename: item.filename,
      mime: item.mime,
      size: item.size,
    },
    open: async (bytes) => bytes,
  },
});

// ============================================================================
// SECTION 16 - Human-readable tables and formatting
// ============================================================================

/** Decimal, like the site's limits. */
export const formatBytes = (bytes) => {
  const units = ["B", "kB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit ? Number(value.toFixed(value < 10 ? 1 : 0)) : value} ${units[unit]}`;
};
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
const formatTime = (time) => timeFormat.format(new Date(time));
const LIST_TITLE_CHARS = 40;

const titleOf = (item, limit = Number.POSITIVE_INFINITY) => {
  if (item.kind === "unreadable") return "(could not decrypt)";
  const raw = item.name ?? item.text ?? item.preview ?? item.filename ?? "";
  if (!raw) return isLimited(item) ? "(hidden until opened)" : "(empty)";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

const columns = (rows, rightAligned = new Set()) => {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows
    .map((row) =>
      row
        .map((text, column) =>
          rightAligned.has(column) ? text.padStart(widths[column]) : text.padEnd(widths[column]),
        )
        .filter((_, column) => widths[column] > 0)
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
};

const itemsTable = (items) =>
  items.length
    ? columns(
        items.map((item, index) => [
          String(index + 1),
          item.kind,
          titleOf(item, LIST_TITLE_CHARS),
          formatBytes(item.size),
          formatTime(item.createdAt),
          item.burn ? "deletes when opened" : item.readsLeft ? `${item.readsLeft} reads left` : "",
          item.id,
        ]),
        new Set([0, 3]),
      )
    : "The namespace is empty.";

const printJson = (value) => console.log(JSON.stringify(value, null, 2));

const tableJson = (entry) => {
  const json = itemJson(entry.item, entry.opened?.metadata);
  const title = entry.opened?.metadata.title;
  return entry.opened?.metadata.kind === "text" && title ? { ...json, preview: title } : json;
};

// ============================================================================
// SECTION 17 - Bulk export and offline backup reading
// ============================================================================

/** Overwrites, as curl's -O does. Burn-after-reading items stay unread. */
const saveAll = async (entries, options) => {
  const { writeFile } = await import("node:fs/promises");
  if (!entries.length) return console.log("The namespace is empty.");
  const taken = new Set();
  for (const entry of entries) {
    const label = `[${entry.number}] ${titleOf(tableJson(entry), LIST_TITLE_CHARS)}`;
    if (!entry.opened) {
      console.log(`${label}: skipped, could not decrypt`);
    } else if (isLimited(entry.item)) {
      console.log(
        `${label}: skipped, it deletes when opened (read it with node k.mjs <link>/${entry.number})`,
      );
    } else {
      const own = ownName(entry);
      const dot = own.lastIndexOf(".");
      const withId =
        dot > 0
          ? `${own.slice(0, dot)} (${entry.item.id})${own.slice(dot)}`
          : `${own} (${entry.item.id})`;
      let name = taken.has(own) ? withId : own;
      for (let copy = 2; taken.has(name); copy += 1) {
        name =
          dot > 0
            ? `${own.slice(0, dot)} (${entry.item.id}-${copy})${own.slice(dot)}`
            : `${own} (${entry.item.id}-${copy})`;
      }
      taken.add(name);
      const bytes = await contentsOf(entry);
      try {
        await writeFile(name, bytes, { flag: options.noClobber ? "wx" : "w" });
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new Error(`Refusing to overwrite ${name}: it already exists.`);
        }
        throw error;
      }
      console.log(`${label} → ${name}`);
    }
  }
};

const localNamespaceRequest = async (entries, fullPath, options) => {
  const { path, query, first, second, extra } = parseNamespacePath(fullPath);
  if (path === "") {
    if (options.output !== null) {
      throw new Error("Use -O to export a local backup directory, not -o.");
    }
    if (options.remoteName) await saveAll(entries, options);
    else console.log(itemsTable(entries.map(tableJson)));
    return;
  }
  if (path === "ls") {
    const listingOptions = {
      summary: new URLSearchParams(query).has("summary"),
      // A backup does not record the server's inline limit; ?summary still asks for a preview.
      inlineLimit: Infinity,
    };
    printJson(await entriesJson(entries, listingOptions));
    return;
  }
  // A backup cannot recreate the server-owned share URL.
  if (first.endsWith(".json") && second === undefined) {
    const same = lookUpIn(entries, first);
    const exact = same && (same.item.id === first || same.opened?.metadata.filename === first);
    if (!exact) {
      const entry = requireEntryIn(entries, first.slice(0, -".json".length));
      printJson({ ...(await entryJson(entry)), position: entry.number });
      return;
    }
  }
  if (!first || extra.length || (second !== undefined && !["c", "d", "s"].includes(second))) {
    throw new Error(`Unknown local backup path "${path}". See: node k.mjs`);
  }
  if (second === "s") {
    throw new Error("A share link needs the server; it is not stored in the backup.");
  }
  await deliverEntry(requireEntryIn(entries, first), options, second ?? first);
};

/** False: the argument is not a local path. */
const localRequest = async (text, options) => {
  const hash = text.indexOf("#");
  const beforeFragment = hash < 0 ? text : text.slice(0, hash);
  const [rawPath, pathQuery = ""] = hash < 0 ? beforeFragment.split("?", 2) : [beforeFragment, ""];
  const { access, readFile, stat } = await import("node:fs/promises");
  const { dirname, isAbsolute, join, relative, resolve, sep } = await import("node:path");
  const requested = resolve(rawPath);
  const markedLocal = /^\.\.?[\\/]/.test(rawPath);
  const canClimbToRoot = isAbsolute(rawPath) || markedLocal;
  let target = requested;
  let targetStat;
  let filePath = "";
  let pathExists = true;
  try {
    targetStat = await stat(target);
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    pathExists = false;
    // Only to an explicitly named ancestor, so a hostname never turns into the cwd.
    const cwd = resolve(".");
    let candidate = dirname(requested);
    while (candidate !== dirname(candidate)) {
      if (!canClimbToRoot && candidate === cwd) break;
      try {
        targetStat = await stat(candidate);
        target = candidate;
        filePath = relative(target, requested).split(sep).join("/");
        break;
      } catch (cause) {
        if (cause.code !== "ENOENT" && cause.code !== "ENOTDIR") throw cause;
      }
      candidate = dirname(candidate);
    }
    if (!targetStat) {
      if (markedLocal) throw new Error(`Local path not found: ${rawPath}`);
      return false;
    }
  }

  const fragment = hash < 0 ? null : splitFragment(text.slice(hash + 1));
  let search = targetStat.isDirectory() ? target : dirname(target);
  let manifestPath = null;
  while (true) {
    const candidate = join(search, "manifest.json");
    try {
      await access(candidate);
      manifestPath = candidate;
      break;
    } catch {}
    const parent = dirname(search);
    if (parent === search) break;
    search = parent;
  }
  if (!manifestPath) {
    if (!pathExists && markedLocal) throw new Error(`Local path not found: ${rawPath}`);
    if (filePath && !markedLocal) return false;
    throw new Error("A local backup item needs the manifest.json from its extracted backup.");
  }
  if (options.method !== "GET" || options.data !== null || options.upload !== null) {
    throw new Error("A local backup can only be read.");
  }
  const root = dirname(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error(`${manifestPath} is not a Kurobako backup manifest.`);
  }
  if (manifest?.kurobako !== "backup" || !Array.isArray(manifest.namespaces)) {
    throw new Error(`${manifestPath} is not a Kurobako backup manifest.`);
  }

  const localFile = (item) => {
    if (typeof item?.path !== "string") return null;
    const file = resolve(root, item.path);
    const fromRoot = relative(root, file);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Unsafe path in backup manifest: ${item.path}`);
    }
    return file;
  };
  const under = (directory, file) => {
    const path = relative(directory, file);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  const oneFile = targetStat.isFile() && target !== manifestPath;
  const envSecret = normalizeSecretName(process.env.KUROBAKO_SECRET ?? "");

  if (fragment || envSecret) {
    const secret = fragment?.name || envSecret;
    const problem = fragment?.readToken === undefined && secretNameProblem(secret);
    if (problem) {
      throw new Error(
        "Give the backup's secret name after the path, as './backup#secret name', or in KUROBAKO_SECRET.",
      );
    }
    const space =
      fragment?.readToken !== undefined
        ? await openReadOnlySpace(fragment.readToken)
        : await openSealedSpace(secret);
    const namespace = manifest.namespaces.find(
      (candidate) => candidate?.space === "sealed" && candidate.name === space.id,
    );
    if (!namespace || !Array.isArray(namespace.items)) {
      throw new Error("This backup has no encrypted namespace for that secret name.");
    }
    const selected = namespace.items.filter((item) => {
      if (
        item?.kind !== "sealed" ||
        typeof item.metadata !== "string" ||
        typeof item.size !== "number"
      ) {
        return false;
      }
      const file = localFile(item);
      return file && (oneFile ? file === target : !targetStat.isDirectory() || under(target, file));
    });
    if (!selected.length && oneFile) throw new Error("That file is not in the backup manifest.");
    const entries = await Promise.all(
      [...selected].reverse().map(async (item, index) => ({
        number: index + 1,
        item,
        opened: await space.openItem(item.metadata, item.size),
        loadBody: async () => new Uint8Array(await readFile(localFile(item))),
      })),
    );
    const fullPath = fragment?.path ?? `${filePath}${pathQuery ? `?${pathQuery}` : ""}`;
    if (oneFile) {
      if (fullPath) throw new Error("A local .sealed file does not take a namespace path.");
      await deliverEntry(entries[0], options);
      return true;
    }
    await localNamespaceRequest(entries, fullPath, options);
    return true;
  }

  const namespaces = manifest.namespaces.filter(
    (candidate) =>
      candidate?.space === "plain" &&
      typeof candidate.name === "string" &&
      Array.isArray(candidate.items),
  );
  if (!namespaces.length) {
    throw new Error(
      "This backup has only encrypted namespaces; give its secret name after the path.",
    );
  }
  const choices = namespaces.map((namespace) => {
    const directory = resolve(root, "plain", namespace.name);
    if (!under(root, directory)) {
      throw new Error(`Unsafe namespace in backup manifest: ${namespace.name}`);
    }
    return { namespace, directory };
  });
  const matching = choices.filter(({ directory }) => under(directory, requested));
  if (matching.length > 1) throw new Error("Ambiguous namespace path in backup manifest.");
  if (!matching.length && choices.length > 1) {
    throw new Error(
      "This backup has several plain namespaces; choose one as '<backup>/plain/<namespace>/ls'.",
    );
  }
  const choice = matching[0] ?? choices[0];
  const selected = choice.namespace.items.filter(
    (item) =>
      ["text", "image", "file"].includes(item?.kind) &&
      typeof item.size === "number" &&
      Boolean(localFile(item)),
  );
  if (oneFile) {
    const item = selected.find((candidate) => localFile(candidate) === target);
    if (!item) throw new Error("That file is not in the backup manifest.");
    await deliverEntry(
      plainEntry(item, 0, async () => new Uint8Array(await readFile(localFile(item)))),
      options,
    );
    return true;
  }
  const entries = [...selected]
    .reverse()
    .map((item, index) =>
      plainEntry(item, index, async () => new Uint8Array(await readFile(localFile(item)))),
    );
  const path = matching.length
    ? relative(choice.directory, requested).split(sep).join("/")
    : filePath;
  await localNamespaceRequest(entries, `${path}${pathQuery ? `?${pathQuery}` : ""}`, options);
  return true;
};

// ============================================================================
// SECTION 18 - Encrypted uploads, edits and renames
// ============================================================================

const send = async (space, site, options, filename) => {
  const base = `${site}/e/${space.id}`;
  let contents;
  let metadata;
  if (options.upload !== null) {
    contents = await readInput(options.upload);
    metadata = fileMetadata(contents, filename || (options.upload === "-" ? "" : options.upload));
  } else {
    contents = await dataBytes(options);
    const title = options.limited ? "" : defaultTextName(decoder.decode(contents));
    metadata = { kind: "text", title, size: contents.byteLength };
  }
  const status = await (await call(`${base}/views`)).json();
  const active = status.views.find((view) => view.active);
  const { header, body, keyText } = await space.sealItem(contents, metadata);
  const viewHeaders = active
    ? {
        "View-Token": active.token,
        "View-Envelope": await space.sealViewEntry(active.viewId, keyText),
      }
    : {};
  const item = await (
    await call(`${base}/new`, {
      method: "POST",
      headers: {
        ...Object.fromEntries(
          options.headers.map((header) => {
            const [name, ...value] = header.split(":");
            return [name.trim(), value.join(":").trim()];
          }),
        ),
        "Content-Type": "application/octet-stream",
        "X-Sealed-Metadata": header,
        ...viewHeaders,
      },
      body,
    })
  ).json();
  const text =
    metadata.kind === "text"
      ? textJson(decoder.decode(contents), metadata.size, {
          burn: options.limited,
          inlineLimit: await inlineLimitOf(`${base}/new`),
        })
      : {};
  printJson({ ...itemJson(item, metadata), ...text });
};

const describeEntry = async (entry, base) => {
  const described = await (await call(`${base}/${entry.item.id}.json`)).json();
  return {
    ...(await entryJson(entry, { inlineLimit: await inlineLimitOf(`${base}/ls`) })),
    position: described.position,
    shareUrl: `${described.shareUrl}#${entry.opened.keyText}`,
  };
};

/** Sealed again with its own key, so share links keep working. */
const rename = async (space, site, selector, given) => {
  const entry = await findEntry(space, site, selector);
  const name = given.replace(/\s+/g, " ").trim();
  const isText = entry.opened.metadata.kind === "text";
  let changes = isText ? { title: name } : { title: name, filename: name };
  if (isText && !name) {
    const text = isLimited(entry.item) ? "" : decoder.decode(await contentsOf(entry));
    changes = { title: defaultTextName(text) };
  } else if (!name) {
    throw new Error("A file needs a name.");
  }
  const header = await entry.opened.withMetadata(changes);
  const item = await (
    await call(`${site}/e/${space.id}/${entry.item.id}/n`, {
      method: "POST",
      headers: {
        "X-Sealed-Metadata": header,
        "If-Match": JSON.stringify(entry.item.updatedAt ?? entry.item.createdAt),
      },
    })
  ).json();
  const renamed = {
    ...entry,
    item,
    opened: { ...entry.opened, metadata: { ...entry.opened.metadata, ...changes } },
  };
  printJson(
    await entryJson(renamed, {
      inlineLimit: await inlineLimitOf(`${site}/e/${space.id}/ls`),
    }),
  );
};

const edit = async (space, site, selector, options) => {
  const entry = await findEntry(space, site, selector);
  if (isLimited(entry.item)) throw new Error("An item with limited reads cannot be edited.");
  if (entry.opened.metadata.kind !== "text") throw new Error("Only texts can be edited.");
  const contents = await dataBytes(options);
  const previous = decoder.decode(await contentsOf(entry));
  const title =
    entry.opened.metadata.title === defaultTextName(previous)
      ? defaultTextName(decoder.decode(contents))
      : entry.opened.metadata.title;
  const replacement = await entry.opened.withContents(contents, { title });
  const item = await (
    await call(`${site}/e/${space.id}/${entry.item.id}/e`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "If-Match": JSON.stringify(entry.item.updatedAt ?? entry.item.createdAt),
        "X-Sealed-Metadata": replacement.header,
      },
      body: replacement.body,
    })
  ).json();
  printJson({
    ...itemJson(item, replacement.metadata),
    ...textJson(decoder.decode(contents), contents.byteLength, {
      inlineLimit: await inlineLimitOf(`${site}/e/${space.id}/ls`),
    }),
  });
};

// ============================================================================
// SECTION 19 - Encrypted namespace request routing
// ============================================================================

/** As the plain API answers, so the same commands work on both. */
const sealedRequest = async ({ site, name, readToken, path: fullPath }, options) => {
  await requireProtocol(`${site}/e`);
  const { path, query, first, second, extra } = parseNamespacePath(fullPath);
  const space =
    readToken !== undefined ? await openReadOnlySpace(readToken) : await openSealedSpace(name);
  namespaceWriteKey = space.writeKey;
  const base = `${site}/e/${space.id}`;
  const { method } = options;
  const sending = options.data !== null || options.upload !== null;

  if (path === "live" && method === "GET") {
    return watchLive(base, async (item) => {
      try {
        const { metadata } = await space.openItem(item.metadata, item.size);
        return metadata.filename ?? metadata.title;
      } catch {
        return "(could not decrypt)";
      }
    });
  }

  if (path === "views" && method === "GET") {
    const status = await (await call(`${base}/views`)).json();
    return printJson({
      ...status,
      views: await Promise.all(
        status.views.map(async (view) => ({
          ...view,
          url: `${new URL(site).origin}${view.url}#${await space.viewKey(view.viewId)}`,
        })),
      ),
    });
  }

  if (path === "views" && method === "POST" && !sending) {
    const status = await (await call(`${base}/views`)).json();
    const viewId = newViewId();
    const entries = await Promise.all(
      status.items.map(async (item) => {
        const opened = await space.openItem(item.metadata, item.size);
        return { id: item.id, envelope: await space.sealViewEntry(viewId, opened.keyText) };
      }),
    );
    const created = await (
      await call(`${base}/views`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          viewId,
          previousToken: status.views.find((view) => view.active)?.token ?? null,
          entries,
        }),
      })
    ).json();
    return printJson({
      ...created,
      url: `${new URL(site).origin}${created.url}#${await space.viewKey(viewId)}`,
    });
  }

  // Kept, so old commands get a clear error.
  if (path === "lock" && (method === "POST" || method === "DELETE")) {
    const response = await call(`${base}/lock`, { method });
    return printJson(await response.json());
  }

  // Items stay encrypted in backups, so they pass through as they are.
  if (path === "import" && sending && (method === "POST" || method === "PUT")) {
    const body = options.data !== null ? await dataBytes(options) : await readInput(options.upload);
    const response = await call(`${base}/import`, { method: "POST", body });
    return printJson(await response.json());
  }
  if ((path === "zip" || path === "tar") && method === "GET") {
    const url = `${base}/${path}${query ? `?${query}` : ""}`;
    const response = await call(url);
    const disposition = response.headers.get("content-disposition") ?? "";
    return deliver({
      options,
      isText: false,
      ownName: safeName(contentDispositionName(disposition), `backup.${path}`),
      urlName: path,
      load: async () => new Uint8Array(await response.arrayBuffer()),
    });
  }

  if (sending) {
    if (options.data !== null && path === "new" && method === "POST")
      return send(space, site, options);
    if (options.data !== null && second === "e" && !FIXED_PATHS.has(first) && !extra.length) {
      return edit(space, site, first, options);
    }
    if (options.data !== null && second === "n" && !FIXED_PATHS.has(first) && !extra.length) {
      return rename(space, site, first, decoder.decode(await dataBytes(options)));
    }
    if (
      options.upload !== null &&
      (path === "new" || second === undefined) &&
      !ITEM_PATTERN.test(first) &&
      first !== "ls"
    ) {
      return send(space, site, options, path === "new" ? "" : first);
    }
    throw new Error("Send texts with -d to <link>/new, files with -T to <link>/.");
  }

  if (path === "" && method === "GET") {
    const entries = await openList(space, site);
    return options.remoteName
      ? saveAll(entries, options)
      : console.log(itemsTable(entries.map(tableJson)));
  }
  if (path === "ls" && method === "GET") {
    const entries = await openList(space, site);
    const options = {
      summary: new URLSearchParams(query).has("summary"),
      inlineLimit: await inlineLimitOf(`${base}/ls`),
    };
    return printJson(await entriesJson(entries, options));
  }
  if (path === "log" || path === "log.json") {
    return writeStdout(
      new Uint8Array(
        await (await call(`${base}/${path}`, undefined, { page: true })).arrayBuffer(),
      ),
    );
  }
  if (first.endsWith(".json") && second === undefined && method === "GET") {
    const same = await lookUp(space, site, first);
    const exact = same && (same.item.id === first || same.opened?.metadata.filename === first);
    if (!exact) {
      const entry = await findEntry(space, site, first.slice(0, -".json".length));
      return printJson(await describeEntry(entry, base));
    }
  }
  if (
    FIXED_PATHS.has(first) ||
    extra.length ||
    (second !== undefined && !["c", "d", "s"].includes(second))
  ) {
    throw new Error(`Unknown path "${path}". See: node k.mjs`);
  }

  if (method === "DELETE" && second === undefined) {
    // The server cannot find an encrypted item by name.
    const entry = await findEntry(space, site, first);
    return printJson(await (await call(`${base}/${entry.item.id}`, { method: "DELETE" })).json());
  }
  if ((method === "GET" || method === "POST") && second === "s") {
    // The item's key goes after the #, which the server never sees.
    const entry = await findEntry(space, site, first);
    const url = (await (await call(`${base}/${entry.item.id}/s`)).text()).trim();
    return console.log(`${url}#${entry.opened.keyText}`);
  }
  if (method === "GET" && second !== "s") {
    const entry = await findEntry(space, site, first);
    return deliverEntry(entry, options, second ?? first);
  }
  throw new Error(`${method} is not used on "${path}". See: node k.mjs`);
};

// ============================================================================
// SECTION 20 - Shared item and read-only view routes
// ============================================================================

const sharedRequest = async ({ base, suffix, keyText }, options) => {
  if (options.method !== "GET") throw new Error("A shared item can only be read.");
  await requireProtocol(base);
  const item = await (await call(`${base}.json`)).json();
  const opened = await openSharedItem(keyText, item.metadata, item.size);
  if (suffix === ".json") return printJson(itemJson(item, opened.metadata));
  const [path, query = ""] = suffix.split("?", 2);
  const entry = {
    item: { ...item, id: base.split("/").pop() },
    opened,
    contentUrl: `${base}/c`,
  };
  if (path === "/ls") {
    return printJson(
      await entriesJson([entry], {
        summary: new URLSearchParams(query).has("summary"),
        inlineLimit: await inlineLimitOf(`${base}/ls`),
      }),
    );
  }
  if (!["", "/c", "/d"].includes(suffix)) throw new Error(`Unknown path "${suffix}".`);
  return deliverEntry(entry, options, suffix ? suffix.slice(1) : base.split("/").pop());
};

/** Every entry of a view, opened: encrypted ones with the key each envelope holds. */
const openView = async (base, keyText) => {
  const view = await (await call(`${base}.json`)).json();
  const entries = await Promise.all(
    view.entries.map(async ({ url, item, envelope }, index) => {
      const contentUrl = `${new URL(base).origin}${url}/c`;
      const id = url.split("/").pop();
      if (item.kind !== "sealed") return plainEntry({ ...item, id }, index, contentUrl);
      if (!keyText) throw new Error("Incomplete shared view link: missing the key after #.");
      const itemKey = await openViewEntry(view.viewId, keyText, envelope);
      return {
        number: index + 1,
        item: { ...item, id },
        opened: await openSharedItem(itemKey, item.metadata, item.size),
        contentUrl,
      };
    }),
  );
  return { view, entries };
};

/** As in a namespace: a position (1 is the first) or the entry's own token. */
const viewEntry = (entries, selector) => {
  const entry = /^[1-9][0-9]*$/.test(selector)
    ? entries[Number(selector) - 1]
    : entries.find(({ item }) => item.id === selector);
  if (!entry) throw new Error(`No item "${selector}" in this view.`);
  return entry;
};

/** The entry's share link, with its key after the # when it is encrypted. */
const viewEntryLink = (entry) => {
  const link = entry.contentUrl.replace(/\/c$/, "");
  return entry.opened.keyText ? `${link}#${entry.opened.keyText}` : link;
};

const viewRequest = async ({ base, suffix, keyText }, options) => {
  if (options.method !== "GET") throw new Error("A shared view can only be read.");
  await requireProtocol(base);
  const { view, entries } = await openView(base, keyText);
  const [path, query = ""] = suffix.split("?", 2);
  if (path === "/ls") {
    return printJson(
      await entriesJson(entries, {
        summary: new URLSearchParams(query).has("summary"),
        inlineLimit: await inlineLimitOf(`${base}/ls`),
      }),
    );
  }
  if (path === ".json") {
    return printJson({
      active: view.active,
      createdAt: view.createdAt,
      items: await entriesJson(entries),
    });
  }
  if (path === "") {
    if (options.remoteName) return saveAll(entries, options);
    return console.log(itemsTable(entries.map(tableJson)));
  }
  const item = /^\/([^/]+?)(\.json|\/c|\/d|\/s)?$/.exec(path);
  if (!item) throw new Error(`Unknown path "${path}". See: node k.mjs`);
  const [, selector, rest = ""] = item;
  const entry = viewEntry(entries, selector);
  if (rest === ".json") {
    return printJson({
      ...(await entryJson(entry, { inlineLimit: await inlineLimitOf(`${base}/ls`) })),
      position: entry.number,
      shareUrl: viewEntryLink(entry),
    });
  }
  if (rest === "/s") return console.log(viewEntryLink(entry));
  return deliverEntry(entry, options, rest ? rest.slice(1) : selector);
};

// ============================================================================
// SECTION 21 - Plain namespace detection and live updates
// ============================================================================

/** With more than one path part, the site may live under a path, which the server says. */
const isNamespace = async (url) => {
  const pathname = new URL(url).pathname.replace(/\/$/, "");
  if (/^\/[a-z0-9_-]+$/.test(pathname)) return true;
  if (!/^(?:\/[^/]+){2,}$/.test(pathname)) return false;
  const base = (await kurobakoConfig(url))?.base ?? "";
  return (
    Boolean(base) &&
    pathname.startsWith(`${base}/`) &&
    /^\/[a-z0-9_-]+$/.test(pathname.slice(base.length))
  );
};

/**
 * For scripts (`while read -r event id name`): new, moved, changed, gone.
 * Connects before fetching /ls, so nothing between the two is missed.
 */
const watchLive = async (base, nameOf) => {
  if (typeof WebSocket === "undefined") {
    throw new Error("Live updates need Node 22 or newer, or Bun.");
  }
  const live = (await kurobakoConfig(base))?.live ?? {
    ping: "ping",
    pong: "pong",
    pingSeconds: 60,
  };
  const address = `${base.replace(/^http/, "ws")}/live`;
  const accessKey = globalThis.process?.env?.KUROBAKO_KEY;
  const print = (line) => process.stdout.write(`${line}\n`);
  let known = null;
  let revision = -1;
  let pending = [];
  const names = new Map();
  const named = async (item) => {
    const key = item.metadata ?? `${item.id}/${item.name ?? item.filename ?? ""}`;
    if (!names.has(key)) names.set(key, (await nameOf(item)) || "-");
    return names.get(key);
  };

  const apply = async (items, nextRevision) => {
    const seen = new Map();
    for (const item of items) {
      seen.set(item.id, {
        name: await named(item),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt ?? null,
      });
    }
    if (known) {
      for (const [id, now] of [...seen].reverse()) {
        const before = known.get(id);
        if (!before) print(`new ${id} ${now.name}`);
        else if (before.createdAt !== now.createdAt) print(`moved ${id} ${now.name}`);
        else if (before.updatedAt !== now.updatedAt) print(`changed ${id} ${now.name}`);
      }
      for (const id of known.keys()) if (!seen.has(id)) print(`gone ${id}`);
    }
    known = seen;
    revision = nextRevision;
  };

  const bootstrap = async () => {
    const response = await call(`${base}/ls?summary`);
    const items = await response.json();
    const nextRevision = Number(response.headers.get("X-Queue-Revision") ?? 0);
    if (nextRevision >= revision) await apply(items, nextRevision);
    const buffered = pending;
    pending = [];
    for (const change of buffered) await applyChange(change);
  };

  const applyChange = async (change) => {
    if (change.revision <= revision) return;
    if (change.revision !== revision + 1) return bootstrap();
    const upserts = new Map(change.upserts.map((item) => [item.id, item]));
    for (const id of [...change.order].reverse()) {
      const item = upserts.get(id);
      if (!item) continue;
      const now = {
        name: await named(item),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt ?? null,
      };
      const before = known.get(id);
      if (!before) print(`new ${id} ${now.name}`);
      else if (before.createdAt !== now.createdAt) print(`moved ${id} ${now.name}`);
      else if (before.updatedAt !== now.updatedAt || before.name !== now.name)
        print(`changed ${id} ${now.name}`);
      known.set(id, now);
    }
    for (const id of change.removed) {
      if (known.delete(id)) print(`gone ${id}`);
    }
    revision = change.revision;
  };

  let delay = 1_000;
  while (true) {
    revision = -1;
    pending = [];
    await new Promise((resolve) => {
      const socket = new WebSocket(
        address,
        accessKey ? { headers: { authorization: `Bearer ${accessKey}` } } : undefined,
      );
      let ping = null;
      let handled = Promise.resolve();
      socket.addEventListener("open", () => {
        delay = 1_000;
        ping = setInterval(() => socket.send(live.ping), live.pingSeconds * 1000);
      });
      socket.addEventListener("message", (event) => {
        if (event.data === live.pong) return;
        const message = JSON.parse(String(event.data));
        if (message.type === "ready") {
          handled = handled.then(bootstrap).catch((error) => console.error(error.message));
        } else if (message.type === "change") {
          if (revision < 0) pending.push(message);
          else
            handled = handled
              .then(() => applyChange(message))
              .catch((error) => console.error(error.message));
        }
      });
      socket.addEventListener("close", () => {
        clearInterval(ping);
        handled.then(resolve);
      });
      // A failed connection closes too, which retries.
      socket.addEventListener("error", () => {});
    });
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 30_000);
  }
};

// ============================================================================
// SECTION 22 - Plain HTTP request routing
// ============================================================================

const plainRequest = async ({ url }, options) => {
  const watched = url.replace(/\/live\/?$/, "");
  if (options.method === "GET" && watched !== url && (await isNamespace(watched))) {
    return watchLive(watched, (item) => item.name ?? item.filename ?? "");
  }
  // The bare namespace is a page; here it lists the items, like e#<name>.
  if (options.method === "GET" && (await isNamespace(url))) {
    const base = url.replace(/\/$/, "");
    if (options.remoteName) {
      const items = await (await call(`${base}/ls`)).json();
      return saveAll(
        items.map((item, index) => plainEntry(item, index, `${base}/${item.id}`)),
        options,
      );
    }
    const items = await (await call(`${base}/ls?summary`)).json();
    return console.log(itemsTable(items));
  }
  const headers = Object.fromEntries(
    options.headers.map((header) => {
      const [name, ...value] = header.split(":");
      return [name.trim(), value.join(":").trim()];
    }),
  );
  let body;
  let target = url;
  if (options.data !== null) {
    body = await dataBytes(options);
    headers["Content-Type"] ??= "application/x-www-form-urlencoded";
    // Edits need If-Match; fetch it unless given, so the command stays curl-like.
    if (
      /\/e\/?$/.test(new URL(target).pathname) &&
      !Object.keys(headers).some((name) => name.toLowerCase() === "if-match")
    ) {
      const itemUrl = target.replace(/\/e\/?(?:\?.*)?$/, ".json");
      const item = await (await call(itemUrl)).json();
      headers["If-Match"] = JSON.stringify(item.updatedAt ?? item.createdAt);
    }
  } else if (options.upload !== null) {
    body = await readInput(options.upload);
    if (options.upload !== "-" && (await isNamespace(target))) {
      target = `${target.replace(/\/$/, "")}/${encodeURIComponent(safeName(options.upload, "file"))}`;
    }
  }
  const response = await reach(target, { method: options.method, headers, body });
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    let error = null;
    try {
      error = JSON.parse(decoder.decode(bytes))?.error ?? null;
    } catch {}
    throw new Error(await explainFailure(url, error ?? `Server error (${response.status}).`));
  }
  if (/^application\/json/.test(type) && options.output === null && !options.remoteName) {
    const text = await response.text();
    try {
      return printJson(JSON.parse(text));
    } catch {
      return writeStdout(encoder.encode(text));
    }
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const urlName = new URL(target).pathname.split("/").pop() || "index";
  return deliver({
    options,
    isText: /^(text\/|application\/json)/.test(type),
    ownName: safeName(contentDispositionName(disposition), urlName),
    urlName,
    parts: async function* () {
      if (response.body) yield* response.body;
    },
  });
};

// ============================================================================
// SECTION 23 - Media playback: links and local HTTP server
// ============================================================================

//   node k.mjs serve <item link>               prints a local address, until stopped
//   node k.mjs play <item link> [-- <args>]    opens it in mpv, and stops with it
//
// Players seek with Range, and phone videos keep their index at the end, so
// standard output will not do. This serves the item on 127.0.0.1, fetching
// only the segments each request needs, as public/sw.js does for pages. The
// random token keeps other local programs out; the key never leaves.

const MEDIA_HELP_INTRO = `Usage: node k.mjs serve [--port <n>] <item link>
       node k.mjs play [--player <command>] <item link> [-- <player options>]

Players seek, which a pipe cannot do: serve answers on 127.0.0.1 until
stopped, and play opens that address in a player and stops with it. Items
deleted once read cannot be served, since every seek reads again: save those
with -o.`;

const MEDIA_HELP_SECTIONS = [
  [
    "Item links",
    [
      ["<site>/e#<name>/<item>", "an encrypted namespace's item"],
      ["<site>/v/<token>#<view-key>/<item>", "an item of a shared view"],
      ["<site>/i/<token>#<key>", "a shared item"],
      ["<site>/<namespace>/<item>", "a plain namespace's item"],
    ],
  ],
  [
    "Options",
    [
      ["--port <n>", "serve on this port (any free one by default)"],
      ["--player <command>", "play with this (mpv, or KUROBAKO_PLAYER)"],
      ["-- <player options>", "passed on to the player"],
      ["-h, --help", "this help"],
    ],
  ],
];

const mediaHelp = (stream) => renderHelp(stream, MEDIA_HELP_INTRO, MEDIA_HELP_SECTIONS);

/** A player reads many times. */
const refuseLimited = (item) => {
  if (isLimited(item)) {
    throw new Error(
      "This item is deleted once read, and a player reads it many times: save it with -o.",
    );
  }
};

/** A plain item streams from the server as it is, ranges included. */
const plainPlayable = (item, contentUrl) => {
  refuseLimited(item);
  return {
    filename: item.filename ?? textDownloadName(item.name ?? "", item.id),
    mime: item.mime ?? "application/octet-stream",
    size: item.size,
    fetchParts: (range) =>
      call(contentUrl, range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}),
  };
};

const playable = async (link) => {
  const target = parseLink(link);

  if (target.kind === "plain") {
    // By ID, which does not move when something is sent.
    const url = target.url.replace(/\/[cd]\/?$/, "").replace(/\/$/, "");
    const item = await (await call(`${url}.json`)).json();
    return plainPlayable(
      item,
      `${url.slice(0, url.lastIndexOf("/"))}/${encodeURIComponent(item.id)}`,
    );
  }

  let item;
  let opened;
  let contentUrl;
  if (target.kind === "shared") {
    await requireProtocol(target.base);
    item = await (await call(`${target.base}.json`)).json();
    opened = await openSharedItem(target.keyText, item.metadata, item.size);
    contentUrl = `${target.base}/c`;
  } else if (target.kind === "view") {
    const selector = /^\/([^/]+?)(?:\/[cd])?$/.exec(target.suffix.split("?")[0]);
    if (!selector) throw new Error("serve and play take one item: <site>/v/<token>#<key>/<item>.");
    await requireProtocol(target.base);
    const entry = viewEntry((await openView(target.base, target.keyText)).entries, selector[1]);
    if (!entry.opened.bodyKey) return plainPlayable(entry.item, entry.contentUrl);
    ({ item, opened, contentUrl } = entry);
  } else {
    await requireProtocol(`${target.site}/e`);
    const { first, second, extra } = parseNamespacePath(target.path);
    if (
      !first ||
      FIXED_PATHS.has(first) ||
      extra.length ||
      !["c", "d", undefined].includes(second)
    ) {
      throw new Error("serve and play take one item's link: <site>/e#<name>/<item>.");
    }
    const space =
      target.readToken !== undefined
        ? await openReadOnlySpace(target.readToken)
        : await openSealedSpace(target.name);
    const entry = await findEntry(space, target.site, first);
    ({ item, opened, contentUrl } = entry);
  }
  refuseLimited(item);
  const { metadata } = opened;
  const key = await opened.bodyKey();
  const step = SEGMENT_BYTES + TAG_BYTES;
  return {
    filename:
      metadata.kind === "text"
        ? textDownloadName(metadata.title, item.id)
        : safeName(metadata.filename, "file"),
    mime: metadata.mime || "application/octet-stream",
    size: metadata.size,
    fetchParts: async (range) => {
      const first = range ? Math.floor(range.start / SEGMENT_BYTES) : 0;
      const last = range ? Math.floor(range.end / SEGMENT_BYTES) : Infinity;
      const to = Math.min((last + 1) * step, item.size) - 1;
      const response = await call(contentUrl, {
        headers: { Range: `bytes=${first * step}-${to}` },
      });
      return {
        body: openStream(key, response.body, {
          sealedSize: item.size,
          first,
          start: range?.start ?? 0,
          end: range?.end ?? metadata.size - 1,
        }),
      };
    },
  };
};

const playRange = (header, size) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const length = Math.min(Number(match[2]), size);
    return length > 0 ? { start: size - length, end: size - 1 } : "unsatisfiable";
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start < size && start <= end ? { start, end } : "unsatisfiable";
};

const serveMedia = async (media, port = 0) => {
  const { createServer } = await import("node:http");
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const path = `/${token}/${encodeURIComponent(media.filename)}`;
  const server = createServer(async (request, response) => {
    if (decodeURIComponent(request.url ?? "") !== decodeURIComponent(path)) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const range = playRange(request.headers.range, media.size);
    if (range === "unsatisfiable") {
      response.writeHead(416, { "Content-Range": `bytes */${media.size}` }).end();
      return;
    }
    const headers = {
      "Content-Type": media.mime,
      "Content-Length": String(range ? range.end - range.start + 1 : media.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${media.size}` } : {}),
    };
    if (request.method === "HEAD") {
      response.writeHead(range ? 206 : 200, headers).end();
      return;
    }
    // A player drops a request when it seeks: stop fetching for it.
    let closed = false;
    response.on("close", () => {
      closed = true;
    });
    try {
      const parts = await media.fetchParts(range);
      response.writeHead(range ? 206 : 200, headers);
      for await (const chunk of parts.body) {
        if (closed) break;
        // The player reads slower than the site sends.
        if (!response.write(chunk)) {
          await new Promise((resolve) => {
            const done = () => {
              response.off("drain", done);
              response.off("close", done);
              resolve();
            };
            response.on("drain", done);
            response.on("close", done);
          });
        }
      }
      response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(502).end(error.message);
      else response.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, address: `http://127.0.0.1:${server.address().port}${path}` };
};

const parseMediaArgs = (args) => {
  const options = { port: 0, player: globalThis.process?.env?.KUROBAKO_PLAYER || "mpv" };
  let link = null;
  let rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      if (index >= args.length) throw new Error(`${arg} needs a value.`);
      return args[index];
    };
    if (arg === "--") {
      rest = args.slice(index + 1);
      break;
    }
    if (arg === "--port") options.port = Number(next());
    else if (arg === "--player") options.player = next();
    else if (arg.startsWith("-"))
      throw new Error(`Unknown option ${arg}.\n\n${mediaHelp(process.stderr)}`);
    else if (link === null) link = arg;
    else throw new Error(`Unexpected "${arg}": one link, then -- before the player's options.`);
  }
  if (!link) throw new Error(mediaHelp(process.stderr));
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("--port takes a number from 0 to 65535.");
  }
  return { link, options, rest };
};

const mediaCommand = async (command, args) => {
  const { link, options, rest } = parseMediaArgs(args);
  const media = await playable(link);
  const { server, address } = await serveMedia(media, options.port);
  if (command === "serve") {
    // The address alone on standard output, for $(…).
    console.log(address);
    console.error(`Serving ${media.filename} (${formatBytes(media.size)}); Ctrl+C stops.`);
    return;
  }
  const { spawn } = await import("node:child_process");
  const player = spawn(options.player, [...rest, address], { stdio: "inherit" });
  await new Promise((resolve) => {
    player.once("error", (error) => {
      console.error(
        error.code === "ENOENT"
          ? `${options.player} was not found: install it, or pick another with --player.`
          : error.message,
      );
      process.exitCode = 1;
      resolve();
    });
    player.once("exit", (code) => {
      process.exitCode = code ?? 1;
      resolve();
    });
  });
  server.closeAllConnections?.();
  server.close();
};

// ============================================================================
// SECTION 24 - CLI dispatcher and direct execution
// ============================================================================

const main = async (args) => {
  // Asking for help is not an error. After "--", arguments are the player's.
  const own = args.includes("--") ? args.slice(0, args.indexOf("--")) : args;
  const media = args[0] === "serve" || args[0] === "play";
  if (!args.length || own.includes("-h") || own.includes("--help")) {
    console.log(media ? mediaHelp(process.stdout) : renderHelp(process.stdout));
    return;
  }
  try {
    if (media) return await mediaCommand(args[0], args.slice(1));
    const parsed = parseArgs(args);
    if (!parsed) {
      console.error(renderHelp(process.stderr));
      process.exitCode = 2;
      return;
    }
    if (await localRequest(parsed.link, parsed.options)) return;
    const target = parseLink(parsed.link);
    if (target.kind === "sealed") return await sealedRequest(target, parsed.options);
    if (target.kind === "shared") return await sharedRequest(target, parsed.options);
    if (target.kind === "view") return await viewRequest(target, parsed.options);
    return await plainRequest(target, parsed.options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
};

// Dead code in pages (KUROBAKO_PAGE, src/client/build.ts), so the command line is left out.
// biome-ignore lint/correctness/noUndeclaredVariables: only a page's build defines it; typeof is safe anywhere.
if (typeof KUROBAKO_PAGE === "undefined" && (await runningAsScript())) {
  await main(process.argv.slice(2));
}
