// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors
// Source and license: https://github.com/merutam/kurobako

// End-to-end encryption for /e#name namespaces: the one implementation of the
// protocol described at /k/protocol. Pages import this file as a module, and it
// is also a command-line client (Node 20+ or Bun, no dependencies):
//
//   curl -O https://<site>/k.mjs
//   node k.mjs https://<site>/e#<name>/ls              the same requests as curl,
//   node k.mjs -d 'hello' https://<site>/e#<name>/new  on an encrypted namespace
//
// It takes curl's own options and paths, encrypting and decrypting on the
// way: run `node k.mjs` for the list. The secret name ends at the first "/".
//
// One PBKDF2 run turns the secret name into a 256-bit secret, K; HKDF then
// gives from it the namespace ID the server sees, the namespace key and the
// write key, which never leave the client. A read-only link carries the ID
// and the namespace key, never K, so it cannot lead to the write key. The
// salt, iteration count and HKDF labels are part of the protocol: changing
// them makes every existing encrypted namespace unreadable.
//
// Each item gets its own random AES-GCM key, which encrypts its contents and
// its metadata. The namespace key only wraps that item key (AES-KW), so handing out an
// item key (in a share link) reveals that one item and nothing else.
const PROTOCOL_SALT = "kurobako/v4";
const PBKDF2_ITERATIONS = 600_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/**
 * Contents are sealed in segments of this many bytes (the last one shorter),
 * each with its own AES-GCM tag, so each opens on its own: a part of a body
 * can be read and checked without the rest.
 */
export const SEGMENT_BYTES = 65_536;
/** A body's size for `size` bytes of contents: one tag per segment. */
export const sealedSize = (size) => size + TAG_BYTES * Math.ceil(size / SEGMENT_BYTES);
/** The contents' size in a body of `sealed` bytes: the reverse of sealedSize. */
export const contentSize = (sealed) =>
  Math.max(0, sealed - TAG_BYTES * Math.ceil(sealed / (SEGMENT_BYTES + TAG_BYTES)));
/**
 * One PBKDF2-SHA256 block (32 bytes), K. A second block would double the cost
 * of opening a namespace without costing a guesser anything, since the ID
 * alone checks a guess. All keys are AES-128: the name, not the key, is what
 * a guesser faces.
 */
const DERIVED_BITS = 256;
const ID_BYTES = 16;
const NAMESPACE_KEY_BYTES = 16;
const WRITE_KEY_BYTES = 16;
/** HKDF labels: what each key derived from K is for. */
const ID_INFO = "kurobako/v4/id";
const NAMESPACE_KEY_INFO = "kurobako/v4/namespace";
const WRITE_KEY_INFO = "kurobako/v4/write";
/** Item keys are AES-128 too, which keeps a share link short (22 characters after the #). */
const ITEM_KEY_BYTES = 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromBase64Url = (text) => {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

/** Item keys are extractable: a share link carries one, and the namespace key wraps them. */
const importKey = (raw) =>
  crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);

/** The namespace key only wraps and unwraps item keys (AES-KW, RFC 3394). */
const importWrappingKey = (raw) =>
  crypto.subtle.importKey("raw", raw, "AES-KW", false, ["wrapKey", "unwrapKey"]);

/**
 * Metadata as it is sealed: only what cannot be told otherwise. A file has
 * `filename` and, unless it is application/octet-stream, `mime`; a text has
 * `title`, left out when empty. `rev`, the contents' revision (each edit
 * seals them under a new body key), is left out while 0. The size is told
 * by the body's (see contentSize).
 */
const packMetadata = ({ kind, title, filename, mime, rev }) => ({
  ...(kind === "file"
    ? { filename, ...(mime && mime !== OCTET_STREAM ? { mime } : {}) }
    : title
      ? { title }
      : {}),
  ...(rev ? { rev } : {}),
});

/** Metadata as clients use it: { kind, title, filename?, mime?, size, rev }. */
const unpackMetadata = (packed, bodySize) => {
  const size = contentSize(bodySize ?? 0);
  const rev = Number.isSafeInteger(packed.rev) && packed.rev > 0 ? packed.rev : 0;
  return typeof packed.filename === "string"
    ? {
        kind: "file",
        title: packed.filename,
        filename: packed.filename,
        mime: packed.mime ?? OCTET_STREAM,
        size,
        rev,
      }
    : { kind: "text", title: packed.title ?? "", size, rev };
};
const OCTET_STREAM = "application/octet-stream";

/**
 * What each seal is for, as AES-GCM's additional data: a metadata seal never
 * opens as contents, nor the other way round, though both use the item key.
 */
const METADATA_LABEL = encoder.encode("kurobako/v4/metadata");
/** The body key of revision <rev> is HKDF(item key, BODY_INFO + rev). */
const BODY_INFO = "kurobako/v4/body/";

/** IV followed by the AES-GCM ciphertext and tag; `label` is authenticated, not sent. */
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

/**
 * A segment's nonce: its number in 11 big-endian bytes, then 1 for the last
 * segment, 0 for the others. Segments cannot be moved, dropped from the end
 * or taken from another body.
 */
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

/** An item's body key for revision `rev`, from the item key's bytes. */
export const bodyKey = async (itemKeyBytes, rev = 0) =>
  crypto.subtle.importKey(
    "raw",
    await hkdf(itemKeyBytes, `${BODY_INFO}${rev}`, ITEM_KEY_BYTES),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );

/** Contents sealed as a body: their segments, one after the other. */
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

/**
 * Opens segments of a body: `bytes` holds segments `first` onward (whole
 * ones, the body's last one included when `last`), as a Range request for
 * them returns. With first 0 and last true, the whole body.
 */
export const openSegments = async (key, bytes, first = 0, last = true) => {
  const sealed = new Uint8Array(bytes);
  const step = SEGMENT_BYTES + TAG_BYTES;
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

/** The same name must give the same key on every device and keyboard. */
export const normalizeSecretName = (name) => name.normalize("NFC").trim();

/**
 * In a link, "/" ends the secret name: what follows is a path, as in
 * /e#name/ls. So a name can never contain one.
 */
export const NAME_PATH_SEPARATOR = "/";

/** Why a secret name cannot be used, or null. */
export const secretNameProblem = (name, maxLength) => {
  if (!name) return "Enter a name.";
  if (name.includes(NAME_PATH_SEPARATOR)) return 'A name cannot contain "/".';
  if (maxLength && name.length > maxLength) return `Name too long. Max ${maxLength} characters.`;
  return null;
};

/** An encrypted link's fragment ("name/path", without the #): its name and path. */
/**
 * A text's name until it is given one: its start, up to 80 characters, cut at
 * a word and without trailing punctuation (the server uses the same rule).
 */
const DEFAULT_NAME_CHARS = 80;
export const defaultTextName = (text) => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= DEFAULT_NAME_CHARS) return flat;
  const cut = flat.slice(0, DEFAULT_NAME_CHARS);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?–—-]+$/u, "");
};

/**
 * An encrypted link's fragment (without the #): "name/path", or a read-only
 * link's "/token/path". The first gives { name, path }; the second
 * { name: "", readToken, path }.
 */
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

export const encryptionAvailable = () => Boolean(globalThis.crypto?.subtle);

/** `bytes` bytes of HKDF-SHA256 from `secret`, for `info`; the salt is empty. */
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

/**
 * Everything a secret name gives: K (PBKDF2), and from it the namespace ID,
 * the namespace key and the write key, as bytes.
 */
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
  return {
    secret,
    id: await hkdf(secret, ID_INFO, ID_BYTES),
    namespaceKey: await hkdf(secret, NAMESPACE_KEY_INFO, NAMESPACE_KEY_BYTES),
    writeKey: await hkdf(secret, WRITE_KEY_INFO, WRITE_KEY_BYTES),
  };
};

/** An encrypted namespace opened by its name: it reads, and writes with its write key. */
export const openSealedSpace = async (secretName) => {
  const keys = await deriveNamespaceKeys(secretName);
  return spaceOf(keys.id, keys.namespaceKey, toBase64Url(keys.writeKey));
};

/**
 * An encrypted namespace opened by a read-only link's token,
 * base64url(ID ‖ namespace key): it reads everything, and writes only
 * where nothing is locked.
 */
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

/**
 * A namespace's operations, from its ID and namespace key; `writeKey`
 * (base64url, for Write-Key) when opened by its name, null by a read-only link.
 */
const spaceOf = async (idBytes, namespaceKeyBytes, writeKey) => {
  const namespaceKey = await importWrappingKey(namespaceKeyBytes);
  const readToken = new Uint8Array(ID_BYTES + NAMESPACE_KEY_BYTES);
  readToken.set(idBytes);
  readToken.set(namespaceKeyBytes, ID_BYTES);

  return {
    id: toBase64Url(idBytes),
    writeKey,
    /** The fragment of a read-only link, after "#/": base64url(ID ‖ namespace key). */
    readToken: toBase64Url(readToken),

    /**
     * Encrypts one item; `header` goes in X-Sealed-Metadata, `body` is
     * uploaded, and `keyText` (the item key) is what a share link carries.
     * `metadata` is { kind, title, filename?, mime? }; see packMetadata.
     */
    sealItem: async (bytes, metadata) => {
      const rawKey = crypto.getRandomValues(new Uint8Array(ITEM_KEY_BYTES));
      const itemKey = await importKey(rawKey);
      const wrappedKey = new Uint8Array(
        await crypto.subtle.wrapKey("raw", itemKey, namespaceKey, "AES-KW"),
      );
      const sealedMetadata = await sealWith(
        itemKey,
        METADATA_LABEL,
        encoder.encode(JSON.stringify(packMetadata(metadata))),
      );
      return {
        header: `${toBase64Url(wrappedKey)}.${toBase64Url(sealedMetadata)}`,
        body: await sealBody(await bodyKey(rawKey, 0), bytes),
        keyText: toBase64Url(rawKey),
      };
    },

    /**
     * Unwraps an item's key and reads its metadata; `sealedSize` is the
     * item's size as the server lists it. `withMetadata(changes)` gives the
     * item's X-Sealed-Metadata with its metadata changed (to rename it),
     * under the same key.
     */
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
        /** New contents under the next revision, keeping this item's key. */
        withContents: async (bytes, changes = {}) => {
          const changed = await opened.sealContents(bytes, changes);
          return { ...changed, header: `${wrappedKey}.${changed.sealedMetadata}` };
        },
      };
    },
  };
};

/**
 * Opens an item with its own key, as a share link carries it after the #.
 * Returns its metadata, a decrypt function for its contents, and the key.
 * `sealedSize` is the item's size as the server lists it.
 */
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
    /** The body key of these contents' revision, for opening them in parts. */
    bodyKey: () => bodyKey(rawKey, metadata.rev),
    open: async (bytes) => openSegments(await bodyKey(rawKey, metadata.rev), bytes),
    sealMetadata: async (changed) =>
      toBase64Url(
        await sealWith(
          itemKey,
          METADATA_LABEL,
          encoder.encode(JSON.stringify(packMetadata(changed))),
        ),
      ),
    /** Seals replacement contents under rev + 1, so a body key is never reused. */
    sealContents: async (bytes, changes = {}) => {
      const changed = {
        ...metadata,
        ...changes,
        size: bytes.byteLength,
        rev: metadata.rev + 1,
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
        body: await sealBody(await bodyKey(rawKey, changed.rev), bytes),
      };
    },
  };
};

// --- Command line ------------------------------------------------------------

/** This file's version, the same as the server it comes from (package.json). */
export const VERSION = "0.7.1";
/** The protocol this file speaks; a server says its own in /.well-known/kurobako. */
export const PROTOCOL = 4;
// Everything below only runs when this file is executed directly. It reads
// like curl: the same options and the same paths as the plain API, with
// e#<name> in place of the namespace.

const USAGE = `Usage: node k.mjs [options] <link>

The requests and options are curl's; for an encrypted namespace, e#<name>
takes the place of the namespace and k.mjs does the encryption:

  node k.mjs <site>/e#<name>                  the items, one per line
  node k.mjs <site>/e#<name>/ls               the items as JSON
  node k.mjs <site>/e#<name>/1                an item's contents (1 is the newest)
  node k.mjs <site>/e#<name>/1.json           its details and a share link
  node k.mjs -OJ <site>/e#<name>/1/d          saved under its own name
  node k.mjs -O <site>/e#<name>               exports every item here (overwrites)
  node k.mjs './backup/ls'                    lists an extracted plain backup, offline
  node k.mjs './backup/plain/<ns>/1'          opens one namespace in a full backup
  node k.mjs -O './backup#<name>'             exports an extracted encrypted backup
  node k.mjs './backup#<name>/ls'             lists that backup as JSON, offline
  node k.mjs './backup#<name>/1'              decrypts its newest item, offline
  node k.mjs './backup/.../item.sealed#<name>'   decrypts one local backup item
  node k.mjs -d 'hello' <site>/e#<name>/new   sends a text (-d @file, -d @- for stdin)
  node k.mjs -T photo.jpg <site>/e#<name>/    sends a file
  node k.mjs -H burn:1 -d 'once' <site>/e#<name>/new
  node k.mjs -d 'changed' <site>/e#<name>/1/e   edits a text if it has not changed
  node k.mjs -d 'new name' <site>/e#<name>/1/n   renames it (empty: a text's default)
  node k.mjs -X DELETE <site>/e#<name>/1
  node k.mjs <site>/e#<name>/1/s              a link to share it, with its key
  node k.mjs <site>/i/<token>#<key>           a shared item

Options: -d, -T, -X, -H, -o <file> (-o - for standard output), -O, -J,
--no-clobber (do not overwrite)
(and -s, -S, -L, -f, -p, ignored).
A private instance's key goes in KUROBAKO_KEY: KUROBAKO_KEY=... node k.mjs <link>
A locked namespace's write key goes in KUROBAKO_WRITE_KEY; -X POST <link>/lock locks one.
<link>/live stays on and prints a line per change (new, moved, changed, gone,
locked, unlocked), the encrypted ones decrypted: for scripts.
An encrypted namespace writes with the key its name gives; locked, it answers
with a read-only link, <site>/e#/<token>, which reads and does not write.
As with curl, -d @file drops line breaks; --data-binary @file keeps them.
-h or --help shows this.
Plain links (<site>/<namespace>/...) work too, sent as they are; JSON prints
the same either way, and errors go to standard error.`;

/** What the plain API says a text is. */
const TEXT_MIME = "text/plain; charset=utf-8";
/** Texts in lists are cut to this many characters with ?summary, as on the server. */
export const TEXT_PREVIEW_CHARS = 280;
/** An item: its position (1 is the newest) or its six-letter ID. */
const ITEM_PATTERN = /^(?:[1-9][0-9]{0,3}|[a-z]{6})$/;
const BURN_VALUES = new Set(["1", "true", "yes"]);
const FIXED_PATHS = new Set(["", "ls", "new", "log", "log.json", "live", "zip", "tar", "import"]);

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

// --- Options ------------------------------------------------------------------

/** Options that take a value, by short and long name. */
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
/** curl options that change nothing here, accepted so curl commands paste as they are. */
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
    /** How curl reads it: "data" (-d), "dataBinary" or "dataRaw". */
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
  return link === null ? null : { link, options };
};

/** A link as the site shows it; "https://" may be left out. */
const parseLink = (text) => {
  // What is left of "$BOX/e#name" when BOX is empty.
  if (text.startsWith("/")) {
    throw new Error(
      `"${text}" has no site in front: the variable before it may be empty. A link looks like https://<site>${text}.`,
    );
  }
  const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  const fragment = url.hash.slice(1);
  // A site may live under a path (https://example.com/k): whatever comes
  // before /e or /i/<token> is part of the site.
  const sealed = /^((?:\/[^/]+)*)\/e$/.exec(url.pathname);
  if (sealed && fragment) {
    const { name, readToken, path } = splitFragment(fragment);
    const site = `${url.origin}${sealed[1]}`;
    // A read-only link (e#/<token>): no name, only the means to read.
    if (readToken !== undefined) return { kind: "sealed", site, name: "", readToken, path };
    const problem = secretNameProblem(name);
    if (problem) throw new Error(problem);
    return { kind: "sealed", site, name, path };
  }
  const shared = /^((?:\/[^/]+)*)\/i\/([A-Za-z0-9_-]{14})(.*)$/.exec(url.pathname);
  if (shared && fragment) {
    return {
      kind: "shared",
      base: `${url.origin}${shared[1]}/i/${shared[2]}`,
      suffix: shared[3],
      keyText: decodeURIComponent(fragment),
    };
  }
  return { kind: "plain", url: `${url.origin}${url.pathname}${url.search}` };
};

/** A namespace path split the same way for online and offline requests. */
const parseNamespacePath = (fullPath) => {
  // A query follows the path, and a trailing slash means the same as none.
  const [rawPath = "", query = ""] = fullPath.split("?", 2);
  const path = rawPath.replace(/\/+$/, "");
  const [rawFirst = "", second, ...extra] = path.split("/");
  return { path, query, first: decodeURIComponent(rawFirst), second, extra };
};

// --- Requests and output ----------------------------------------------------

/**
 * fetch, failing with which site could not be reached and why. A private
 * instance's key, in KUROBAKO_KEY, goes with every request unless the command
 * sends its own Authorization header; a locked namespace's write key, in
 * KUROBAKO_WRITE_KEY, unless it sends its own Write-Key.
 */
/** The write key of the encrypted namespace a command works on, derived from its name. */
let namespaceWriteKey = null;

const reach = async (url, init = {}) => {
  const key = globalThis.process?.env?.KUROBAKO_KEY;
  const writeKey = globalThis.process?.env?.KUROBAKO_WRITE_KEY ?? namespaceWriteKey;
  const headers = new Headers(init.headers);
  if (key && !headers.has("authorization")) headers.set("authorization", `Bearer ${key}`);
  // A locked namespace's write key: harmless where nothing is locked.
  if (writeKey && !headers.has("write-key")) headers.set("write-key", writeKey);
  try {
    return await fetch(url, { ...init, headers });
  } catch (error) {
    const reason = error.cause?.code ?? error.cause?.message ?? error.message;
    throw new Error(`Could not reach ${new URL(url).origin} (${reason}).`);
  }
};

/** Where every Kurobako server describes itself: its base path, version and rules. */
export const WELL_KNOWN_PATH = "/.well-known/kurobako";
const described = new Map();

/**
 * The description of the Kurobako server a URL belongs to, or null when there
 * is none. A server under a path (/k) answers at /k/.well-known/kurobako, and
 * at the domain's root if the site in front passes that on: the root is tried
 * first, then each leading part of the path.
 */
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

/**
 * Why a request failed, told better once the site is known: no Kurobako
 * server at all, or one of another version than this file (which may or may
 * not be the cause, so it is only a hint).
 */
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

/** Why this file and the server at `origin` do not understand each other. */
const protocolMismatch = (origin, config) =>
  `This k.mjs speaks the Kurobako protocol ${PROTOCOL} and the server ${config.protocol ?? "an older one"}; its own speaks it: curl -O ${origin}${config.clientUrl}`;

/**
 * Encrypted items open only with the server's protocol: checked before any,
 * rather than failing to decrypt.
 */
const requireProtocol = async (url) => {
  const config = await kurobakoConfig(url);
  if (config && config.protocol !== PROTOCOL) {
    throw new Error(protocolMismatch(new URL(url).origin, config));
  }
};

/**
 * An API request. Fails with the server's own error message, or says the site
 * is no Kurobako server when it answers like something else (an error without
 * Kurobako's JSON, or a web page). `page` allows a page as the answer.
 */
const call = async (url, init, { page = false } = {}) => {
  const response = await reach(url, init);
  const isPage = (response.headers.get("content-type") ?? "").startsWith("text/html");
  const body = response.ok ? null : await response.json().catch(() => null);
  if (response.ok && (page || !isPage)) return response;
  const message = body?.error ?? `Server error (${response.status}).`;
  throw new Error(await explainFailure(url, message));
};
const fetchBytes = async (url) => new Uint8Array(await (await call(url)).arrayBuffer());

const readInput = async (source) => {
  if (source === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return new Uint8Array(Buffer.concat(chunks));
  }
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(source));
};

/** -d's value: the text itself, @file or @- (standard input). */
/**
 * What -d sends, read as curl reads it: @file (or @- for standard input)
 * without its line breaks, which --data-binary keeps; --data-raw takes even
 * a leading @ as it is.
 */
const dataBytes = async ({ data, dataMode }) => {
  if (dataMode === "dataRaw" || !data.startsWith("@")) return encoder.encode(data);
  const bytes = await readInput(data.slice(1));
  return dataMode === "dataBinary" ? bytes : bytes.filter((byte) => byte !== 0x0a && byte !== 0x0d);
};

const writeStdout = (bytes) =>
  new Promise((resolve, reject) =>
    process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())),
  );

/** A server-chosen download name, preferring RFC 5987's encoded form. */
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
 * Contents go where curl would put them: -o <file>, -O (named after the URL,
 * or with -J after the item itself), or standard output,
 * which refuses binary data in a terminal unless asked with -o -. `isText` is
 * known before fetching, so a refused item is never consumed.
 */
const deliver = async ({ options, isText, ownName, urlName, load }) => {
  const forced = options.output === "-";
  const toFile = forced
    ? null
    : (options.output ?? (options.remoteName ? (options.headerName ? ownName : urlName) : null));
  if (!toFile && !forced && !isText && process.stdout.isTTY) {
    throw new Error(
      "Binary output can mess up your terminal: use -o <file>, -OJ, > file, or -o - to print it anyway.",
    );
  }
  const bytes = await load();
  if (!toFile) {
    await writeStdout(bytes);
    // Keeps the prompt on its own line after a text with no final newline.
    if (process.stdout.isTTY && bytes.at(-1) !== 0x0a) process.stdout.write("\n");
    return;
  }
  const { writeFile } = await import("node:fs/promises");
  // curl's -O and -o overwrite. -OJ protects a server-chosen name unless
  // --clobber is explicit; --no-clobber protects every output name.
  const exclusive = options.noClobber || (options.headerName && !options.clobber);
  try {
    await writeFile(toFile, bytes, { flag: exclusive ? "wx" : "w" });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`Refusing to overwrite ${toFile}: it already exists.`);
    throw error;
  }
  console.error(`Saved ${toFile} (${bytes.byteLength} bytes).`);
};

/** Names Windows refuses for a file, whatever the extension. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A file name that is safe to write anywhere: no directories, odd characters or reserved names. */
/** MP4 brands (an ISO media file's first "ftyp") that hold video. */
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

/**
 * What a file is, from its first bytes, as the server tells for plain files:
 * { kind: "image" | "video", extension, mime }, or null for anything else.
 */
export const detectMedia = (bytes) => {
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  const image = (extension, mime) => ({ kind: "image", extension, mime });
  const video = (extension, mime) => ({ kind: "video", extension, mime });
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
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") return image("avif", "image/avif");
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return image("heic", "image/heic");
    }
    if (brand === "qt  ") return video("mov", "video/quicktime");
    if (MP4_BRANDS.includes(brand)) return video("mp4", "video/mp4");
  }
  // Matroska and WebM: an EBML header, whose DocType (element 0x4282, a
  // one-byte size, then the name) tells which.
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
  return null;
};

/**
 * A file's metadata, by the rules the server applies to plain files: an
 * image or a video is told by its bytes and named with its own extension;
 * anything else is application/octet-stream under its own (safe) name.
 */
export const fileMetadata = (bytes, name) => {
  const media = detectMedia(bytes);
  // A file sent without a name is called "file", as on the server.
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

export const safeName = (name, fallback) => {
  const last = String(name || "")
    .split(/[\\/]/)
    .pop();
  // The same rules as the server's: letters, digits, ".", "_", "-" and spaces,
  // a short extension kept, no reserved name and no leading "-".
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
  // An empty name falls back, but keeps its extension.
  const named = base || fallback;
  const safe = WINDOWS_RESERVED.test(named) || named.startsWith("-") ? `_${named}` : named;
  return extension ? `${safe}.${extension}` : safe;
};

// --- Encrypted namespaces -----------------------------------------------------

/** The namespace's items, newest first, with their metadata decrypted. */
const openList = async (space, site) => {
  const items = await (await call(`${site}/e/${space.id}/ls`)).json();
  return Promise.all(
    items.map(async (item, index) => {
      const opened = await space.openItem(item.metadata, item.size).catch(() => null);
      return {
        number: index + 1,
        item,
        opened,
        // Its contents are at <namespace>/<id>, still sealed.
        contentUrl: `${site}/e/${space.id}/${item.id}`,
      };
    }),
  );
};

/** One item, by its position (1 is the newest) or its ID. */
/**
 * An item by its position (digits, 1 being the newest), its ID, or else its
 * name: a file's name or a text's title, the newest of that name. The server
 * cannot look up encrypted names, so the list is decrypted here.
 */
const lookUpIn = (entries, selector) => {
  if (/^\d+$/.test(selector)) return entries[Number(selector) - 1] ?? null;
  // A name, exactly; or else the start of one, ignoring case (newest first).
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

/**
 * An item as the plain API's JSON shows it, with the encrypted fields opened:
 * a text's name, a file's name and type.
 */
const itemJson = (item, metadata) => {
  const isImage = metadata?.mime?.startsWith("image/");
  return {
    id: item.id,
    createdAt: item.createdAt,
    ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    expiresAt: item.expiresAt,
    ...(item.burn ? { burn: true } : {}),
    kind: !metadata ? "unreadable" : metadata.kind === "text" ? "text" : isImage ? "image" : "file",
    ...(metadata?.kind === "text" ? { mime: TEXT_MIME } : {}),
    // Burn-after-reading texts have no name, as in the plain API.
    ...(metadata?.kind === "text" && !item.burn ? { name: metadata.title } : {}),
    ...(metadata?.kind === "file" ? { mime: metadata.mime, filename: metadata.filename } : {}),
    size: metadata?.size ?? item.size,
  };
};

/**
 * A text's own field, as the plain API gives it: the text, or a preview of
 * its first characters when it is too long to keep inline on the server (or,
 * with ?summary, longer than a preview). Burn-after-reading texts show none.
 */
const textJson = (text, size, { burn = false, summary = false, inlineLimit = Infinity } = {}) => {
  if (burn || text === null) return {};
  if (size > inlineLimit || (summary && text.length > TEXT_PREVIEW_CHARS)) {
    return { preview: text.slice(0, TEXT_PREVIEW_CHARS) };
  }
  return { text };
};

/** The server's limit for texts kept inline, from its description. */
const inlineLimitOf = async (url) => (await kurobakoConfig(url))?.inlineTextBytes ?? Infinity;

/**
 * What -O and -J call an item, as the server names plain downloads: its file
 * name, a text's name with .txt, or text-<id>.txt for a text without one.
 */
const ownName = (entry) => {
  const { kind, title, filename } = entry.opened.metadata;
  const fallback = `text-${entry.item.id ?? "shared"}.txt`;
  if (kind !== "text") return safeName(filename, "file");
  return title ? safeName(`${title}.txt`, fallback) : fallback;
};

const contentsOf = async (entry) =>
  entry.opened.open(entry.loadBody ? await entry.loadBody() : await fetchBytes(entry.contentUrl));

/** An entry's text or preview. Reading one consumes nothing. */
const entryText = async (entry, options = {}) => {
  const metadata = entry.opened?.metadata;
  if (metadata?.kind !== "text" || entry.item.burn) return {};
  const text = decoder.decode(await contentsOf(entry));
  return textJson(text, metadata.size, options);
};

/** One decrypted entry in the plain API's JSON shape. */
const entryJson = async (entry, options = {}) => ({
  ...itemJson(entry.item, entry.opened?.metadata),
  ...(await entryText(entry, options)),
});

const entriesJson = (entries, options = {}) =>
  Promise.all(entries.map((entry) => entryJson(entry, options)));

/** Sends one decrypted entry through the common curl-like output rules. */
const deliverEntry = (entry, options, urlName = ownName(entry)) =>
  deliver({
    options,
    isText: entry.opened.metadata.kind === "text",
    ownName: ownName(entry),
    urlName,
    load: () => contentsOf(entry),
  });

/** A plain item shaped like an opened encrypted one, for common output code. */
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

/** Decimal units, like the site's limits (100 MB, 64 kB). */
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

/** An item's title from its JSON: its text, preview or file name. */
const titleOf = (item, limit = Number.POSITIVE_INFINITY) => {
  if (item.kind === "unreadable") return "(could not decrypt)";
  const raw = item.name ?? item.text ?? item.preview ?? item.filename ?? "";
  if (!raw) return item.burn ? "(hidden until opened)" : "(empty)";
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/** Rows of cells as aligned columns; empty columns are left out. */
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

/** A queue, one line per item, newest first. */
const itemsTable = (items) =>
  items.length
    ? columns(
        items.map((item, index) => [
          String(index + 1),
          item.kind,
          titleOf(item, LIST_TITLE_CHARS),
          formatBytes(item.size),
          formatTime(item.createdAt),
          item.burn ? "deletes when opened" : "",
          item.id,
        ]),
        new Set([0, 3]),
      )
    : "The namespace is empty.";

const printJson = (value) => console.log(JSON.stringify(value, null, 2));

/** A decrypted entry as JSON for tables: a text's title stands in as its preview. */
const tableJson = (entry) => {
  const json = itemJson(entry.item, entry.opened?.metadata);
  const title = entry.opened?.metadata.title;
  return entry.opened?.metadata.kind === "text" && title ? { ...json, preview: title } : json;
};

/**
 * -O on the bare link: exports every item here under its own name, overwriting
 * as curl's -O does. Another item of the same name gets its ID in the name.
 * Burn-after-reading items stay unread.
 */
const saveAll = async (entries, options) => {
  const { writeFile } = await import("node:fs/promises");
  if (!entries.length) return console.log("The namespace is empty.");
  const taken = new Set();
  for (const entry of entries) {
    const label = `[${entry.number}] ${titleOf(tableJson(entry), LIST_TITLE_CHARS)}`;
    if (!entry.opened) {
      console.log(`${label}: skipped, could not decrypt`);
    } else if (entry.item.burn) {
      console.log(
        `${label}: skipped, it deletes when opened (read it with node k.mjs <link>/${entry.number})`,
      );
    } else {
      // Its own name, or with its ID when another file already has that name.
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

/** The read-only paths shared by extracted plain and encrypted backups. */
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
      // The server's inline limit is not recorded in a backup. Locally the
      // whole text is available; ?summary still requests a short preview.
      inlineLimit: Infinity,
    };
    printJson(await entriesJson(entries, listingOptions));
    return;
  }
  // As online, <item>.json means details unless an item has that exact ID or
  // filename. A backup cannot recreate the server-owned share URL.
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

/**
 * Opens an extracted backup, an item in it, or a read path below it. Encrypted
 * ones take #<secret>/<path>; KUROBAKO_SECRET may supply the secret. False
 * means the argument is not a local path.
 */
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
    // A virtual suffix such as backup/ls does not exist on disk. Walk only to
    // an explicitly named ancestor; a hostname must not turn into the cwd.
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
    // A missing virtual path without a manifest was a hostname after all.
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

const send = async (space, site, options, filename) => {
  const base = `${site}/e/${space.id}`;
  let contents;
  let metadata;
  if (options.upload !== null) {
    contents = await readInput(options.upload);
    metadata = fileMetadata(contents, filename || (options.upload === "-" ? "" : options.upload));
  } else {
    contents = await dataBytes(options);
    // A burn-after-reading text shows no preview anywhere.
    const title = options.burn ? "" : defaultTextName(decoder.decode(contents));
    metadata = { kind: "text", title, size: contents.byteLength };
  }
  const { header, body } = await space.sealItem(contents, metadata);
  const item = await (
    await call(`${base}/new`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Sealed-Metadata": header,
        ...(options.burn ? { Burn: "1" } : {}),
      },
      body,
    })
  ).json();
  // As in the plain API, a text comes back with its text, unless it burns.
  const text =
    metadata.kind === "text"
      ? textJson(decoder.decode(contents), metadata.size, {
          burn: options.burn,
          inlineLimit: await inlineLimitOf(`${base}/new`),
        })
      : {};
  printJson({ ...itemJson(item, metadata), ...text });
};

/**
 * One item as the plain API's <item>.json shows it, decrypted: its details,
 * its text unless it burns, its position and a share link with its key.
 */
const describeEntry = async (entry, base) => {
  const described = await (await call(`${base}/${entry.item.id}.json`)).json();
  return {
    ...(await entryJson(entry, { inlineLimit: await inlineLimitOf(`${base}/ls`) })),
    position: described.position,
    shareUrl: `${described.shareUrl}#${entry.opened.keyText}`,
  };
};

/**
 * Renames an encrypted item: its metadata, sealed again with its own key. An
 * empty name gives a text back its default, the start of its text.
 */
const rename = async (space, site, selector, given) => {
  const entry = await findEntry(space, site, selector);
  const name = given.replace(/\s+/g, " ").trim();
  const isText = entry.opened.metadata.kind === "text";
  let changes = isText ? { title: name } : { title: name, filename: name };
  if (isText && !name) {
    const text = entry.item.burn ? "" : decoder.decode(await contentsOf(entry));
    changes = { title: defaultTextName(text) };
  } else if (!name) {
    throw new Error("A file needs a name.");
  }
  const header = await entry.opened.withMetadata(changes);
  const item = await (
    await call(`${site}/e/${space.id}/${entry.item.id}/n`, {
      method: "POST",
      headers: { "X-Sealed-Metadata": header },
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

/** Replaces an encrypted text under its next revision, keeping its item key. */
const edit = async (space, site, selector, options) => {
  const entry = await findEntry(space, site, selector);
  if (entry.item.burn) throw new Error("An item that deletes when opened cannot be edited.");
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

/** The encrypted namespace, path by path, as the plain API answers it. */
const sealedRequest = async ({ site, name, readToken, path: fullPath }, options) => {
  await requireProtocol(`${site}/e`);
  const { path, query, first, second, extra } = parseNamespacePath(fullPath);
  const space =
    readToken !== undefined ? await openReadOnlySpace(readToken) : await openSealedSpace(name);
  // Opened by its name, it writes even when locked; by a read-only link, it has no key.
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

  // Locking: the key is the one the name gives, sent along by reach. Locked,
  // the answer adds the read-only link to hand out.
  if (path === "lock" && (method === "POST" || method === "DELETE")) {
    const response = await call(`${base}/lock`, { method });
    const answer = await response.json();
    return printJson(
      answer.locked ? { ...answer, readOnlyLink: `${site}/e#/${space.readToken}` } : answer,
    );
  }

  // Backups go as they are: the server sends items still encrypted, and a
  // backup is restored the same way.
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
      // curl -T photo.jpg <ns>/ sends to <ns>/photo.jpg: the path, if any, is the name.
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
  // .json is an item's JSON, unless an item has exactly that name.
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
    // Resolved here: the server cannot find an encrypted item by name.
    const entry = await findEntry(space, site, first);
    return printJson(await (await call(`${base}/${entry.item.id}`, { method: "DELETE" })).json());
  }
  if ((method === "GET" || method === "POST") && second === "s") {
    // The server's link, plus the item's key after the #, which it never sees.
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

/** A shared encrypted item: /i/<token>#key and its /c, /d and .json. */
const sharedRequest = async ({ base, suffix, keyText }, options) => {
  if (options.method !== "GET") throw new Error("A shared item can only be read.");
  await requireProtocol(base);
  const item = await (await call(`${base}.json`)).json();
  const opened = await openSharedItem(keyText, item.metadata, item.size);
  if (suffix === ".json") return printJson(itemJson(item, opened.metadata));
  if (!["", "/c", "/d"].includes(suffix)) throw new Error(`Unknown path "${suffix}".`);
  const entry = { item, opened, contentUrl: `${base}/c` };
  return deliverEntry(entry, options, suffix ? suffix.slice(1) : base.split("/").pop());
};

/**
 * Whether a plain link is a bare namespace (https://<site>/notes). With one
 * part in its path it is, at a site at the domain's root; with more, the site
 * may live under a path (https://example.com/k/notes), which the server says.
 */
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

/** Plain links go to the server as they are, like curl would send them. */
/**
 * Stays on a namespace's live connection and prints a line per change, for
 * scripts (`while read -r event id name`): "new <id> <name>", "moved <id>
 * <name>" (the same contents sent again), "changed <id> <name>", "gone <id>"
 * (deleted, expired or burnt), "locked", "unlocked". It starts from the queue
 * as it is, reconnects by itself and, once back, prints only what changed
 * meanwhile. `nameOf(item)` names an item (decrypting it if need be).
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
  /** What was last seen, by item ID: { name, createdAt, updatedAt }; null until the first queue. */
  let known = null;
  let locked = null;
  const names = new Map();
  const named = async (item) => {
    // Encrypted items change their sealed metadata when edited or renamed; plain ones, their name.
    const key = item.metadata ?? `${item.id}/${item.name ?? item.filename ?? ""}`;
    if (!names.has(key)) names.set(key, (await nameOf(item)) || "-");
    return names.get(key);
  };

  const apply = async ({ items, locked: nowLocked }) => {
    const seen = new Map();
    for (const item of items) {
      seen.set(item.id, {
        name: await named(item),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt ?? null,
      });
    }
    if (known) {
      // Oldest first, as they happened.
      for (const [id, now] of [...seen].reverse()) {
        const before = known.get(id);
        if (!before) print(`new ${id} ${now.name}`);
        else if (before.createdAt !== now.createdAt) print(`moved ${id} ${now.name}`);
        else if (before.updatedAt !== now.updatedAt) print(`changed ${id} ${now.name}`);
      }
      for (const id of known.keys()) if (!seen.has(id)) print(`gone ${id}`);
      if (Boolean(nowLocked) !== locked) print(nowLocked ? "locked" : "unlocked");
    }
    known = seen;
    locked = Boolean(nowLocked);
  };

  let delay = 1_000;
  while (true) {
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
        if (message.type !== "items") return;
        // One queue at a time, in order: naming one may take a moment.
        handled = handled.then(() => apply(message)).catch((error) => console.error(error.message));
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

const plainRequest = async ({ url }, options) => {
  // <namespace>/live: its changes, line by line, until stopped.
  const watched = url.replace(/\/live\/?$/, "");
  if (options.method === "GET" && watched !== url && (await isNamespace(watched))) {
    return watchLive(watched, (item) => item.name ?? item.filename ?? "");
  }
  // The bare namespace is a page; here it lists the items, like e#<name>, or
  // with -O saves them all.
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
    // The edit route is conditional. Fetch the item's current version unless
    // the caller supplied its own If-Match, keeping the command curl-like.
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
    // curl -T file <url>/ appends the file's name; here a bare namespace gets
    // it too, with or without the slash.
    if (options.upload !== "-" && (await isNamespace(target))) {
      target = `${target.replace(/\/$/, "")}/${encodeURIComponent(safeName(options.upload, "file"))}`;
    }
  }
  const response = await reach(target, { method: options.method, headers, body });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    // Kurobako answers errors as {"error": …}; anything else is another kind of site.
    let error = null;
    try {
      error = JSON.parse(decoder.decode(bytes))?.error ?? null;
    } catch {}
    // As for an encrypted namespace: the error itself, on standard error.
    throw new Error(await explainFailure(url, error ?? `Server error (${response.status}).`));
  }
  // The server's JSON (a list, an item's details, a sent item) printed as it
  // is for an encrypted namespace, unless it is going to a file.
  if (/^application\/json/.test(type) && options.output === null && !options.remoteName) {
    try {
      return printJson(JSON.parse(decoder.decode(bytes)));
    } catch {}
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const urlName = new URL(target).pathname.split("/").pop() || "index";
  return deliver({
    options,
    isText: /^(text\/|application\/json)/.test(type),
    ownName: safeName(contentDispositionName(disposition), urlName),
    urlName,
    load: async () => bytes,
  });
};

const main = async (args) => {
  // Asking for help is not an error: it goes to standard output.
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return;
  }
  try {
    const parsed = parseArgs(args);
    if (!parsed) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    if (await localRequest(parsed.link, parsed.options)) return;
    const target = parseLink(parsed.link);
    if (target.kind === "sealed") return await sealedRequest(target, parsed.options);
    if (target.kind === "shared") return await sharedRequest(target, parsed.options);
    return await plainRequest(target, parsed.options);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
};

if (await runningAsScript()) await main(process.argv.slice(2));
