#!/usr/bin/env node
/**
 * Small helper used by setup.sh and setup.ps1, so both use one implementation for
 * reading and writing .env and for checking the settings. Plain JavaScript (no
 * build step needed).
 *
 *   node scripts/setup-helper.js node-ok             exit 0 if this Node.js is 22.13 or newer
 *   node scripts/setup-helper.js env-show            print KEY=value for every setting in .env.example
 *                                                    (value from .env, else the example default)
 *   node scripts/setup-helper.js validate [KEY]      check the values with the bridge's own config
 *                                                    loader (needs dist/); prints one problem per line
 *   node scripts/setup-helper.js env-write           write .env from .env.example and the values
 *   node scripts/setup-helper.js tcp <host> <port>   can we open a TCP connection? (5 s timeout)
 *
 * `validate` and `env-write` take the values from environment variables named
 * ZKSET_<KEY>. When ZKSET__ALL=1 is set, a missing ZKSET_<KEY> means an empty value
 * (PowerShell can't set an environment variable to an empty string).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_BAK = path.join(ROOT, '.env.bak');
const ENV_TMP = path.join(ROOT, '.env.tmp');
const EXAMPLE_FILE = path.join(ROOT, '.env.example');
const KEY_LINE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;
const PREFIX = 'ZKSET_';

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/** The lines of .env.example and its settings in file order: [{ key, value }]. */
function template() {
  const dotenv = require('dotenv');
  const lines = readText(EXAMPLE_FILE).split(/\r?\n/);
  const settings = [];
  for (const line of lines) {
    const m = KEY_LINE.exec(line);
    if (m) settings.push({ key: m[1], value: dotenv.parse(line)[m[1]] ?? '' });
  }
  return { lines, settings };
}

/** The current .env, parsed exactly like the bridge parses it. */
function currentEnv() {
  if (!fs.existsSync(ENV_FILE)) return {};
  return require('dotenv').parse(readText(ENV_FILE));
}

/** Value of a setting passed in by the calling script, or undefined. */
function given(key) {
  const v = process.env[PREFIX + key];
  if (v !== undefined) return v;
  return process.env[PREFIX + '_ALL'] === '1' ? '' : undefined;
}

function nodeOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function envShow() {
  const env = currentEnv();
  for (const { key, value } of template().settings) {
    let v = Object.prototype.hasOwnProperty.call(env, key) ? env[key] : value;
    if (/[\r\n]/.test(v)) {
      process.stderr.write(`${key} in .env has a line break in it; using the default instead\n`);
      v = value;
    }
    process.stdout.write(`${key}=${v}\n`);
  }
}

/** Runs the bridge's real config loader on the given values. Returns the problems. */
function problems() {
  const configJs = path.join(ROOT, 'dist', 'config.js');
  if (!fs.existsSync(configJs)) return ['dist/config.js not found: build first (npm run build)'];
  for (const { key } of template().settings) {
    const v = given(key);
    if (v === undefined) delete process.env[key]; // then the value in .env is used
    else process.env[key] = v; // dotenv never overrides a variable that is already set
  }
  const { loadConfig, ConfigError } = require(configJs);
  try {
    loadConfig({ requireCrm: true });
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) return [`Unexpected error while checking the settings: ${e && e.message}`];
    const list = String(e.message)
      .split('\n')
      .filter((l) => l.startsWith('  - '))
      .map((l) => l.slice(4));
    return list.length ? list : [String(e.message)];
  }
}

function validate(onlyKey) {
  let list = problems();
  if (onlyKey) list = list.filter((p) => p.startsWith(`${onlyKey} `));
  for (const p of list) process.stdout.write(`${p}\n`);
  return list.length === 0;
}

/** KEY=value the way dotenv reads it back exactly. Throws for values it can't hold. */
function renderValue(key, v) {
  if (/[\r\n]/.test(v)) throw new Error(`${key}: line breaks are not allowed`);
  if (/^[A-Za-z0-9_.:/@+,%=-]*$/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes('\\')) return `"${v}"`;
  throw new Error(`${key}: a value can't contain both kinds of quotes`);
}

function envWrite() {
  const { lines, settings } = template();
  const env = currentEnv();
  const known = new Set(settings.map((s) => s.key));
  const value = (key, def) => {
    const v = given(key);
    if (v !== undefined) return v.trim();
    return Object.prototype.hasOwnProperty.call(env, key) ? env[key] : def;
  };

  const out = ['# Written by the zk-bridge setup script. You can edit it by hand, then restart the bridge.', ''];
  for (const line of lines) {
    const m = KEY_LINE.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const def = settings.find((s) => s.key === m[1]).value;
    out.push(`${m[1]}=${renderValue(m[1], value(m[1], def))}`);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  const extra = Object.keys(env).filter((k) => !known.has(k));
  if (extra.length) {
    out.push('', '# Other settings kept from your previous .env');
    for (const k of extra) out.push(`${k}=${renderValue(k, env[k])}`);
  }

  const eol = process.platform === 'win32' ? '\r\n' : '\n';
  const text = out.join(eol) + eol;
  const old = fs.existsSync(ENV_FILE) ? readText(ENV_FILE) : null;
  if (old !== null && old.replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n')) {
    process.stdout.write('unchanged\n');
    return;
  }
  if (old !== null) fs.copyFileSync(ENV_FILE, ENV_BAK);
  fs.writeFileSync(ENV_TMP, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(ENV_TMP, ENV_FILE);
  if (process.platform !== 'win32') fs.chmodSync(ENV_FILE, 0o600); // it holds the device key
  process.stdout.write(old === null ? 'created\n' : 'saved\n');
}

function tcp(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: Number(port) });
    const done = (reason) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(reason);
    };
    const timer = setTimeout(() => done('no answer within 5 s'), 5000);
    sock.on('connect', () => done(null));
    sock.on('error', (e) => {
      const why = {
        ECONNREFUSED: 'connection refused (wrong port, or something else is at that address)',
        EHOSTUNREACH: 'no route to that address (not on this network?)',
        ENETUNREACH: 'network unreachable (is this computer connected?)',
        ETIMEDOUT: 'no answer (timed out)',
        ENOTFOUND: 'that name could not be resolved',
      }[e.code];
      done(why || e.code || e.message);
    });
  });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'node-ok':
      process.stdout.write(`${process.version}\n`);
      return nodeOk() ? 0 : 1;
    case 'env-show':
      envShow();
      return 0;
    case 'validate':
      return validate(args[0]) ? 0 : 1;
    case 'env-write':
      envWrite();
      return 0;
    case 'tcp': {
      if (args.length < 2) throw new Error('usage: tcp <host> <port>');
      const reason = await tcp(args[0], args[1]);
      if (reason) process.stdout.write(`${reason}\n`);
      return reason ? 1 : 0;
    }
    default:
      throw new Error(`unknown command "${cmd || ''}"`);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`setup-helper: ${e && e.message ? e.message : e}\n`);
    process.exit(2);
  },
);
