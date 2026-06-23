#!/usr/bin/env node
// Cowart Seedream - standalone bring-your-own-key image generation for the
// Cowart canvas.
//
// It generates images through Doubao Seedream (Volcengine Ark, default) or any
// OpenAI-compatible image API, then inserts them into the running Cowart canvas
// through Cowart's local HTTP API (GET/PUT /api/canvas). It NEVER modifies the
// Cowart project source; it only talks to the running canvas service and writes
// into the project's canvas/ data directory, exactly like Cowart itself does.
//
// Zero npm dependencies: the tldraw fractional index generator below is vendored
// from `fractional-indexing` (CC0-1.0, rocicorp), so the plugin runs with a bare
// `node ./mcp/server.mjs` on any OS without an install step.

import { copyFile, mkdir, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import readline from "node:readline";

/* ------------------------------------------------------------------ *
 * Vendored fractional-indexing (CC0-1.0)
 * https://github.com/rocicorp/fractional-indexing
 * ------------------------------------------------------------------ */
const BASE_62_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function fiMidpoint(a, b, digits) {
  const zero = digits[0];
  if (b != null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) throw new Error("trailing zero");
  if (b) {
    let n = 0;
    while ((a[n] || zero) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + fiMidpoint(a.slice(n), b.slice(n), digits);
  }
  const digitA = a ? digits.indexOf(a[0]) : 0;
  const digitB = b != null ? digits.indexOf(b[0]) : digits.length;
  if (digitB - digitA > 1) {
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return digits[midDigit];
  }
  if (b && b.length > 1) return b.slice(0, 1);
  return digits[digitA] + fiMidpoint(a.slice(1), null, digits);
}

function fiGetIntegerLength(head) {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function fiGetIntegerPart(key) {
  const len = fiGetIntegerLength(key[0]);
  if (len > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, len);
}

function fiValidateInteger(int) {
  if (int.length !== fiGetIntegerLength(int[0])) throw new Error(`invalid integer part of order key: ${int}`);
}

function fiValidateOrderKey(key, digits) {
  if (key === `A${digits[0].repeat(26)}`) throw new Error(`invalid order key: ${key}`);
  const i = fiGetIntegerPart(key);
  const f = key.slice(i.length);
  if (f.slice(-1) === digits[0]) throw new Error(`invalid order key: ${key}`);
}

function fiIncrementInteger(x, digits) {
  fiValidateInteger(x);
  const [head, ...digs] = x.split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) + 1;
    if (d === digits.length) {
      digs[i] = digits[0];
    } else {
      digs[i] = digits[d];
      carry = false;
    }
  }
  if (carry) {
    if (head === "Z") return `a${digits[0]}`;
    if (head === "z") return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > "a") digs.push(digits[0]);
    else digs.pop();
    return h + digs.join("");
  }
  return head + digs.join("");
}

function fiDecrementInteger(x, digits) {
  fiValidateInteger(x);
  const [head, ...digs] = x.split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i]) - 1;
    if (d === -1) {
      digs[i] = digits.slice(-1);
    } else {
      digs[i] = digits[d];
      borrow = false;
    }
  }
  if (borrow) {
    if (head === "a") return `Z${digits.slice(-1)}`;
    if (head === "A") return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < "Z") digs.push(digits.slice(-1));
    else digs.pop();
    return h + digs.join("");
  }
  return head + digs.join("");
}

function generateKeyBetween(a, b, digits = BASE_62_DIGITS) {
  if (a != null) fiValidateOrderKey(a, digits);
  if (b != null) fiValidateOrderKey(b, digits);
  if (a != null && b != null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a == null) {
    if (b == null) return `a${digits[0]}`;
    const ib = fiGetIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ib === `A${digits[0].repeat(26)}`) return ib + fiMidpoint("", fb, digits);
    if (ib < b) return ib;
    const res = fiDecrementInteger(ib, digits);
    if (res == null) throw new Error("cannot decrement any more");
    return res;
  }
  if (b == null) {
    const ia = fiGetIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = fiIncrementInteger(ia, digits);
    return i == null ? ia + fiMidpoint(fa, null, digits) : i;
  }
  const ia = fiGetIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = fiGetIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + fiMidpoint(fa, fb, digits);
  const i = fiIncrementInteger(ia, digits);
  if (i == null) throw new Error("cannot increment any more");
  if (i < b) return i;
  return ia + fiMidpoint(fa, null, digits);
}

/* ------------------------------------------------------------------ *
 * Server + provider constants
 * ------------------------------------------------------------------ */
const SERVER_NAME = "Cowart Seedream MCP";
const SERVER_VERSION = "0.1.0";
const TOOL_GENERATE = "generate_seedream_image";
const PAGE_ID_PREFIX = "page:";
const PAGE_ASSETS_ROUTE = "/page-assets/";

const PROVIDER_DEFAULTS = {
  doubao: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seedream-5-0-260128",
  },
  openai: {
    baseUrl: "https://sub.g-aisc.com/v1",
    model: "gpt-image-2",
  },
};

// Doubao Seedream WxH size constraints: total pixels in
// [2560x1440 = 3,686,400, 4096x4096 = 16,777,216], aspect ratio in [1/16, 16].
const DOUBAO_MIN_PIXELS = 3686400;
const DOUBAO_MAX_PIXELS = 16777216;
const DOUBAO_MAX_SIDE = 4096;
const DOUBAO_MULTIPLE = 16;
const DOUBAO_BUDGET_PIXELS = 4194304; // ~2048x2048 (2K class)
const DOUBAO_RECOMMENDED = [
  { r: 1, w: 2048, h: 2048 },
  { r: 4 / 3, w: 2304, h: 1728 },
  { r: 3 / 4, w: 1728, h: 2304 },
  { r: 16 / 9, w: 2560, h: 1440 },
  { r: 9 / 16, w: 1440, h: 2560 },
  { r: 3 / 2, w: 2496, h: 1664 },
  { r: 2 / 3, w: 1664, h: 2496 },
  { r: 21 / 9, w: 3024, h: 1296 },
  { r: 9 / 21, w: 1296, h: 3024 },
];

// OpenAI-compatible proxy size constraints (matches the Easel/g-aisc defaults).
const OPENAI_MIN_PIXELS = 655360;
const OPENAI_MAX_PIXELS = 8294400;
const OPENAI_MAX_SIDE = 4096;
const OPENAI_MAX_RATIO = 3;
const OPENAI_MULTIPLE = 16;
const OPENAI_BUDGET_PIXELS = 1600000;

const IMAGE_REQUEST_TIMEOUT_MS = 180000;

const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
function roundToMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}
function floorToMultiple(value, multiple) {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}
function pathResolve(value) {
  return resolve(String(value));
}

/* ------------------------------------------------------------------ *
 * Environment + provider resolution (with Windows user-env fallback)
 * ------------------------------------------------------------------ */
function readWindowsUserEnv(name) {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "i"));
      if (match?.[1]?.trim()) return match[1].trim();
    }
  } catch {
    return null;
  }
  return null;
}

function envValue(...names) {
  for (const name of names) {
    const direct = nonEmptyString(process.env[name]);
    if (direct) return direct;
  }
  for (const name of names) {
    const fromRegistry = nonEmptyString(readWindowsUserEnv(name));
    if (fromRegistry) return fromRegistry;
  }
  return null;
}

// A base URL / model string that points at Doubao (Volcengine Ark).
function looksLikeDoubao(value) {
  return typeof value === "string" && /(volces\.com|\/api\/v3|ark|doubao|seedream)/i.test(value);
}

// Provider resolution: an explicit provider (arg/env) wins; otherwise infer from
// the base URL (Ark-like -> doubao, any other custom base URL -> openai-compatible);
// with nothing configured, default to doubao.
function resolveProvider(args = {}) {
  const explicit = nonEmptyString(args.provider) || envValue("COWART_IMAGE_PROVIDER", "COWART_SEEDREAM_PROVIDER");
  if (explicit) {
    const value = explicit.toLowerCase();
    if (/(doubao|seedream|ark|volc)/.test(value)) return "doubao";
    if (/(openai|gaisc|g-aisc|compat)/.test(value)) return "openai";
  }
  const baseUrl = nonEmptyString(args.baseUrl) || envValue("COWART_IMAGE_BASE_URL");
  if (baseUrl) return looksLikeDoubao(baseUrl) ? "doubao" : "openai";
  return "doubao";
}

// Provider-specific env vars take precedence; the generic COWART_IMAGE_* vars are a
// fallback so one shared base URL / key can't accidentally bleed across providers.
function resolveImageApiKey(args, provider) {
  const fromArg = nonEmptyString(args.apiKey);
  if (fromArg) return fromArg;
  if (provider === "doubao") {
    return envValue("ARK_API_KEY", "DOUBAO_API_KEY", "VOLC_API_KEY", "VOLCENGINE_API_KEY", "COWART_IMAGE_API_KEY");
  }
  return envValue("OPENAI_API_KEY", "GAISC_API_KEY", "G_AISC_API_KEY", "COWART_IMAGE_API_KEY");
}

function resolveImageBaseUrl(args, provider) {
  const fromArg = nonEmptyString(args.baseUrl);
  if (fromArg) return fromArg.replace(/\/+$/, "");
  if (provider === "doubao") {
    const specific = envValue("ARK_BASE_URL", "DOUBAO_BASE_URL");
    if (specific) return specific.replace(/\/+$/, "");
    const generic = envValue("COWART_IMAGE_BASE_URL");
    if (generic && looksLikeDoubao(generic)) return generic.replace(/\/+$/, "");
    return PROVIDER_DEFAULTS.doubao.baseUrl;
  }
  const value = envValue("COWART_IMAGE_BASE_URL", "GAISC_BASE_URL") || PROVIDER_DEFAULTS.openai.baseUrl;
  return value.replace(/\/+$/, "");
}

function resolveImageModel(args, provider) {
  const fromArg = nonEmptyString(args.model);
  if (fromArg) return fromArg;
  if (provider === "doubao") {
    const specific = envValue("DOUBAO_MODEL", "ARK_MODEL");
    if (specific) return specific;
    const generic = envValue("COWART_IMAGE_MODEL");
    if (generic && /(doubao|seedream)/i.test(generic)) return generic;
    return PROVIDER_DEFAULTS.doubao.model;
  }
  return envValue("COWART_IMAGE_MODEL", "GAISC_MODEL") || PROVIDER_DEFAULTS.openai.model;
}

function keyErrorMessage(provider) {
  if (provider === "doubao") {
    return "No Doubao/Ark API key found. Set COWART_IMAGE_API_KEY (or ARK_API_KEY / DOUBAO_API_KEY) as a local environment variable, then restart Codex.";
  }
  return "No image API key found. Set COWART_IMAGE_API_KEY (or OPENAI_API_KEY / GAISC_API_KEY) as a local environment variable, then restart Codex.";
}

/* ------------------------------------------------------------------ *
 * Size computation
 * ------------------------------------------------------------------ */
function parseExplicitSize(value) {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(value || "").trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function doubaoPreset(value) {
  const match = /^(1k|2k|4k)$/i.exec(String(value || "").trim());
  return match ? match[1].toUpperCase() : null;
}

// Map an arbitrary ratio to a Doubao-legal WxH (total pixels and aspect within
// range). Snaps to a recommended size when the ratio is close, for best quality.
function computeDoubaoSize(ratio, budgetPixels) {
  const rawRatio = ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
  let best = null;
  let bestErr = Infinity;
  for (const candidate of DOUBAO_RECOMMENDED) {
    const err = Math.abs(Math.log(rawRatio / candidate.r));
    if (err < bestErr) {
      bestErr = err;
      best = candidate;
    }
  }
  if (best && bestErr <= 0.04) return { width: best.w, height: best.h };

  const safeRatio = clampNumber(rawRatio, 1 / 16, 16);
  const budget = clampNumber(finiteNumber(budgetPixels, DOUBAO_BUDGET_PIXELS), DOUBAO_MIN_PIXELS, DOUBAO_MAX_PIXELS);
  let width = clampNumber(roundToMultiple(Math.sqrt(budget * safeRatio), DOUBAO_MULTIPLE), DOUBAO_MULTIPLE, DOUBAO_MAX_SIDE);
  let height = clampNumber(roundToMultiple(Math.sqrt(budget / safeRatio), DOUBAO_MULTIPLE), DOUBAO_MULTIPLE, DOUBAO_MAX_SIDE);

  for (let guard = 0; guard < 12 && width * height < DOUBAO_MIN_PIXELS; guard += 1) {
    const factor = Math.sqrt(DOUBAO_MIN_PIXELS / (width * height));
    width = clampNumber(roundToMultiple(width * factor, DOUBAO_MULTIPLE), DOUBAO_MULTIPLE, DOUBAO_MAX_SIDE);
    height = clampNumber(roundToMultiple(height * factor, DOUBAO_MULTIPLE), DOUBAO_MULTIPLE, DOUBAO_MAX_SIDE);
  }
  for (let guard = 0; guard < 12 && width * height > DOUBAO_MAX_PIXELS; guard += 1) {
    const factor = Math.sqrt(DOUBAO_MAX_PIXELS / (width * height));
    width = floorToMultiple(width * factor, DOUBAO_MULTIPLE);
    height = floorToMultiple(height * factor, DOUBAO_MULTIPLE);
  }
  return { width, height };
}

// Map an arbitrary ratio to an OpenAI-compatible-legal WxH.
function computeOpenaiSize(ratio, budgetPixels) {
  const rawRatio = ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
  const safeRatio = clampNumber(rawRatio, 1 / OPENAI_MAX_RATIO, OPENAI_MAX_RATIO);
  const budget = clampNumber(finiteNumber(budgetPixels, OPENAI_BUDGET_PIXELS), OPENAI_MIN_PIXELS, OPENAI_MAX_PIXELS);
  let width = clampNumber(roundToMultiple(Math.sqrt(budget * safeRatio), OPENAI_MULTIPLE), OPENAI_MULTIPLE, OPENAI_MAX_SIDE);
  let height = clampNumber(roundToMultiple(Math.sqrt(budget / safeRatio), OPENAI_MULTIPLE), OPENAI_MULTIPLE, OPENAI_MAX_SIDE);

  for (let guard = 0; guard < 8 && width * height < OPENAI_MIN_PIXELS; guard += 1) {
    const factor = Math.sqrt(OPENAI_MIN_PIXELS / (width * height));
    width = clampNumber(roundToMultiple(width * factor, OPENAI_MULTIPLE), OPENAI_MULTIPLE, OPENAI_MAX_SIDE);
    height = clampNumber(roundToMultiple(height * factor, OPENAI_MULTIPLE), OPENAI_MULTIPLE, OPENAI_MAX_SIDE);
  }
  for (let guard = 0; guard < 8 && width * height > OPENAI_MAX_PIXELS; guard += 1) {
    const factor = Math.sqrt(OPENAI_MAX_PIXELS / (width * height));
    width = floorToMultiple(width * factor, OPENAI_MULTIPLE);
    height = floorToMultiple(height * factor, OPENAI_MULTIPLE);
  }
  for (let guard = 0; guard < 16 && width / height > OPENAI_MAX_RATIO && width > OPENAI_MULTIPLE; guard += 1) {
    width = floorToMultiple(width - OPENAI_MULTIPLE, OPENAI_MULTIPLE);
  }
  for (let guard = 0; guard < 16 && height / width > OPENAI_MAX_RATIO && height > OPENAI_MULTIPLE; guard += 1) {
    height = floorToMultiple(height - OPENAI_MULTIPLE, OPENAI_MULTIPLE);
  }
  return { width, height };
}

function computeSizeForProvider(provider, ratio, budgetPixels) {
  return provider === "doubao" ? computeDoubaoSize(ratio, budgetPixels) : computeOpenaiSize(ratio, budgetPixels);
}

/* ------------------------------------------------------------------ *
 * Image bytes helpers (no deps)
 * ------------------------------------------------------------------ */
function readImageDimensions(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + size;
    }
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    if (buffer.toString("ascii", 12, 16) === "VP8X") {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
  }
  return null;
}

function detectImageFormat(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") return { ext: "png", mime: "image/png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return { ext: "jpg", mime: "image/jpeg" };
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  return { ext: "png", mime: "image/png" };
}

function mimeTypeForFile(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".gif":
      return "image/gif";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/* ------------------------------------------------------------------ *
 * Image API layer (provider aware)
 * ------------------------------------------------------------------ */
async function fetchWithTimeout(url, options = {}, timeoutMs = IMAGE_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Image API request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function parseImageApiResponse(response) {
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text.slice(0, 600) };
    }
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || payload?.raw || `${response.status} ${response.statusText}`;
    throw new Error(`Image API request failed (HTTP ${response.status}): ${message}`);
  }
  return payload;
}

function dataItemsFromPayload(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function imageBufferFromPayload(payload) {
  for (const item of dataItemsFromPayload(payload)) {
    const b64 = nonEmptyString(item?.b64_json);
    if (b64) return Buffer.from(b64, "base64");
  }
  return null;
}

function imageUrlFromPayload(payload) {
  for (const item of dataItemsFromPayload(payload)) {
    const url = nonEmptyString(item?.url);
    if (url) return url;
  }
  return null;
}

function payloadErrorMessage(payload) {
  for (const item of dataItemsFromPayload(payload)) {
    const message = nonEmptyString(item?.error?.message);
    if (message) return message;
  }
  return null;
}

async function downloadImageBuffer(url) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) throw new Error(`Failed to download generated image: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function bufferFromPayload(payload) {
  let buffer = imageBufferFromPayload(payload);
  let downloadedFromUrl = null;
  if (!buffer) {
    downloadedFromUrl = imageUrlFromPayload(payload);
    if (downloadedFromUrl) buffer = await downloadImageBuffer(downloadedFromUrl);
  }
  if (!buffer) {
    const detail = payloadErrorMessage(payload);
    throw new Error(`Image API returned no image data${detail ? `: ${detail}` : "."}`);
  }
  return { buffer, downloadedFromUrl };
}

async function postJson(url, apiKey, body) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseImageApiResponse(response);
}

// Doubao Seedream: text-to-image and image-to-image share /images/generations.
async function doubaoImages({ apiKey, baseUrl, model, prompt, size, watermark, sourceImage }) {
  const body = {
    model,
    prompt,
    response_format: "b64_json",
    watermark: watermark === true,
    sequential_image_generation: "disabled",
  };
  if (size) body.size = size;
  if (sourceImage) {
    body.image = sourceImage.url
      ? sourceImage.url
      : `data:${sourceImage.mimeType || "image/png"};base64,${sourceImage.buffer.toString("base64")}`;
  }
  const payload = await postJson(`${baseUrl}/images/generations`, apiKey, body);
  return bufferFromPayload(payload);
}

// OpenAI-compatible text-to-image via /images/generations.
async function openaiGenerate({ apiKey, baseUrl, model, prompt, size, quality, background }) {
  const body = { model, prompt, response_format: "b64_json" };
  if (size) body.size = size;
  if (nonEmptyString(quality)) body.quality = nonEmptyString(quality);
  if (nonEmptyString(background)) body.background = nonEmptyString(background);
  const payload = await postJson(`${baseUrl}/images/generations`, apiKey, body);
  return bufferFromPayload(payload);
}

// OpenAI-compatible image-to-image via /images/edits. JSON images[{image_url}]
// is primary (accepts base64 data URLs); multipart/form-data is the fallback.
async function openaiEdit({ apiKey, baseUrl, model, prompt, size, sourceImage }) {
  const imageUrl = sourceImage.url
    ? sourceImage.url
    : `data:${sourceImage.mimeType || "image/png"};base64,${sourceImage.buffer.toString("base64")}`;
  try {
    const body = { model, prompt, images: [{ image_url: imageUrl }], response_format: "b64_json" };
    if (size) body.size = size;
    const payload = await postJson(`${baseUrl}/images/edits`, apiKey, body);
    return await bufferFromPayload(payload);
  } catch (jsonError) {
    if (sourceImage.url && !sourceImage.buffer) throw jsonError;
    const form = new FormData();
    form.append("image", new Blob([sourceImage.buffer], { type: sourceImage.mimeType || "image/png" }), "input.png");
    form.append("prompt", prompt);
    if (model) form.append("model", model);
    if (size) form.append("size", size);
    form.append("response_format", "b64_json");
    const response = await fetchWithTimeout(`${baseUrl}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    try {
      const payload = await parseImageApiResponse(response);
      return await bufferFromPayload(payload);
    } catch (multipartError) {
      throw new Error(`Image edit failed (json: ${jsonError.message}; multipart: ${multipartError.message})`);
    }
  }
}

// Dispatch text-to-image / image-to-image by provider. sourceImage (optional) is
// { buffer, mimeType } or { url } for image-to-image.
async function generateBuffer({ provider, apiKey, baseUrl, model, prompt, size, watermark, quality, background, sourceImage }) {
  if (provider === "doubao") {
    return doubaoImages({ apiKey, baseUrl, model, prompt, size, watermark, sourceImage });
  }
  if (sourceImage) {
    return openaiEdit({ apiKey, baseUrl, model, prompt, size, sourceImage });
  }
  return openaiGenerate({ apiKey, baseUrl, model, prompt, size, quality, background });
}

/* ------------------------------------------------------------------ *
 * Cowart canvas layer (talks to the running Cowart HTTP service + data dir)
 * ------------------------------------------------------------------ */
function resolveCanvasDir(args = {}) {
  const explicitCanvasDir = nonEmptyString(args.canvasDir);
  if (explicitCanvasDir) return pathResolve(explicitCanvasDir);
  const explicitProjectDir = nonEmptyString(args.projectDir);
  if (explicitProjectDir) return join(pathResolve(explicitProjectDir), "canvas");
  const envCanvasDir = nonEmptyString(process.env.COWART_CANVAS_DIR);
  if (envCanvasDir) return pathResolve(envCanvasDir);
  const envProjectDir = nonEmptyString(process.env.COWART_PROJECT_DIR);
  if (envProjectDir) return join(pathResolve(envProjectDir), "canvas");
  const fallbackCanvasDir = nonEmptyString(args.fallbackCanvasDir);
  if (fallbackCanvasDir) return pathResolve(fallbackCanvasDir);
  return join(process.cwd(), "canvas");
}

function inferCanvasDirFromCanvasPayload(payload) {
  const value = nonEmptyString(payload?.path);
  if (!value) return null;

  // Cowart's per-page storage currently reports the pages directory, e.g.
  // "C:\\...\\canvas \\pages" on Windows. Strip the trailing "pages" segment
  // (and any accidental whitespace before the separator) to recover canvas/.
  const withoutPages = value.replace(/\s*[\\/]+pages\s*$/i, "");
  const candidate = nonEmptyString(withoutPages) || value;
  return pathResolve(candidate.trim());
}

function resolveSelectionFile(args = {}) {
  return join(resolveCanvasDir(args), "cowart-selection.json");
}
function resolveViewStateFile(args = {}) {
  return join(resolveCanvasDir(args), "cowart-view-state.json");
}
function pageDirName(pageId) {
  return encodeURIComponent(pageId.replace(PAGE_ID_PREFIX, ""));
}
function pageAssetUrl(pageId, fileName) {
  return `${PAGE_ASSETS_ROUTE}${pageDirName(pageId)}/${encodeURIComponent(fileName)}`;
}
function isSafeChildPath(parent, child) {
  const pathToChild = relative(parent, child);
  return pathToChild && !pathToChild.startsWith("..") && !pathToChild.includes(`..${sep}`);
}
function sanitizeFileName(name, fallbackName = "image.png") {
  const rawName = basename(String(name || fallbackName));
  const extension = extname(rawName) || extname(fallbackName) || ".png";
  const baseName = rawName
    .slice(0, rawName.length - extname(rawName).length)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${baseName || "image"}${extension}`;
}
function sanitizeIdPart(value, fallback = "image") {
  return (
    String(value || fallback)
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

async function uniqueFilePath(dir, requestedName) {
  const safeName = sanitizeFileName(requestedName);
  const ext = extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  let candidate = safeName;
  let counter = 2;
  while (true) {
    const candidatePath = join(dir, candidate);
    try {
      await stat(candidatePath);
      candidate = `${base}-v${counter}${ext}`;
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return { fileName: candidate, filePath: candidatePath };
      throw error;
    }
  }
}

function uniqueRecordId(store, prefix, seed) {
  const cleanSeed = sanitizeIdPart(seed);
  let candidate = `${prefix}:${cleanSeed}`;
  let counter = 2;
  while (store[candidate]) {
    candidate = `${prefix}:${cleanSeed}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function normalizeCowartUrl(args = {}) {
  const value = nonEmptyString(args.cowartUrl) || nonEmptyString(process.env.COWART_URL) || "http://127.0.0.1:43217";
  return value.replace(/\/+$/, "");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function loadCanvasSnapshot(args) {
  const cowartUrl = normalizeCowartUrl(args);
  let payload;
  try {
    payload = await fetchJson(`${cowartUrl}/api/canvas`);
  } catch (error) {
    throw new Error(`Could not reach the Cowart canvas at ${cowartUrl}/api/canvas. Open the Cowart canvas first. (${error instanceof Error ? error.message : String(error)})`);
  }
  const snapshot = payload?.snapshot ?? payload;
  if (!snapshot || typeof snapshot !== "object" || !snapshot.schema || !snapshot.store) {
    throw new Error(`Expected a Cowart canvas snapshot from ${cowartUrl}/api/canvas`);
  }
  return { cowartUrl, snapshot, payload, fallbackCanvasDir: inferCanvasDirFromCanvasPayload(payload) };
}

async function saveCanvasSnapshot(cowartUrl, snapshot) {
  return fetchJson(`${cowartUrl}/api/canvas`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
  });
}

async function readSelectionState(args) {
  const selectionFile = resolveSelectionFile(args);
  try {
    const selection = JSON.parse(await readFile(selectionFile, "utf8"));
    if (!selection || typeof selection !== "object" || !Array.isArray(selection.selectedShapes)) {
      throw new Error(`Invalid selection state in ${selectionFile}`);
    }
    return { selection };
  } catch (error) {
    if (error?.code === "ENOENT") return { selection: { selectedShapes: [] } };
    throw error;
  }
}

async function readViewState(args) {
  const viewStateFile = resolveViewStateFile(args);
  try {
    const payload = JSON.parse(await readFile(viewStateFile, "utf8"));
    return payload?.viewState ?? payload;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function getRecord(store, id, label) {
  const record = store[id];
  if (!record) throw new Error(`Missing ${label}: ${id}`);
  return record;
}

function findPageIdForShape(store, shapeId) {
  let record = getRecord(store, shapeId, "shape");
  const visited = new Set();
  while (record && !visited.has(record.id)) {
    visited.add(record.id);
    if (record.typeName === "page") return record.id;
    const parentId = record.parentId;
    if (!parentId) break;
    const parent = store[parentId];
    if (parent?.typeName === "page") return parent.id;
    record = parent;
  }
  return null;
}

function getPageShapes(store, pageId) {
  const shapes = [];
  const byParent = new Map();
  for (const record of Object.values(store)) {
    if (record?.typeName !== "shape") continue;
    const siblings = byParent.get(record.parentId) ?? [];
    siblings.push(record);
    byParent.set(record.parentId, siblings);
  }
  const queue = [...(byParent.get(pageId) ?? [])];
  while (queue.length > 0) {
    const shape = queue.shift();
    shapes.push(shape);
    queue.push(...(byParent.get(shape.id) ?? []));
  }
  return shapes;
}

function localBoundsForShape(shape) {
  if (!shape || shape.typeName !== "shape") return null;
  if (shape.type === "arrow") {
    const start = shape.props?.start ?? { x: 0, y: 0 };
    const end = shape.props?.end ?? { x: 0, y: 0 };
    const minX = Math.min(start.x ?? 0, end.x ?? 0);
    const minY = Math.min(start.y ?? 0, end.y ?? 0);
    const maxX = Math.max(start.x ?? 0, end.x ?? 0);
    const maxY = Math.max(start.y ?? 0, end.y ?? 0);
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }
  const w = finiteNumber(shape.props?.w, shape.type === "text" ? 160 : 1);
  const h = finiteNumber(shape.props?.h, shape.type === "text" ? 40 : 1);
  return { x: 0, y: 0, w, h };
}

function pageBoundsForShape(store, shape) {
  const local = localBoundsForShape(shape);
  if (!local) return null;
  let x = finiteNumber(shape.x, 0) + local.x;
  let y = finiteNumber(shape.y, 0) + local.y;
  let parent = store[shape.parentId];
  const visited = new Set([shape.id]);
  while (parent?.typeName === "shape" && !visited.has(parent.id)) {
    visited.add(parent.id);
    x += finiteNumber(parent.x, 0);
    y += finiteNumber(parent.y, 0);
    parent = store[parent.parentId];
  }
  return { x, y, w: local.w, h: local.h };
}

function rectsOverlap(a, b, padding = 0) {
  return !(a.x + a.w + padding <= b.x || b.x + b.w + padding <= a.x || a.y + a.h + padding <= b.y || b.y + b.h + padding <= a.y);
}

function chooseIndex(store, parentId) {
  const siblingIndexes = Object.values(store)
    .filter((record) => record?.typeName === "shape" && record.parentId === parentId && typeof record.index === "string")
    .map((record) => record.index)
    .sort();
  return generateKeyBetween(siblingIndexes.at(-1) ?? null, null);
}

function firstSelectedShapeId(selection) {
  return selection?.selectedShapes?.length === 1 ? selection.selectedShapes[0]?.id : null;
}

function resolveSelectedHolderId(selection) {
  const shapes = selection?.selectedShapes ?? [];
  const holders = shapes.filter((shape) => shape?.isAiImageHolder === true || shape?.meta?.cowartAiImageHolder === true);
  if (holders.length === 1) return holders[0]?.id ?? null;
  if (holders.length === 0 && shapes.length === 1) return shapes[0]?.id ?? null;
  return null;
}

function choosePlacement({ store, pageId, parentId, anchorShape, width, height, margin, placement }) {
  const anchorBounds = anchorShape ? pageBoundsForShape(store, anchorShape) : null;
  let x = anchorBounds ? anchorBounds.x + anchorBounds.w + margin : 0;
  let y = anchorBounds ? anchorBounds.y : 0;

  if (placement === "left" && anchorBounds) x = anchorBounds.x - width - margin;
  if (placement === "below" && anchorBounds) {
    x = anchorBounds.x;
    y = anchorBounds.y + anchorBounds.h + margin;
  }

  const obstacles = getPageShapes(store, pageId)
    .filter((shape) => shape.parentId === parentId && shape.id !== anchorShape?.id)
    .map((shape) => pageBoundsForShape(store, shape))
    .filter(Boolean);

  const stepX = Math.max(width + margin, 1);
  const stepY = Math.max(height + margin, 1);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = { x, y, w: width, h: height };
    if (!obstacles.some((bounds) => rectsOverlap(candidate, bounds, margin / 2))) return candidate;
    if (placement === "below") y += stepY;
    else if (placement === "left") x -= stepX;
    else x += stepX;
  }
  return { x, y, w: width, h: height };
}

// Non-destructive cover crop as a normalized tldraw crop rect.
function coverCrop(boxRatio, imageRatio) {
  if (!Number.isFinite(boxRatio) || !Number.isFinite(imageRatio) || boxRatio <= 0 || imageRatio <= 0) return null;
  if (Math.abs(boxRatio - imageRatio) < 1e-4) return null;
  if (imageRatio > boxRatio) {
    const inset = (1 - boxRatio / imageRatio) / 2;
    return { topLeft: { x: inset, y: 0 }, bottomRight: { x: 1 - inset, y: 1 } };
  }
  const inset = (1 - imageRatio / boxRatio) / 2;
  return { topLeft: { x: 0, y: inset }, bottomRight: { x: 1, y: 1 - inset } };
}

function timestampSlug(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function assertUsablePrompt(prompt) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const questionMarks = (compact.match(/\?/g) || []).length;
  const visibleChars = compact.replace(/\s/g, "").length;
  const looksLikeHolderPlaceholder =
    lower.includes("what would you like to create") ||
    lower.includes("describe your image request clearly");
  const looksLikeMojibakePlaceholder =
    questionMarks >= 12 && questionMarks / Math.max(1, visibleChars) > 0.3;

  if (looksLikeHolderPlaceholder || looksLikeMojibakePlaceholder) {
    throw new Error(
      "The prompt looks like Cowart's AI holder placeholder text or mojibake (for example 'What would you like to create?' / many question marks). Use the user's actual image request, expand it into a clear visual prompt, translate Chinese requests to English unless exact visible Chinese text is required, and call generate_seedream_image again."
    );
  }
}

// Resolve an anchor shape's existing local image file (for image-to-image).
function anchorImageFile(store, anchorShape, canvasDir, pageId) {
  const assetId = anchorShape?.props?.assetId;
  if (!assetId) return null;
  const asset = store[assetId];
  const src = asset?.props?.src;
  if (typeof src !== "string" || !src || /^https?:\/\//.test(src) || src.startsWith("data:")) return null;
  const fileName = basename(decodeURIComponent(src));
  return join(canvasDir, "pages", pageDirName(pageId), "assets", fileName);
}

/* ------------------------------------------------------------------ *
 * Insert a local bitmap into the canvas (beside an anchor / standalone)
 * ------------------------------------------------------------------ */
async function insertImageIntoCanvas(args, snapshotCtx) {
  const sourceImagePath = pathResolve(args.imagePath);
  const sourceStat = await stat(sourceImagePath);
  if (!sourceStat.isFile()) throw new Error(`imagePath is not a file: ${sourceImagePath}`);

  const { cowartUrl, snapshot, fallbackCanvasDir } = snapshotCtx;
  const store = snapshot.store;
  const canvasArgs = { ...args, fallbackCanvasDir };
  const selection = args._selection ?? (await readSelectionState(args)).selection;
  const viewState = args._viewState ?? (await readViewState(args));

  const anchorShapeId = nonEmptyString(args.anchorShapeId) || firstSelectedShapeId(selection);
  const anchorShape = anchorShapeId ? getRecord(store, anchorShapeId, "anchor shape") : null;
  const pageId =
    nonEmptyString(args.pageId) ||
    (anchorShape ? findPageIdForShape(store, anchorShape.id) : null) ||
    nonEmptyString(viewState?.currentPageId) ||
    Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!pageId || !store[pageId]) throw new Error("Could not determine target pageId.");

  const parentId = anchorShape?.parentId && store[anchorShape.parentId]?.typeName === "page" ? anchorShape.parentId : pageId;
  const fileBuffer = await readFile(sourceImagePath);
  const imageSize = readImageDimensions(fileBuffer) || { width: finiteNumber(args.displayWidth, 512), height: finiteNumber(args.displayHeight, 512) };
  const anchorBounds = anchorShape ? pageBoundsForShape(store, anchorShape) : null;
  const matchAnchor = args.matchAnchor !== false && anchorBounds;

  let width = finiteNumber(args.displayWidth, matchAnchor ? anchorBounds.w : Math.min(imageSize.width, 512));
  let height = finiteNumber(args.displayHeight, matchAnchor ? anchorBounds.h : Math.round(width * (imageSize.height / imageSize.width)));
  const fit = ["cover", "contain", "stretch"].includes(args.fit) ? args.fit : "cover";
  const imageRatio = imageSize.height > 0 ? imageSize.width / imageSize.height : 1;
  let crop = null;
  if (fit === "contain" && imageSize.width > 0 && imageSize.height > 0) {
    const scale = Math.min(width / imageSize.width, height / imageSize.height);
    width = Math.max(1, Math.round(imageSize.width * scale));
    height = Math.max(1, Math.round(imageSize.height * scale));
  } else if (fit === "cover") {
    crop = coverCrop(height > 0 ? width / height : 1, imageRatio);
  }
  const margin = Math.max(0, finiteNumber(args.margin, 40));
  const placement = ["right", "left", "below"].includes(args.placement) ? args.placement : "right";
  const bounds = choosePlacement({ store, pageId, parentId, anchorShape, width, height, margin, placement });

  const canvasDir = resolveCanvasDir(canvasArgs);
  const assetsDir = join(canvasDir, "pages", pageDirName(pageId), "assets");
  if (!isSafeChildPath(canvasDir, assetsDir)) throw new Error(`Unsafe page assets directory: ${assetsDir}`);

  const { fileName, filePath } = await uniqueFilePath(assetsDir, args.fileName || basename(sourceImagePath));
  const recordSeed = sanitizeIdPart(fileName);
  const assetId = uniqueRecordId(store, "asset", recordSeed);
  const shapeId = uniqueRecordId(store, "shape", recordSeed);
  const index = chooseIndex(store, parentId);

  const assetRecord = {
    id: assetId,
    typeName: "asset",
    type: "image",
    props: {
      name: fileName,
      src: pageAssetUrl(pageId, fileName),
      w: imageSize.width,
      h: imageSize.height,
      fileSize: sourceStat.size,
      mimeType: mimeTypeForFile(fileName),
      isAnimated: false,
    },
    meta: {},
  };

  const shapeMeta = args.shapeMeta && typeof args.shapeMeta === "object" ? { ...args.shapeMeta } : {};
  if (anchorShapeId && !shapeMeta.cowartAnnotationSourceShapeId) shapeMeta.cowartAnnotationSourceShapeId = anchorShapeId;

  const shapeRecord = {
    x: bounds.x,
    y: bounds.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: shapeMeta,
    id: shapeId,
    type: "image",
    props: {
      w: width,
      h: height,
      assetId,
      playing: true,
      url: "",
      crop,
      flipX: false,
      flipY: false,
      altText: nonEmptyString(args.altText) || "Cowart Seedream image",
    },
    parentId,
    index,
    typeName: "shape",
  };

  await mkdir(assetsDir, { recursive: true });
  await copyFile(sourceImagePath, filePath);
  store[assetId] = assetRecord;
  store[shapeId] = shapeRecord;
  await saveCanvasSnapshot(cowartUrl, snapshot);

  return { cowartUrl, pageId, parentId, anchorShapeId, assetId, shapeId, index, assetFile: filePath, assetUrl: assetRecord.props.src, imageSize, bounds };
}

/* ------------------------------------------------------------------ *
 * The main tool: generate via API, then place on the Cowart canvas
 * ------------------------------------------------------------------ */
async function generateSeedreamImage(args = {}) {
  const prompt = nonEmptyString(args.prompt);
  if (!prompt) throw new Error("prompt is required.");
  assertUsablePrompt(prompt);

  const provider = resolveProvider(args);
  const apiKey = resolveImageApiKey(args, provider);
  const baseUrl = resolveImageBaseUrl(args, provider);
  const model = resolveImageModel(args, provider);
  const watermark = args.watermark === true;

  const canvasCtx = await loadCanvasSnapshot(args);
  const { cowartUrl, snapshot, fallbackCanvasDir } = canvasCtx;
  const canvasArgs = { ...args, fallbackCanvasDir };
  const store = snapshot.store;
  const { selection } = await readSelectionState(canvasArgs);
  const viewState = await readViewState(canvasArgs);

  const targetId = nonEmptyString(args.holderShapeId) || nonEmptyString(args.anchorShapeId) || resolveSelectedHolderId(selection);
  const requestedPlacement = nonEmptyString(args.placement);
  const placement = ["into", "right", "left", "below", "page"].includes(requestedPlacement)
    ? requestedPlacement
    : targetId
      ? "into"
      : "page";

  // Resolve the target ratio for sizing.
  let ratio = 1;
  let holder = null;
  if (targetId) {
    holder = getRecord(store, targetId, "target shape");
    const bounds = pageBoundsForShape(store, holder);
    const holderW = Math.max(1, finiteNumber(holder.props?.w, bounds?.w ?? 320));
    const holderH = Math.max(1, finiteNumber(holder.props?.h, bounds?.h ?? 220));
    ratio = holderW / holderH;
  } else if (parseExplicitSize(args.size)) {
    const s = parseExplicitSize(args.size);
    ratio = s.width / s.height;
  } else if (finiteNumber(args.aspectRatio, 0) > 0) {
    ratio = args.aspectRatio;
  }

  // Resolve the size string to send to the API.
  const explicitSize = parseExplicitSize(args.size);
  const presetSize = provider === "doubao" ? doubaoPreset(args.size) : null;
  const computedSize = computeSizeForProvider(provider, ratio, finiteNumber(args.targetPx, undefined));
  const sizeString = explicitSize ? `${explicitSize.width}x${explicitSize.height}` : presetSize || `${computedSize.width}x${computedSize.height}`;

  if (args.dryRun) {
    return {
      dryRun: true,
      provider,
      model,
      baseUrl,
      placement,
      targetId: targetId ?? null,
      ratio,
      requestedSize: sizeString,
      computedSize,
    };
  }

  const pageId =
    (holder ? findPageIdForShape(store, holder.id) : null) ||
    nonEmptyString(args.pageId) ||
    nonEmptyString(viewState?.currentPageId) ||
    Object.values(store).find((record) => record?.typeName === "page")?.id;
  if (!pageId || !store[pageId]) throw new Error("Could not determine target pageId.");

  // Optional image-to-image source: anchor's local image, or an explicit path/url.
  let sourceImage = null;
  let usedImageToImage = false;
  const explicitSourcePath = nonEmptyString(args.sourceImagePath);
  const explicitSourceUrl = nonEmptyString(args.sourceImageUrl);
  if (explicitSourcePath) {
    const buffer = await readFile(pathResolve(explicitSourcePath));
    sourceImage = { buffer, mimeType: mimeTypeForFile(explicitSourcePath) };
    usedImageToImage = true;
  } else if (explicitSourceUrl) {
    sourceImage = { url: explicitSourceUrl };
    usedImageToImage = true;
  } else if (
    holder &&
    (args.editSourceFromAnchor === true ||
      (args.editSourceFromAnchor !== false && placement !== "into" && holder.type === "image"))
  ) {
    const sourceFile = anchorImageFile(store, holder, resolveCanvasDir(canvasArgs), pageId);
    if (sourceFile) {
      try {
        const fileStat = await stat(sourceFile);
        if (fileStat.isFile()) {
          sourceImage = { buffer: await readFile(sourceFile), mimeType: mimeTypeForFile(sourceFile) };
          usedImageToImage = true;
        }
      } catch {
        sourceImage = null;
        usedImageToImage = false;
      }
    }
  }

  // Call the image API. Fall back to text-to-image if an image-to-image edit fails.
  if (!apiKey) throw new Error(keyErrorMessage(provider));
  let generation;
  try {
    generation = await generateBuffer({ provider, apiKey, baseUrl, model, prompt, size: sizeString, watermark, quality: args.quality, background: args.background, sourceImage });
  } catch (error) {
    if (sourceImage) {
      generation = await generateBuffer({ provider, apiKey, baseUrl, model, prompt, size: sizeString, watermark, quality: args.quality, background: args.background, sourceImage: null });
      usedImageToImage = false;
    } else {
      throw error;
    }
  }

  const { buffer, downloadedFromUrl } = generation;
  const format = detectImageFormat(buffer);
  const actualDims = readImageDimensions(buffer) || computedSize;

  // ---- beside / standalone placement: write to temp, then insert generically.
  if (placement !== "into") {
    const tempFile = join(tmpdir(), `cowart-seedream-${timestampSlug()}-${Math.random().toString(36).slice(2, 8)}.${format.ext}`);
    await writeFile(tempFile, buffer);
    try {
      const inserted = await insertImageIntoCanvas(
        {
          projectDir: args.projectDir,
          canvasDir: args.canvasDir,
          cowartUrl: args.cowartUrl,
          pageId,
          imagePath: tempFile,
          anchorShapeId: targetId ?? null,
          placement: placement === "page" ? "right" : placement,
          margin: finiteNumber(args.margin, 40),
          matchAnchor: Boolean(targetId),
          fit: nonEmptyString(args.fit) || "cover",
          fileName: nonEmptyString(args.fileName) || `cowart-seedream-${timestampSlug()}.${format.ext}`,
          altText: nonEmptyString(args.altText) || "Cowart Seedream image",
          shapeMeta: {
            cowartSeedreamGenerated: true,
            cowartSeedreamProvider: provider,
            cowartSeedreamModel: model,
            cowartImageToImage: usedImageToImage,
            ...(targetId ? { cowartAnnotationSourceShapeId: targetId } : {}),
            ...(args.shapeMeta && typeof args.shapeMeta === "object" ? args.shapeMeta : {}),
          },
          _selection: selection,
          _viewState: viewState,
        },
        canvasCtx
      );
      return {
        mode: targetId ? "beside" : "standalone",
        placement: placement === "page" ? "page" : placement,
        provider,
        model,
        baseUrl,
        imageToImage: usedImageToImage,
        requestedSize: sizeString,
        generatedSize: actualDims,
        downloadedFromUrl,
        ...inserted,
      };
    } finally {
      await unlink(tempFile).catch(() => {});
    }
  }

  // ---- into placement: fill / replace the holder in place.
  if (!holder) {
    throw new Error("placement 'into' requires a selected AI image holder or a holderShapeId. Select a holder, or use placement 'page' for a standalone image.");
  }
  const holderW = Math.max(1, finiteNumber(holder.props?.w, 320));
  const displayW = holderW;
  const displayH = Math.max(1, Math.round(holderW * (actualDims.height / actualDims.width)));
  const isFrameHolder = holder.type === "frame";
  const keepHolder = args.keepHolder === true;
  const replaceFrame = isFrameHolder && !keepHolder;

  let parentId;
  let shapeX;
  let shapeY;
  let shapeRotation;
  if (isFrameHolder && keepHolder) {
    parentId = holder.id;
    shapeX = 0;
    shapeY = 0;
    shapeRotation = 0;
  } else {
    parentId = nonEmptyString(holder.parentId) || pageId;
    shapeX = finiteNumber(holder.x, 0);
    shapeY = finiteNumber(holder.y, 0);
    shapeRotation = finiteNumber(holder.rotation, 0);
  }

  const canvasDir = resolveCanvasDir(canvasArgs);
  const assetsDir = join(canvasDir, "pages", pageDirName(pageId), "assets");
  if (!isSafeChildPath(canvasDir, assetsDir)) throw new Error(`Unsafe page assets directory: ${assetsDir}`);

  const requestedName = nonEmptyString(args.fileName) || `cowart-seedream-${timestampSlug()}.${format.ext}`;
  const { fileName, filePath } = await uniqueFilePath(assetsDir, requestedName);
  const recordSeed = sanitizeIdPart(fileName);
  const assetId = uniqueRecordId(store, "asset", recordSeed);
  const shapeId = uniqueRecordId(store, "shape", recordSeed);
  const index = chooseIndex(store, parentId);

  const assetRecord = {
    id: assetId,
    typeName: "asset",
    type: "image",
    props: {
      name: fileName,
      src: pageAssetUrl(pageId, fileName),
      w: actualDims.width,
      h: actualDims.height,
      fileSize: buffer.length,
      mimeType: format.mime,
      isAnimated: false,
    },
    meta: {},
  };

  const shapeRecord = {
    x: shapeX,
    y: shapeY,
    rotation: shapeRotation,
    isLocked: false,
    opacity: 1,
    meta: {
      cowartGeneratedForAiImageHolder: holder.id,
      cowartSeedreamGenerated: true,
      cowartSeedreamProvider: provider,
      cowartSeedreamModel: model,
      cowartImageToImage: usedImageToImage,
      ...(args.shapeMeta && typeof args.shapeMeta === "object" ? args.shapeMeta : {}),
    },
    id: shapeId,
    type: "image",
    props: {
      w: displayW,
      h: displayH,
      assetId,
      playing: true,
      url: "",
      crop: null,
      flipX: false,
      flipY: false,
      altText: nonEmptyString(args.altText) || "Cowart Seedream image",
    },
    parentId,
    index,
    typeName: "shape",
  };

  await mkdir(assetsDir, { recursive: true });
  await writeFile(filePath, buffer);
  if (replaceFrame) {
    delete store[holder.id];
  } else if (isFrameHolder && keepHolder) {
    store[holder.id] = { ...holder, props: { ...holder.props, w: displayW, h: displayH } };
  }
  store[assetId] = assetRecord;
  store[shapeId] = shapeRecord;
  await saveCanvasSnapshot(cowartUrl, snapshot);

  return {
    mode: "into",
    placement: "into",
    provider,
    model,
    baseUrl,
    imageToImage: usedImageToImage,
    cowartUrl,
    pageId,
    holderId: holder.id,
    replacedHolder: replaceFrame,
    keepHolder,
    parentId,
    assetId,
    shapeId,
    index,
    requestedSize: sizeString,
    generatedSize: actualDims,
    display: { w: displayW, h: displayH },
    assetFile: filePath,
    assetUrl: assetRecord.props.src,
    downloadedFromUrl,
  };
}

/* ------------------------------------------------------------------ *
 * Tool definitions + JSON-RPC plumbing
 * ------------------------------------------------------------------ */
function toolDefinitions() {
  return [
    {
      name: TOOL_GENERATE,
      title: "Generate Cowart Seedream Image",
      description:
        "Generate an AI image through your own image API (Doubao Seedream on Volcengine Ark by default, or any OpenAI-compatible endpoint) and place it on the running Cowart canvas. No built-in image quota is used. With placement 'into' (default when an AI image holder is selected) it sizes to the holder ratio and fills the holder, by default replacing the frame with a standalone image at the same position (pass keepHolder:true to keep the frame). With placement 'right'/'left'/'below' it sizes to the anchor ratio and places a new image beside it without changing the anchor (use for annotation-driven edits); when the anchor is an image, it defaults to image-to-image from that anchor unless editSourceFromAnchor:false is passed. With no selection it places a standalone image on the current page. Pass sourceImagePath/sourceImageUrl for an explicit image-to-image source.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Image prompt. Prefer a clear English prompt for provider compatibility; include exact in-image text verbatim only when the asset needs visible copy.",
          },
          provider: { type: "string", enum: ["doubao", "openai"], description: "Image provider. Defaults to COWART_IMAGE_PROVIDER env or doubao (Volcengine Ark Seedream)." },
          model: { type: "string", description: "Model id. Defaults to COWART_IMAGE_MODEL env, then doubao-seedream-5-0-260128 (doubao) or gpt-image-2 (openai)." },
          baseUrl: { type: "string", description: "Image API base URL. Defaults to COWART_IMAGE_BASE_URL env, then the Volcengine Ark or g-aisc default for the provider." },
          apiKey: { type: "string", description: "Override API key. Prefer the COWART_IMAGE_API_KEY (or ARK_API_KEY) environment variable instead of passing this." },
          holderShapeId: { type: "string", description: "AI image holder or anchor shape id. Optional when exactly one shape is selected in Cowart." },
          anchorShapeId: { type: "string", description: "Alias for holderShapeId." },
          placement: {
            type: "string",
            enum: ["into", "right", "left", "below", "page"],
            description: "into (default with a selected holder) fills the holder; right/left/below place beside the anchor; page places a standalone image on the current page.",
          },
          size: { type: "string", description: "Explicit WIDTHxHEIGHT, or a Doubao preset 1K/2K/4K. Defaults to a size computed from the target ratio within the provider's legal range." },
          aspectRatio: { type: "number", description: "Target width/height ratio used for sizing when there is no selected holder. Defaults to 1." },
          targetPx: { type: "number", description: "Target total pixels for the computed size. Clamped to the provider range." },
          watermark: { type: "boolean", description: "Doubao only: add the provider watermark. Defaults to false." },
          editSourceFromAnchor: { type: "boolean", description: "Image-to-image using the holder/anchor's existing local image as the source. For beside placements (right/left/below), this defaults to true when the anchor is an image; pass false to force text-to-image. Falls back to text-to-image if unavailable." },
          sourceImagePath: { type: "string", description: "Absolute local image path to use as the image-to-image source (e.g. a user-provided screenshot)." },
          sourceImageUrl: { type: "string", description: "Remote image URL to use as the image-to-image source." },
          keepHolder: { type: "boolean", description: "For placement 'into': keep the AI image frame and place the image inside it. Defaults to false (replace the frame with a standalone image so it moves and resizes freely)." },
          margin: { type: "number", description: "For beside placement: canvas units between the new image and the anchor. Defaults to 40." },
          fit: { type: "string", enum: ["cover", "contain", "stretch"], description: "For beside placement: how to fit into the anchor box. Defaults to cover (non-destructive)." },
          quality: { type: "string", description: "OpenAI-compatible only: optional upstream quality value." },
          background: { type: "string", description: "OpenAI-compatible only: optional upstream background value." },
          fileName: { type: "string", description: "Optional destination filename under the page assets folder." },
          altText: { type: "string", description: "Image shape alt text." },
          shapeMeta: { type: "object", description: "Additional tldraw shape metadata." },
          projectDir: { type: "string", description: "Absolute Cowart project directory containing canvas/." },
          canvasDir: { type: "string", description: "Absolute canvas directory. Overrides projectDir." },
          cowartUrl: { type: "string", description: "Running Cowart URL, for example http://127.0.0.1:43217." },
          dryRun: { type: "boolean", description: "Resolve provider, size, and placement without calling the API or writing to the canvas." },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
  ];
}

async function handleToolCall(id, params) {
  if (params?.name === TOOL_GENERATE) {
    const result = await generateSeedreamImage(params.arguments ?? {});
    const text = result.dryRun
      ? `Planned ${result.requestedSize} (${result.placement}) via ${result.provider}/${result.model}.`
      : result.mode === "into"
        ? `Generated ${result.requestedSize} via ${result.provider}/${result.model} and filled holder ${result.holderId} on ${result.pageId} (${result.shapeId}).`
        : `Generated ${result.requestedSize} via ${result.provider}/${result.model} and placed ${result.shapeId} (${result.mode}) on ${result.pageId}.`;
    sendResult(id, { content: [{ type: "text", text }], structuredContent: result });
    return;
  }
  sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown tool: ${params?.name ?? ""}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Generate images through a bring-your-own-key image API (Doubao Seedream on Volcengine Ark by default, or any OpenAI-compatible endpoint) and place them on the running Cowart canvas without using the built-in image-generation quota. Use generate_seedream_image to fill a selected AI image holder, place an image beside an anchor, or drop a standalone image on the current page.",
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: toolDefinitions() });
    return;
  }
  if (method === "tools/call") {
    try {
      await handleToolCall(id, params);
    } catch (error) {
      sendError(id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function startStdioLoop() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    handleRequest(message).catch((error) => {
      if (message.id !== undefined) {
        sendError(message.id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
      }
    });
  });
}

// Only run the JSON-RPC stdio loop when executed directly (so the module can be
// imported for testing without consuming stdin).
const isMainEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainEntry) startStdioLoop();

export {
  resolveProvider,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  computeDoubaoSize,
  computeOpenaiSize,
  computeSizeForProvider,
  generateBuffer,
  readImageDimensions,
  detectImageFormat,
};
