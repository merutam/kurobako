// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Kurobako contributors

// The home page: opening a namespace, plain or encrypted (with a random
// name, and how strong a typed one is).
import { element, readConfig, SITE } from "./common.js";
import { encryptionAvailable, normalizeSecretName, secretNameProblem } from "./k.mjs";
import { createStatus } from "./status.js";

const form = element("#namespace-form");
const input = element("#namespace");
const prefix = element("#namespace-prefix");
const pageTitle = element("#page-title");
const hint = element("#namespace-hint");
const strength = element("#name-strength");
const encrypted = element("#encrypted");
const e2eeHelp = element("#e2ee-help");
const e2eeDialog = element("#e2ee-dialog");
const randomButton = element("#random-name");
const status = createStatus(element("#home-status"));
/** Lowercase letters and digits are valid in both modes. */
const RANDOM_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

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
    ? `E2EE. Max ${config.sealed.maxNameLength} characters.`
    : `a-z, 0-9, _ and -. Max ${config.namespace.maxLength} characters.${encrypted.disabled ? " Encryption needs HTTPS." : ""}`;
  status.clear();
  showStrength();
};

encrypted.addEventListener("change", updateMode);
e2eeHelp.addEventListener("click", () => e2eeDialog.showModal());
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
    encrypted.checked = false;
  }
  updateMode();
} catch (error) {
  form.querySelector("button[type=submit]").disabled = true;
  status.error(`Could not load settings: ${error.message}`);
}
