"use strict";
/*
 * logger.js — colored terminal logging.
 * Levels: debug, info, warn, error. Timestamps in local time.
 */

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = "info";

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function write(level, color, args) {
  if (levels[level] < levels[currentLevel]) return;
  const line = `${colors.dim}${ts()}${colors.reset} ${color}${level.toUpperCase().padEnd(5)}${colors.reset} ` +
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

module.exports = {
  setLevel: (l) => { if (levels[l] != null) currentLevel = l; },
  debug: (...a) => write("debug", colors.dim, a),
  info: (...a) => write("info", colors.green, a),
  warn: (...a) => write("warn", colors.yellow, a),
  error: (...a) => write("error", colors.red, a),
  raw: (s) => process.stdout.write(s + "\n"),
};
