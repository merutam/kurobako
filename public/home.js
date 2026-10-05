// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

import { readConfig, SITE } from "./common.js";
import { encryptionAvailable, normalizeSecretName, secretNameProblem } from "./k.mjs";
import { createStatus } from "./status.js";

const element = (selector) => {
  const found = document.querySelector(selector);
  if (!found) throw new Error("Something went wrong. Reload the page.");
  return found;
};

const form = element("#namespace-form");
const input = element("#namespace");
const prefix = element("#namespace-prefix");
const pageTitle = element("#page-title");
const hint = element("#namespace-hint");
const strength = element("#name-strength");
const encrypted = element("#encrypted");
const encryptedHint = element("#encrypted-hint");
const randomButton = element("#random-name");
const status = createStatus(element("#home-status"));
const maxItems = element("#max-items");
const expiry = element("#expiry");

const numberFormatter = new Intl.NumberFormat();
const regionNames = new Intl.DisplayNames(undefined, { type: "region" });
const countryName = (code) => {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    // Some proxies use non-ISO codes such as "XX" (unknown) and "T1" (Tor).
    return code;
  }
};
/** Lowercase letters and digits are valid in both modes. */
const RANDOM_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

const formatDuration = (seconds) => {
  const units = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ];
  const [unit, size] = units.find(([, size]) => seconds >= size) ?? units.at(-1);
  const value = Math.round(seconds / size);
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
};

const fetchJson = async (url) => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Server error (${response.status}).`);
  return response.json();
};

const RANDOM_NAME_CHARACTERS = 16;
/** Four groups of four characters: 80 bits, far beyond guessing. */
const randomName = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_NAME_CHARACTERS));
  const characters = [...bytes].map((byte) => RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length]);
  return [0, 4, 8, 12].map((start) => characters.slice(start, start + 4).join("")).join("-");
};
const RANDOM_NAME_PATTERN = new RegExp(`^[${RANDOM_ALPHABET}]{4}(?:-[${RANDOM_ALPHABET}]{4}){3}$`);

/**
 * Bits a guesser faces, estimated on the safe side. A Random name has 80. A
 * name someone typed is far less random than it looks (words, dates, names),
 * so it counts at most 2.5 bits a character, and a repeated character adds
 * nothing. Strength is what someone holding the server's data would face:
 * they can test guesses offline against the namespace ID.
 */
const HUMAN_BITS_PER_CHARACTER = 2.5;
const STRENGTH = [
  {
    level: "weak",
    below: 45,
    text: "Weak name: easy to guess. Use Random name for anything private.",
  },
  { level: "fair", below: 80, text: "Fair name: hard to guess, though Random name is safer." },
  { level: "strong", below: Number.POSITIVE_INFINITY, text: "Strong name." },
];
const estimateBits = (name) => {
  if (RANDOM_NAME_PATTERN.test(name) && new Set(name.replaceAll("-", "")).size >= 8) {
    return RANDOM_NAME_CHARACTERS * Math.log2(RANDOM_ALPHABET.length);
  }
  const characters = [...name];
  const varied = characters.filter(
    (character, index) => character !== characters[index - 1],
  ).length;
  return varied * HUMAN_BITS_PER_CHARACTER;
};

const showStrength = () => {
  const name = input.value.trim();
  strength.hidden = !encrypted.checked || !name;
  if (strength.hidden) return;
  const bits = estimateBits(name);
  const { level, text } = STRENGTH.find((step) => bits < step.below);
  strength.dataset.level = level;
  strength.textContent = text;
};

let config = null;
let rules = null;

const updateMode = () => {
  const sealed = encrypted.checked;
  input.placeholder = sealed ? "a long secret name" : "myns";
  prefix.textContent = sealed ? "/e#" : "/";
  pageTitle.textContent = prefix.textContent;
  input.maxLength = sealed ? config.sealed.maxNameLength : config.namespace.maxLength;
  hint.textContent = sealed
    ? `Any text without "/", max ${config.sealed.maxNameLength} characters. Longer is safer: use Random name.`
    : `a-z, 0-9, _ and -. Max ${config.namespace.maxLength} characters.`;
  status.clear();
  showStrength();
};

encrypted.addEventListener("change", updateMode);
input.addEventListener("input", showStrength);
randomButton.addEventListener("click", () => {
  input.value = randomName();
  showStrength();
  input.focus();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!rules) return;

  if (encrypted.checked) {
    const name = normalizeSecretName(input.value);
    const problem = secretNameProblem(name, config.sealed.maxNameLength);
    if (problem) {
      status.error(problem);
      input.focus();
      return;
    }
    window.location.assign(`${SITE}/e#${encodeURIComponent(name)}`);
    return;
  }

  const namespace = input.value.trim().toLowerCase();
  if (!rules.pattern.test(namespace)) {
    status.error(`Invalid name. ${hint.textContent}`);
    input.focus();
    return;
  }
  if (rules.reserved.has(namespace)) {
    status.error("Reserved name.");
    input.focus();
    return;
  }
  window.location.assign(`${SITE}/${encodeURIComponent(namespace)}`);
});

try {
  config = readConfig();
  rules = {
    pattern: new RegExp(config.namespace.pattern),
    reserved: new Set(config.namespace.reserved),
  };
  if (!encryptionAvailable()) {
    encrypted.disabled = true;
    encryptedHint.textContent = "Needs HTTPS.";
  }
  updateMode();
  maxItems.textContent = numberFormatter.format(config.maxItems);
  expiry.textContent = config.itemTtlSeconds ? formatDuration(config.itemTtlSeconds) : "Never";
} catch (error) {
  form.querySelector("button[type=submit]").disabled = true;
  maxItems.textContent = expiry.textContent = "?";
  status.error(`Could not load settings: ${error.message}`);
}

/** One country per line, so a long list stays readable. */
const countryLines = (countries) => {
  if (!countries.length) return ["—"];
  return countries.flatMap(({ country, visitors }, index) => [
    ...(index ? [document.createElement("br")] : []),
    `${countryName(country)} (${numberFormatter.format(visitors)})`,
  ]);
};

// Each cell names its /stats.json field in data-stat; numbers need no entry here.
// A format returns the cell's contents: text and elements.
const statFormats = {
  topCountriesLast24h: countryLines,
};
const statCells = document.querySelectorAll("[data-stat]");

try {
  const stats = await fetchJson(`${SITE}/stats.json`);
  for (const cell of statCells) {
    const value = stats[cell.dataset.stat];
    const format = statFormats[cell.dataset.stat] ?? ((number) => numberFormatter.format(number));
    const contents = value === undefined ? "?" : format(value);
    cell.replaceChildren(...[contents].flat());
  }
} catch {
  for (const cell of statCells) cell.textContent = "?";
}
