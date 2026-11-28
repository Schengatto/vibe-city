'use strict';

const crypto = require('node:crypto');
const boards = require('./boards');
const runs = require('./runs');
const { hasValidator, validatorFor, validateRun, isInt } = require('./run-validate');

const MAX_BODY_BYTES = 65_536;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const MAX_TRACKED_IPS = 20_000;
const MINUTE_MS = 60_000;
const DEFAULT_BOARD_LIMIT = 20;
const MAX_BOARD_LIMIT = 50;
const MAX_MUTATORS = 8;
const MAX_RACE_INDEX = 15;
const SHIFT_JOBS = ['taxi', 'pizza', 'ambulance', 'patrol', 'fire'];
const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;
const CHALLENGE_ID_PATTERN = /^(daily:\d{4}-\d{2}-\d{2}|weekly:\d{4}-W\d{2})$/;
const MUTATOR_ID_PATTERN = /^[a-zA-Z0-9]{1,24}$/;
const NAME_PATTERN = /^[\p{L}\p{N} ._'-]{1,14}$/u;

const ERROR_STATUS = {
  bad_request: 400, unsupported_mode: 400, bad_name: 400, challenge_mismatch: 400, mutators_not_allowed: 400,
  race_unknown: 400, bad_token: 401, method_not_allowed: 405, timeout: 408, challenge_not_current: 409,
  token_expired: 410, too_large: 413, unsupported_type: 415, rejected: 422, rate_limited: 429, server_error: 500,
};
const START_CHECK_ERRORS = new Set(['challenge_mismatch', 'challenge_not_current', 'mutators_not_allowed', 'race_unknown']);
const BUCKET_RATES = {
  start: { perMinute: 20, burst: 6 },
  submit: { perMinute: 10, burst: 4 },
  boards: { perMinute: 60, burst: 20 },
};
const GLOBAL_BUCKET_RATES = { submit: { perMinute: 600, burst: 600 } };
const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff',
};
const PREFLIGHT_HEADERS = {
  ...API_HEADERS, 'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type', 'access-control-max-age': '600',
};
const BAD_REQUEST = Object.freeze({ ok: false, error: 'bad_request' });

const log = (...parts) => console.log(new Date().toISOString(), '[api]', ...parts);

const routes = new Map();
const trackedIps = new Map();
const globalBuckets = {};
let bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS;

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { ...API_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(payload));
}
function sendError(res, error, extraHeaders) {
  sendJson(res, ERROR_STATUS[error] || 400, { ok: false, error }, extraHeaders);
}
function sendErrorAndClose(req, res, error) {
  sendError(res, error, { connection: 'close' });
}

function clientIp(req) {
  const forwarded = process.env.TRUST_PROXY === '1' ? String(req.headers['x-real-ip'] || '').trim() : '';
  return forwarded || req.socket.remoteAddress || 'unknown';
}
function hashIp(ip) { return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 12); }

function normalizeName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  return NAME_PATTERN.test(name) ? name : null;
}
function matches(pattern, value) { return typeof value === 'string' && pattern.test(value); }

function takeToken(bucket, rate, now) {
  bucket.tokens = Math.min(rate.burst, bucket.tokens + ((now - bucket.at) * rate.perMinute) / MINUTE_MS);
  bucket.at = now;
  if (bucket.tokens >= 1) { bucket.tokens -= 1; return 0; }
  return Math.max(1, Math.ceil(((1 - bucket.tokens) * MINUTE_MS) / rate.perMinute / 1000));
}
function bucketIn(owner, bucketName, rate, now) {
  return owner[bucketName] || (owner[bucketName] = { tokens: rate.burst, at: now });
}
function bucketsOfIp(ip, now) {
  const tracked = trackedIps.get(ip) || { seenAt: now, buckets: {} };
  trackedIps.delete(ip);
  tracked.seenAt = now;
  trackedIps.set(ip, tracked);
  if (trackedIps.size > MAX_TRACKED_IPS) trackedIps.delete(trackedIps.keys().next().value);
  return tracked.buckets;
}
function retryAfterSeconds(ip, bucketName, now) {
  const rate = BUCKET_RATES[bucketName];
  if (!rate) return 0;
  const ipWait = takeToken(bucketIn(bucketsOfIp(ip, now), bucketName, rate, now), rate, now);
  const globalRate = GLOBAL_BUCKET_RATES[bucketName];
  if (ipWait || !globalRate) return ipWait;
  return takeToken(bucketIn(globalBuckets, bucketName, globalRate, now), globalRate, now);
}
function pruneIdleBuckets(now = Date.now()) {
  for (const [ip, tracked] of trackedIps) {
    if (now - tracked.seenAt < MINUTE_MS) break;
    trackedIps.delete(ip);
  }
}

function readJsonBody(req) {
  return new Promise(resolve => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return resolve({ error: 'unsupported_type' });
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return resolve({ error: 'too_large' });
    const chunks = [];
    let receivedBytes = 0, settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: 'timeout' }), bodyTimeoutMs);
    req.on('data', chunk => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) finish({ error: 'too_large' });
      else chunks.push(chunk);
    });
    req.on('error', () => finish({ error: 'bad_request' }));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish({ error: 'bad_request' }); }
      finish(body && typeof body === 'object' && !Array.isArray(body) ? { body } : { error: 'bad_request' });
    });
  });
}

function startRun(req, res, { body, now }) {
  const { mode, job, challengeId, race, mutators } = body;
  if (!hasValidator(mode)) return { ok: false, error: 'unsupported_mode' };
  const roomCode = typeof body.roomCode === 'string' ? body.roomCode.toUpperCase() : '';
  if (!ROOM_CODE_PATTERN.test(roomCode)) return BAD_REQUEST;
  if ((mode === 'shift' || job != null) && !SHIFT_JOBS.includes(job)) return BAD_REQUEST;
  if (challengeId != null && !matches(CHALLENGE_ID_PATTERN, challengeId)) return BAD_REQUEST;
  if (race != null && !isInt(race, 0, MAX_RACE_INDEX)) return BAD_REQUEST;
  if (mutators != null && !(Array.isArray(mutators) && mutators.length <= MAX_MUTATORS
      && mutators.every(mutatorId => matches(MUTATOR_ID_PATTERN, mutatorId)))) return BAD_REQUEST;
  const { checkStart } = validatorFor(mode);
  if (checkStart) {
    const verdict = checkStart({ ...body, roomCode }, now);
    if (!verdict || !verdict.ok) return { ok: false, error: START_CHECK_ERRORS.has(verdict && verdict.error) ? verdict.error : 'bad_request' };
  }
  const issued = runs.issue({ mode, job, roomCode, challengeId, race, mutators }, now);
  return issued.token.length > runs.MAX_TOKEN_LENGTH ? BAD_REQUEST : { ok: true, ...issued };
}

function logBytesExceeded(log, maxLogBytes) {
  return Boolean(maxLogBytes) && Buffer.byteLength(JSON.stringify(log ?? null)) > maxLogBytes;
}
function runVerdict(ctx) {
  try { return validateRun(ctx) || { ok: false, reason: 'no_verdict' }; } catch (error) {
    log('validator-error', ctx.run.mode, error && error.message);
    return { ok: false, reason: 'validator_error' };
  }
}
function writeBoards(verdict, name, now) {
  const boardResults = verdict.boards.map(boardId => ({
    id: boardId,
    ...(boards.submit(boardId, { name, value: verdict.value, ms: verdict.ms, at: now, meta: verdict.meta })
      || { rank: null, best: null, improved: false }),
  }));
  return { ok: true, value: verdict.value, boards: boardResults };
}

function submitRun(req, res, { body, now, ip }) {
  const verified = runs.verify(body.token, now);
  if (!verified.ok) return verified;
  const { run } = verified;
  const stored = runs.storedResponse(run);
  if (stored) return stored;
  const name = normalizeName(body.name);
  if (!name) return { ok: false, error: 'bad_name' };
  if (logBytesExceeded(body.log, validatorFor(run.mode)?.maxLogBytes)) return { ok: false, error: 'too_large' };
  const verdict = runVerdict({ run, log: body.log, name, now });
  let response;
  if (verdict.ok) response = writeBoards(verdict, name, now);
  else {
    log('run-rejected', run.mode, verdict.reason, hashIp(ip));
    response = { ok: false, error: 'rejected' };
  }
  runs.consumeRun(run, response);
  return response;
}

function boardLimit(rawLimit) {
  const limit = Number.parseInt(rawLimit, 10);
  return Number.isFinite(limit) ? Math.max(1, Math.min(MAX_BOARD_LIMIT, limit)) : DEFAULT_BOARD_LIMIT;
}
function readBoard(req, res, { query }) {
  const result = boards.top(query.get('id'), boardLimit(query.get('limit')), normalizeName(query.get('name')));
  return result.ok ? result : BAD_REQUEST;
}

function registerApiRoute(method, routePath, handler, bucketName = null) {
  if (bucketName !== null && !BUCKET_RATES[bucketName]) throw new Error(`unknown rate bucket ${bucketName}`);
  if (!routes.has(routePath)) routes.set(routePath, new Map());
  routes.get(routePath).set(method, { handler, bucketName });
}

async function dispatch(req, res, route, url) {
  const ip = clientIp(req);
  let body = null;
  if (req.method === 'POST') {
    const parsed = await readJsonBody(req);
    if (parsed.error) return sendErrorAndClose(req, res, parsed.error);
    body = parsed.body;
  }
  const retryAfter = retryAfterSeconds(ip, route.bucketName, Date.now());
  if (retryAfter) return sendError(res, 'rate_limited', { 'retry-after': String(retryAfter) });
  const payload = await route.handler(req, res, { body, query: url.searchParams, ip, now: Date.now() });
  if (!payload || res.headersSent) return;
  if (payload.ok === false) sendError(res, payload.error);
  else sendJson(res, 200, payload);
}

function handleApi(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return false; }
  const methods = routes.get(url.pathname);
  if (!methods) return false;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, PREFLIGHT_HEADERS);
    res.end();
    return true;
  }
  const route = methods.get(req.method);
  if (!route) {
    sendError(res, 'method_not_allowed', { allow: [...methods.keys(), 'OPTIONS'].join(', ') });
    return true;
  }
  dispatch(req, res, route, url).catch(error => {
    log('api-error', url.pathname, error && error.message);
    if (!res.headersSent) sendError(res, 'server_error');
  });
  return true;
}

function _setBodyTimeoutMs(ms) { bodyTimeoutMs = ms; }
function _reset() {
  trackedIps.clear();
  for (const bucketName of Object.keys(globalBuckets)) delete globalBuckets[bucketName];
  bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS;
}

registerApiRoute('POST', '/runs/start', startRun, 'start');
registerApiRoute('POST', '/runs/submit', submitRun, 'submit');
registerApiRoute('GET', '/boards', readBoard, 'boards');
setInterval(() => pruneIdleBuckets(), MINUTE_MS).unref?.();

module.exports = {
  handleApi, registerApiRoute, normalizeName, clientIp, hashIp, pruneIdleBuckets, _setBodyTimeoutMs, _reset,
  MAX_BODY_BYTES, MAX_TRACKED_IPS, BUCKET_RATES, GLOBAL_BUCKET_RATES, ERROR_STATUS,
};
