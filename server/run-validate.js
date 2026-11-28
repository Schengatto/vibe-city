'use strict';

const FRAME_MS = 1000 / 60;
const TILE_PX = 32;
const MAP_TILES = { P: [184, 184], M: [184, 368], G: [368, 368] };

const validators = new Map();

function registerValidator(mode, { validate, checkStart = null, maxLogBytes = null } = {}) {
  if (typeof validate !== 'function') throw new Error(`validator ${mode} has no validate function`);
  validators.set(mode, { validate, checkStart, maxLogBytes });
}
function hasValidator(mode) { return typeof mode === 'string' && validators.has(mode); }
function validatorFor(mode) { return validators.get(mode) || null; }
function validateRun(ctx) {
  const validator = validators.get(ctx.run.mode);
  return validator ? validator.validate(ctx) : { ok: false, reason: 'unsupported_mode' };
}

function framesToMs(frames) { return frames * FRAME_MS; }
function checkElapsed(frames, run, now, { leadMs = 0, slackMs = 2000, pauseBudgetMs = 600000 } = {}) {
  const playedMs = framesToMs(frames) + leadMs;
  const elapsedMs = now - run.startedAt;
  if (elapsedMs < playedMs - slackMs) return 'elapsed_too_short';
  if (elapsedMs > playedMs + pauseBudgetMs) return 'elapsed_too_long';
  return null;
}
function clampPerMinute(count, perMinute, ms) {
  const wholeCount = Number.isFinite(count) ? Math.floor(count) : 0;
  return Math.max(0, Math.min(wholeCount, Math.ceil((perMinute * ms) / 60_000)));
}
function isInt(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
function worldSize(roomCode) {
  const [widthTiles, heightTiles] = MAP_TILES[String(roomCode).charAt(0)] || MAP_TILES.P;
  return { w: widthTiles * TILE_PX, h: heightTiles * TILE_PX };
}

module.exports = {
  registerValidator, hasValidator, validatorFor, validateRun,
  FRAME_MS, framesToMs, checkElapsed, clampPerMinute, isInt, worldSize,
};
