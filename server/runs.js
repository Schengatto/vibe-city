'use strict';

const crypto = require('node:crypto');
const boards = require('./boards');

const TOKEN_TTL_MS = 3 * 3600 * 1000;
const TOKEN_VERSION = 1;
const MAX_TOKEN_LENGTH = 512;
const MIN_SECRET_LENGTH = 32;
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;
const BAD_TOKEN = Object.freeze({ ok: false, error: 'bad_token' });
const TOKEN_EXPIRED = Object.freeze({ ok: false, error: 'token_expired' });

const log = (...parts) => console.log(new Date().toISOString(), '[runs]', ...parts);

function resolveSecret() {
  const configured = process.env.RUNS_SECRET || '';
  if (configured.length >= MIN_SECRET_LENGTH) return configured;
  log('RUNS_SECRET missing or shorter than 32 chars: random secret, run tokens die with a restart');
  return crypto.randomBytes(32);
}
const SECRET = resolveSecret();

function sign(payloadPart) { return crypto.createHmac('sha256', SECRET).update(payloadPart).digest(); }
function keyedHash(value) { return crypto.createHmac('sha256', SECRET).update(`hash:${value}`).digest('hex'); }

function issue({ mode, job, roomCode, challengeId, race, mutators } = {}, now = Date.now()) {
  const payload = { v: TOKEN_VERSION, n: crypto.randomBytes(16).toString('hex'), s: now, m: mode, r: roomCode };
  if (job != null) payload.j = job;
  if (challengeId != null) payload.c = challengeId;
  if (race != null) payload.k = race;
  if (mutators && mutators.length) payload.u = mutators;
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${payloadPart}.${sign(payloadPart).toString('base64url')}`, startedAt: now };
}

function decodePayload(payloadPart) {
  try { return JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')); } catch { return null; }
}

function verify(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return BAD_TOKEN;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => BASE64URL_PART.test(part))) return BAD_TOKEN;
  const [payloadPart, signaturePart] = parts;
  const expectedSignature = Buffer.from(sign(payloadPart).toString('base64url'));
  const givenSignature = Buffer.from(signaturePart);
  if (givenSignature.length !== expectedSignature.length) return BAD_TOKEN;
  if (!crypto.timingSafeEqual(givenSignature, expectedSignature)) return BAD_TOKEN;
  const payload = decodePayload(payloadPart);
  if (!payload || payload.v !== TOKEN_VERSION || typeof payload.n !== 'string' || !Number.isFinite(payload.s)) return BAD_TOKEN;
  const age = now - payload.s;
  if (age < 0) return BAD_TOKEN;
  if (age > TOKEN_TTL_MS) return TOKEN_EXPIRED;
  return {
    ok: true,
    run: {
      mode: payload.m, job: payload.j ?? null, roomCode: payload.r, challengeId: payload.c ?? null,
      race: payload.k ?? null, mutators: payload.u || [], startedAt: payload.s, nonce: payload.n,
    },
  };
}

function storedResponse(run) { return boards.lookupNonce(run.nonce); }
function consumeRun(run, response) { return boards.consumeNonce(run.nonce, run.startedAt + TOKEN_TTL_MS, response); }

module.exports = { issue, verify, storedResponse, consumeRun, keyedHash, TOKEN_TTL_MS, TOKEN_VERSION, MAX_TOKEN_LENGTH };
