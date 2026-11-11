// The built screen bundle under app/screens/hr must stay closed: no network call,
// no dynamic code, no remote asset and no host CSS. Run after `pnpm build`.
// Run: bun test tests/contract/screen_bundle.test.mjs

import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../app/screens/hr/", import.meta.url));
const read = (name) => readFileSync(dir + name, "utf8");
const declaration = JSON.parse(read("screens.json"));
const names = declaration.assets.map((a) => a.name);
const scripts = names.filter((n) => n.endsWith(".js"));

// Inert strings React and the SDK carry: XML namespace identifiers, React's error-message
// link text (never requested) and a licence comment. Each was inspected; anything else fails.
const INERT_URLS = new Set([
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/XML/1998/namespace",
  "https://react.dev/errors/",
  "https://tailwindcss.com",
]);

test("the declaration names exactly the files on disk and no remote image", () => {
  expect(readdirSync(dir).sort()).toEqual([...names, "screens.json"].sort());
  expect(declaration.app).toBe("hr");
  expect(declaration.remote_images ?? []).toEqual([]);
  expect(declaration.startup).toEqual(["runtime.js", "client.js"]);
  expect(declaration.may).toEqual(["records.call", "records.slot"]);
  expect(declaration.tools).toEqual({});
  expect(declaration.operations).toEqual(["records.list", "records.show", "records.create", "records.update", "screen.route.patch"]);
});

test("no script makes a network call or runs dynamic code", () => {
  const banned = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bimportScripts\b/, /\bnew\s+(Shared)?Worker\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bimport\s*\(/];
  for (const name of scripts) {
    const body = read(name);
    for (const pattern of banned) expect([name, pattern.source, pattern.test(body)]).toEqual([name, pattern.source, false]);
  }
});

test("no file refers to a remote asset beyond the inert strings", () => {
  for (const name of names) {
    const urls = new Set(read(name).match(/https?:\/\/[^\s"'`)\\<>]+/g) ?? []);
    for (const url of urls) expect([name, INERT_URLS.has(url)]).toEqual([name, true]);
    expect(/\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(read(name).replace(/https?:\/\/[^\s"'`)\\<>]+/g, ""))).toBe(false);
  }
});

test("the stylesheet pulls in nothing and carries no host chrome", () => {
  const css = read("hr.css");
  expect(css).not.toMatch(/@import/i);
  expect(css).not.toMatch(/url\(\s*["']?\s*(https?:|\/\/)/i);
  expect(css).not.toMatch(/@font-face[^}]*url\(\s*["']?(https?:|\/\/)/i);
  // Host shell and chat selectors belong to Cadence; the app ships the pinned SDK plus its own `.hr` rules.
  expect(css).not.toMatch(/\.(sidebar|board-shell|chat-panel|app-sidebar)\b/);
  expect(css).toContain(".hr-table");
});
