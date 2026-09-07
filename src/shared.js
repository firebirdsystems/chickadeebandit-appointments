/**
 * Mirrors the handful of /hub-sdk.js helpers that src/logic.js needs, so the
 * pure logic can be imported in Node tests without the browser-only SDK.
 * index.html imports the real implementations from /hub-sdk.js at runtime.
 */

export function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function isAdult(member) {
  return member?.role === "adult";
}
