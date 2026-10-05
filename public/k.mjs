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
// One PBKDF2 run turns the secret name into 256 bits: the first half is the
// namespace ID the server sees, the second half the namespace key, which
// never leaves the client. The salt and iteration count are part of the
// protocol: changing them makes every existing encrypted namespace unreadable.
//
// Each item gets its own random AES-GCM key, which encrypts its contents and
// its metadata. The namespace key only wraps that item key (AES-KW), so handing out an
// item key (in a share link) reveals that one item and nothing else.
const PROTOCOL_SALT = "kurobako/sealed/v3";
const PBKDF2_ITERATIONS = 600_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** What encryption adds to a file's size: the IV in front and the AES-GCM tag. */
export const SEALED_OVERHEAD_BYTES = IV_BYTES + TAG_BYTES;
/**
 * One PBKDF2-SHA256 block (32 bytes): the first half is the namespace ID, the
 * second the namespace key. A second block would double the cost of opening a
 * namespace without costing a guesser anything, since the ID alone checks a
 * guess. All keys are AES-128: the name, not the key, is what a guesser faces.
 */
const DERIVED_BITS = 256;
const ID_BYTES = 16;
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
 * `title`, left out when empty. The size is the sealed body's, less
 * SEALED_OVERHEAD_BYTES.
 */
const packMetadata = ({ kind, title, filename, mime }) =>
  kind === "file"
    ? { filename, ...(mime && mime !== OCTET_STREAM ? { mime } : {}) }
    : title
      ? { title }
      : {};

/** Metadata as clients use it: { kind, title, filename?, mime?, size }. */
const unpackMetadata = (packed, sealedSize) => {
  const size = Math.max(0, (sealedSize ?? SEALED_OVERHEAD_BYTES) - SEALED_OVERHEAD_BYTES);
  return typeof packed.filename === "string"
    ? {
        kind: "file",
        title: packed.filename,
        filename: packed.filename,
        mime: packed.mime ?? OCTET_STREAM,
        size,
      }
    : { kind: "text", title: packed.title ?? "", size };
};
const OCTET_STREAM = "application/octet-stream";

/** IV followed by the AES-GCM ciphertext and tag. */
const sealWith = async (key, bytes) => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes),
  );
  const sealed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(ciphertext, IV_BYTES);
  return sealed;
};

const openWith = async (key, sealed) => {
  const bytes = new Uint8Array(sealed);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES) },
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

export const splitFragment = (fragment) => {
  const cut = fragment.indexOf(NAME_PATH_SEPARATOR);
  const name = cut === -1 ? fragment : fragment.slice(0, cut);
  return {
    name: normalizeSecretName(decodeURIComponent(name)),
    path: cut === -1 ? "" : fragment.slice(cut + 1),
  };
};

export const encryptionAvailable = () => Boolean(globalThis.crypto?.subtle);

export const openSealedSpace = async (secretName) => {
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
  const bits = new Uint8Array(
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
  const namespaceKey = await importWrappingKey(bits.subarray(ID_BYTES));

  return {
    id: toBase64Url(bits.subarray(0, ID_BYTES)),

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
        encoder.encode(JSON.stringify(packMetadata(metadata))),
      );
      return {
        header: `${toBase64Url(wrappedKey)}.${toBase64Url(sealedMetadata)}`,
        body: await sealWith(itemKey, bytes),
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
  const itemKey = await importKey(fromBase64Url(keyText));
  const packed = JSON.parse(decoder.decode(await openWith(itemKey, fromBase64Url(sealedMetadata))));
  return {
    metadata: unpackMetadata(packed, sealedSize),
    keyText,
    open: (bytes) => openWith(itemKey, bytes),
    sealMetadata: async (changed) =>
      toBase64Url(await sealWith(itemKey, encoder.encode(JSON.stringify(packMetadata(changed))))),
  };
};

// --- Command line ------------------------------------------------------------

/** This file's version, the same as the server it comes from (package.json). */
export const VERSION = "0.5.0";
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
  node k.mjs -O <site>/e#<name>               every item saved here
  node k.mjs -d 'hello' <site>/e#<name>/new   sends a text (-d @file, -d @- for stdin)
  node k.mjs -T photo.jpg <site>/e#<name>/    sends a file
  node k.mjs -H burn:1 -d 'once' <site>/e#<name>/new
  node k.mjs -d 'new name' <site>/e#<name>/1/n   renames it (empty: a text's default)
  node k.mjs -X DELETE <site>/e#<name>/1
  node k.mjs <site>/e#<name>/1/s              a link to share it, with its key
  node k.mjs <site>/i/<token>#<key>           a shared item

Options: -d, -T, -X, -H, -o <file>, -O, -J (and -s, -S, -L, -f, -p, ignored).
As with curl, -d @file drops line breaks; --data-binary @file keeps them.
-h or --help shows this.
Plain links (<site>/<namespace>/...) work too, passed through as they are.`;

/** What the plain API says a text is. */
const TEXT_MIME = "text/plain; charset=utf-8";
/** Texts in lists are cut to this many characters with ?summary, as on the server. */
export const TEXT_PREVIEW_CHARS = 280;
/** An item: its position (1 is the newest) or its six-letter ID. */
const ITEM_PATTERN = /^(?:[1-9][0-9]{0,3}|[a-z]{6})$/;
const BURN_VALUES = new Set(["1", "true", "yes"]);

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
      else if (!IGNORED.has(arg)) throw new Error(`Unknown option ${arg}.`);
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
    const { name, path } = splitFragment(fragment);
    const problem = secretNameProblem(name);
    if (problem) throw new Error(problem);
    return { kind: "sealed", site: `${url.origin}${sealed[1]}`, name, path };
  }
  const shared = /^((?:\/[^/]+)*)\/i\/((?:[A-Za-z0-9_-]{2})?[A-Za-z0-9_-]{12})(.*)$/.exec(
    url.pathname,
  );
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

// --- Requests and output ----------------------------------------------------

/** fetch, failing with which site could not be reached and why. */
const reach = async (url, init) => {
  try {
    return await fetch(url, init);
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
  if (config.version && config.version !== VERSION) {
    return `${message}\nThis k.mjs is ${VERSION} and the server is ${config.version}; its own matches it: curl -O ${origin}${config.clientUrl ?? `${config.base ?? ""}/k.mjs`}`;
  }
  return message;
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

/**
 * Contents go where curl would put them: -o <file>, -O (named after the URL,
 * or with -J after the item itself, never overwriting), or standard output,
 * which refuses binary data in a terminal. `isText` is known before fetching,
 * so a refused item is never consumed.
 */
const deliver = async ({ options, isText, ownName, urlName, load }) => {
  const toFile =
    options.output ?? (options.remoteName ? (options.headerName ? ownName : urlName) : null);
  if (!toFile && !isText && process.stdout.isTTY) {
    throw new Error("Binary output can mess up your terminal: use -o <file>, -OJ, or > file.");
  }
  const bytes = await load();
  if (!toFile) {
    await writeStdout(bytes);
    // Keeps the prompt on its own line after a text with no final newline.
    if (process.stdout.isTTY && bytes.at(-1) !== 0x0a) process.stdout.write("\n");
    return;
  }
  const { writeFile } = await import("node:fs/promises");
  try {
    await writeFile(toFile, bytes, { flag: options.output ? "w" : "wx" });
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
/**
 * The image a file is, from its first bytes, as the server tells for plain
 * files: { mime, extension }, or null for anything else.
 */
export const detectImage = (bytes) => {
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && PNG.every((byte, index) => bytes[index] === byte)) {
    return { mime: "image/png", extension: "png" };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", extension: "jpg" };
  }
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return { mime: "image/gif", extension: "gif" };
  }
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return { mime: "image/webp", extension: "webp" };
  }
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", extension: "avif" };
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) {
      return { mime: "image/heic", extension: "heic" };
    }
  }
  return null;
};

/**
 * A file's metadata, by the rules the server applies to plain files: an
 * image is told by its bytes and named with its own extension; anything else
 * is application/octet-stream under its own (safe) name.
 */
export const fileMetadata = (bytes, name) => {
  const image = detectImage(bytes);
  // A file sent without a name is called "file", as on the server.
  const filename = image
    ? `${safeName(
        String(name || "file")
          .split(/[\\/]/)
          .pop()
          .replace(/\.[^.]+$/, ""),
        "image",
      )}.${image.extension}`
    : safeName(name, "file");
  return {
    kind: "file",
    title: filename,
    filename,
    mime: image?.mime ?? "application/octet-stream",
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
const lookUp = async (space, site, selector) => {
  const entries = await openList(space, site);
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
const findEntry = async (space, site, selector) => {
  const entry = await lookUp(space, site, selector);
  if (!entry) throw new Error("Item not found.");
  if (!entry.opened) throw new Error("This item could not be decrypted.");
  return entry;
};

/**
 * An item as the plain API's JSON shows it, with the encrypted fields opened:
 * a text's name, a file's name and type.
 */
const itemJson = (item, metadata) => {
  const isImage = metadata?.mime?.startsWith("image/");
  return {
    id: item.id,
    createdAt: item.createdAt,
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

const contentsOf = async (entry) => entry.opened.open(await fetchBytes(entry.contentUrl));

/** Decimal units, like the site's limits (100 MB, 256 kB). */
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

/** -O on the bare link: every item saved here. Burn-after-reading items stay unread. */
const saveAll = async (entries) => {
  const { writeFile } = await import("node:fs/promises");
  if (!entries.length) return console.log("The namespace is empty.");
  for (const entry of entries) {
    const label = `[${entry.number}] ${titleOf(tableJson(entry), LIST_TITLE_CHARS)}`;
    if (!entry.opened) {
      console.log(`${label}: skipped, could not decrypt`);
    } else if (entry.item.burn) {
      console.log(
        `${label}: skipped, it deletes when opened (read it with node k.mjs <link>/${entry.number})`,
      );
    } else {
      let name = ownName(entry);
      const bytes = await contentsOf(entry);
      try {
        await writeFile(name, bytes, { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        name = `${Date.now()}-${name}`;
        await writeFile(name, bytes, { flag: "wx" });
      }
      console.log(`${label} → ${name}`);
    }
  }
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
 * An entry's text or preview (see textJson). Reading one consumes nothing:
 * burn-after-reading texts are never read here.
 */
const entryText = async (entry, options = {}) => {
  const metadata = entry.opened?.metadata;
  if (metadata?.kind !== "text" || entry.item.burn) return {};
  const text = decoder.decode(await contentsOf(entry));
  return textJson(text, metadata.size, options);
};

/**
 * One item as the plain API's <item>.json shows it, decrypted: its details,
 * its text unless it burns, its position and a share link with its key.
 */
const describeEntry = async (entry, base) => {
  const described = await (await call(`${base}/${entry.item.id}.json`)).json();
  return {
    ...itemJson(entry.item, entry.opened.metadata),
    ...(await entryText(entry, { inlineLimit: await inlineLimitOf(`${base}/ls`) })),
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
  printJson({
    ...itemJson(item, renamed.opened.metadata),
    ...(await entryText(renamed, { inlineLimit: await inlineLimitOf(`${site}/e/${space.id}/ls`) })),
  });
};

/** The encrypted namespace, path by path, as the plain API answers it. */
const sealedRequest = async ({ site, name, path: fullPath }, options) => {
  // A query goes after the path, as in a URL: <link>/ls?summary.
  const [path = "", query = ""] = fullPath.split("?", 2);
  const space = await openSealedSpace(name);
  const base = `${site}/e/${space.id}`;
  const { method } = options;
  const [rawFirst = "", second, ...extra] = path.split("/");
  // Names may be written percent-encoded, as in a URL.
  const first = decodeURIComponent(rawFirst);
  const sending = options.data !== null || options.upload !== null;
  const FIXED = new Set(["", "ls", "new", "log", "log.json", "live"]);

  if (sending) {
    if (options.data !== null && path === "new" && method === "POST")
      return send(space, site, options);
    if (options.data !== null && second === "n" && !FIXED.has(first) && !extra.length) {
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
    return options.remoteName ? saveAll(entries) : console.log(itemsTable(entries.map(tableJson)));
  }
  if (path === "ls" && method === "GET") {
    const entries = await openList(space, site);
    const options = {
      summary: new URLSearchParams(query).has("summary"),
      inlineLimit: await inlineLimitOf(`${base}/ls`),
    };
    const items = await Promise.all(
      entries.map(async (entry) => ({
        ...itemJson(entry.item, entry.opened?.metadata),
        ...(await entryText(entry, options)),
      })),
    );
    return printJson(items);
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
    FIXED.has(first) ||
    extra.length ||
    (second !== undefined && second !== "d" && second !== "s")
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
    return deliver({
      options,
      isText: entry.opened.metadata.kind === "text",
      ownName: ownName(entry),
      urlName: second ?? first,
      load: () => contentsOf(entry),
    });
  }
  throw new Error(`${method} is not used on "${path}". See: node k.mjs`);
};

/** A shared encrypted item: /i/<token>#key and its /c, /d and .json. */
const sharedRequest = async ({ base, suffix, keyText }, options) => {
  if (options.method !== "GET") throw new Error("A shared item can only be read.");
  const item = await (await call(`${base}.json`)).json();
  const opened = await openSharedItem(keyText, item.metadata, item.size);
  if (suffix === ".json") return printJson(itemJson(item, opened.metadata));
  if (!["", "/c", "/d"].includes(suffix)) throw new Error(`Unknown path "${suffix}".`);
  const entry = { item, opened, contentUrl: `${base}/c` };
  return deliver({
    options,
    isText: opened.metadata.kind === "text",
    ownName: ownName(entry),
    urlName: suffix ? suffix.slice(1) : base.split("/").pop(),
    load: () => contentsOf(entry),
  });
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
const plainRequest = async ({ url }, options) => {
  // The bare namespace is a page; here it lists the items, like e#<name>.
  if (options.method === "GET" && (await isNamespace(url))) {
    const items = await (await call(`${url.replace(/\/$/, "")}/ls?summary`)).json();
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
    const explained = await explainFailure(url, error ?? `Server error (${response.status}).`);
    // Kurobako's own error, with nothing to add, prints as curl would show it.
    if (explained !== error) throw new Error(explained);
    process.exitCode = 1;
    return writeStdout(bytes);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const headerName = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
  return deliver({
    options,
    isText: /^(text\/|application\/json)/.test(type),
    ownName: safeName(
      headerName ? decodeURIComponent(headerName) : "",
      new URL(target).pathname.split("/").pop(),
    ),
    urlName: new URL(target).pathname.split("/").pop() || "index",
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
