import { openSealedSpace } from "../../public/k.mjs";
import { defined } from "../support";
import type { Harness } from "./index";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LIMIT_TEST_MS = 60_000;
const parse = async <T = unknown>(response: Response | Promise<Response>) =>
  (await response).json() as Promise<T>;
type PublicConfig = { namespace: { pattern: string; reserved: string[] } };

export const toolsOf = (harness: Harness) => {
  const { call } = harness;
  const json = async <T = unknown>(path: string, init?: RequestInit) =>
    parse<T>(await call(path, init));
  const sendText = (namespace: string, text: string, headers: Record<string, string> = {}) =>
    call(`/${namespace}/new`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8", ...headers },
      body: text,
    });
  const shareLink = async (path: string, init?: RequestInit) =>
    new URL((await (await call(path, init)).text()).trim()).pathname;
  /** Storage is shared between tests, so every test uses fresh namespaces. */
  const fresh = (prefix = "t") => `${prefix}${crypto.randomUUID().slice(0, 8)}`;
  const freshSealedId = () =>
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  const freshSealedSpace = () => openSealedSpace(`test ${crypto.randomUUID()}`);
  const embeddedItem = (page: string) =>
    JSON.parse(
      defined(
        page.match(/<script type="application\/json" id="item-data">(.*?)<\/script>/s)?.[1],
        "the embedded item",
      ),
    );
  return { json, sendText, shareLink, fresh, freshSealedId, freshSealedSpace, embeddedItem };
};

export type Tools = ReturnType<typeof toolsOf>;
export { LIMIT_TEST_MS, type PublicConfig, parse, png };
