# Build `zk-bridge`: ZKTeco K40 → Cloud CRM attendance bridge

## Context

We have a **ZKTeco K40** fingerprint attendance device on the office LAN and a **CRM/HR system in the cloud** (NestJS + TypeORM + PostgreSQL). The cloud server cannot reach the device because it is behind the office router, and we will NOT open or port-forward any ports.

Build a small, reliable **bridge agent** in TypeScript/Node.js. It runs 24/7 on an office **Windows laptop** (later possibly a Raspberry Pi / Linux, so it must stay cross-platform). It reads punches from the K40 over the LAN and pushes them to the CRM over HTTPS. It makes **outbound connections only**.

```
K40 (TCP 4370, LAN)  ->  zk-bridge (Windows laptop)  ->  HTTPS  ->  CRM /device-api/*
```

Scope: **only the bridge agent**. Do NOT build the CRM side. The CRM API contract the bridge talks to is defined below. Build against it and use a mock server for testing.

## Tech constraints

- Node.js **>= 22.13**, TypeScript (strict), CommonJS output to `dist/`.
- Device library: **`zkteco-js@1.7.2`** (pin the exact version).
- Local storage: Node's built-in **`node:sqlite`** (`DatabaseSync`). No native modules (no better-sqlite3), so `npm install` works on Windows without build tools.
- Config via `dotenv`. Use the built-in `fetch` with `AbortSignal.timeout`. Keep dependencies minimal: `zkteco-js`, `dotenv`, plus dev deps `typescript`, `tsx`, `@types/node`.
- No Docker, no WSL. It must run as a native Windows service.

## Verified facts about zkteco-js 1.7.2 (read from its source; confirm in `node_modules/zkteco-js` before coding)

- Constructor order is `new Zkteco(ip, port, timeout, inport, maxChunk?)`. `timeout` = socket timeout in ms, `inport` = local UDP port used only for the UDP fallback.
- `createSocket(cbErr?, cbClose?)` tries TCP and falls back to UDP only on `ECONNREFUSED`. It sets `connectionType` to `'tcp'` or `'udp'`.
- **No Comm Key / device password support.** The device's Comm Key must be `0`. Document this clearly.
- `getAttendances()` returns `{ data: records }`:
  - TCP record: `{ sn, user_id: string, record_time: string /* Date#toString() */, type: number, state: number }`
  - UDP record: `{ user_id: number, record_time: Date }`
  - Normalize both shapes.
- `getRealTimeLogs(cb)` calls `cb({ userId, attTime: Date })`. It has no state or verify type. It attaches a `'data'` listener only if the socket has none, so **don't run other commands on the same socket while listening**.
- `getUsers()` returns `{ data: [{ uid, role, password, name, cardno, userId }] }`.
- `getInfo()` returns `{ userCounts, logCounts, logCapacity }`. `getTime()` returns a `Date`. `setTime(Date)`. `getSerialNumber()`.
- `setUser(uid, userid, name, password, role=0, cardno=0)`: uid 1–3000, userid ≤ 9 chars, name ≤ 24, password ≤ 8, cardno is written as uint16. `deleteUser(uid)`.
- **Errors are nested `ZkError` objects** (`{ err, ip, command }`), not `Error` instances. Write an `errMsg(e)` helper that digs into `.err` to find `.message`/`.code`. Never log or send `[object Object]`.
- Device timestamps are local wall-clock time with no offset. The library builds `Date`s in the **process timezone**. Set `process.env.TZ = DEVICE_TIMEZONE` before any device code runs (default `Asia/Dhaka`), then convert everything to **ISO-8601 UTC** before storing or sending.
- Reusing a library instance after disconnect is unreliable. **Create a fresh `Zkteco` instance per session.**

## Project structure

```
zk-bridge/
  package.json            scripts: build, start, dev (tsx), poc (tsx src/poc.ts), typecheck
  tsconfig.json
  .env.example
  README.md
  scripts/install-service.ps1
  src/
    config.ts             env loading + validation, sets process.env.TZ
    logger.ts             tiny leveled logger (debug/info/warn/error), ISO timestamps
    errors.ts             errMsg() helper for ZkError
    types/zkteco-js.d.ts  typings written from the library source
    device.ts             DeviceClient wrapper
    outbox.ts             SQLite outbox
    crm-client.ts         CRM HTTP client
    commands.ts           runs CRM commands on the device
    index.ts              main orchestration
    poc.ts                Phase 1 device-only test
```

## Configuration (`.env.example`)

```
DEVICE_IP=192.168.1.201
DEVICE_PORT=4370
DEVICE_TIMEOUT_MS=10000
DEVICE_UDP_INPORT=5200
DEVICE_TIMEZONE=Asia/Dhaka
CRM_BASE_URL=https://crm.example.com/api
CRM_DEVICE_KEY=replace-me
FULL_PULL_INTERVAL_SEC=600
FLUSH_INTERVAL_SEC=15
HEARTBEAT_INTERVAL_SEC=60
COMMAND_POLL_INTERVAL_SEC=20
TIME_SYNC_INTERVAL_HOURS=24
OUTBOX_PATH=./data/outbox.db
LOG_LEVEL=info
```

Validation:
- `DEVICE_IP` is required.
- `CRM_BASE_URL` and `CRM_DEVICE_KEY` are required only for the main service, not for `poc`.
- `CRM_BASE_URL` must be `https://`. Allow `http://` only for localhost/127.0.0.1.
- Fail fast with a clear message.

## Components

### 1. DeviceClient (`device.ts`)

Normalized punch type:
```ts
interface Punch {
  deviceUserId: string;      // trimmed string
  punchedAt: string;         // ISO-8601 UTC
  state: number | null;      // from pulled TCP logs only
  verifyType: number | null; // from pulled TCP logs only
  source: 'realtime' | 'pull';
}
```

Requirements:
- **`runExclusive(name, fn)`**: a promise-chain mutex. Only one operation talks to the device at a time. Each operation:
  1. pauses the real-time socket,
  2. opens a fresh instance,
  3. runs `fn`,
  4. disconnects in `finally`,
  5. resumes real-time if it was wanted.
- Operations:
  - `pullAll(): Punch[]`. Also refreshes cached `lastStats`.
  - `getUsers()`, `setUser(...)`, `deleteUser(uid)`
  - `syncTime()`: sets the device clock from the machine, returns the device time read back.
  - `stats()`: `{ userCounts, logCounts, logCapacity, deviceTime, serialNumber }`
- Drop records with an empty user ID or an invalid date.
- **Real-time:**
  - `startRealtime(onPunch)` / `stopRealtime()` keep one long-lived instance listening via `getRealTimeLogs`.
  - On socket error or close, reconnect with exponential backoff: 5s doubling, max 2 min, reset after a successful connect.
  - Ignore close events caused by our own pause.
  - Expose `online: boolean` and `lastStats`.

### 2. Outbox (`outbox.ts`)

SQLite with WAL. Two tables:
- `punches`: `key TEXT PK` (`${deviceUserId}|${punchedAt}`), `device_user_id`, `punched_at`, `state`, `verify_type`, `source`, `created_at`, `sent_at NULL`, `attempts`. Index on `(sent_at, punched_at)`.
- `meta`: `k TEXT PK`, `v`, for `last_time_sync`.

Methods:
- `add(punches): number`: `INSERT OR IGNORE` in one transaction, returns how many were new.
- `pending(limit=500)`: oldest first.
- `pendingCount()`, `markSent(keys)`, `markAttempt(keys)`
- `pruneSent(days=90)`, `getMeta`, `setMeta`, `close`

Create the data directory if it's missing.

### 3. CRM client (`crm-client.ts`)

All requests send headers `x-device-key: <CRM_DEVICE_KEY>`, `content-type: application/json` and `user-agent: zk-bridge/<version>`, with a 20s timeout. Non-2xx responses throw `CrmError(message, status)` with `permanent = 4xx except 408/429`.

**API contract (the CRM will implement exactly this):**

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/device-api/punches` | `{ punches: Punch[] }` (max 1000) | `{ accepted: number, duplicates: number }` |
| POST | `/device-api/heartbeat` | `{ deviceOnline: boolean, pendingPunches: number, bridgeVersion: string, stats: {userCounts, logCounts, logCapacity, deviceTime, serialNumber} \| null }` | `{ ok: true }` |
| GET | `/device-api/commands` | none | `{ commands: [{ id: string, type, payload: object \| null }] }` |
| POST | `/device-api/commands/:id/ack` | `{ success: boolean, result?: any, error?: string }` | `{ ok: true }` |

The CRM deduplicates punches on `(device, deviceUserId, punchedAt)`, so re-sending is always safe.

### 4. Commands (`commands.ts`)

Validate each payload and throw a clear error message on bad input:
- `SET_USER` `{ uid 1–3000, userId ≤9, name ≤24, password? ≤8, role? 0–14, cardno? 0–65535 }`
- `DELETE_USER` `{ uid }`
- `SYNC_TIME`: also updates `meta.last_time_sync`. Returns `{ deviceTime }`.
- `PULL_ALL`: pulls all logs and adds them to the outbox. Returns `{ onDevice, newlyQueued }`.
- `GET_USERS`: returns `{ users: [{uid, userId, name, role, cardno}] }`. **Never send `password` or fingerprint data.**
- An unknown type throws.

Each command is acked with `success: true` and its result, or `success: false` and `errMsg(err)`.

### 5. Main loop (`index.ts`)

Startup:
1. Validate config and log the version, device and timezone, plus the pending outbox count.
2. **Initial full pull** to catch up on everything punched while the bridge was off, then flush. A failure here is logged, not fatal.
3. Start real-time. On each new punch (one that `outbox.add` reports as new), log it and trigger a flush immediately.

Intervals (use a helper that never overlaps a task with itself and logs failures without crashing):
- full pull (`FULL_PULL_INTERVAL_SEC`, don't run at start, it already ran)
- flush (`FLUSH_INTERVAL_SEC`)
- heartbeat (`HEARTBEAT_INTERVAL_SEC`, sends cached stats, does NOT touch the device)
- command poll (`COMMAND_POLL_INTERVAL_SEC`)
- time sync (checked hourly, runs when `last_time_sync` is older than `TIME_SYNC_INTERVAL_HOURS`; 0 disables it)
- prune (daily)

Flush rules:
- Send batches of 500.
- On success, `markSent`. On failure, `markAttempt`, stop this round and leave the punches queued.
- Log permanent errors at `error` level with a hint to check the device key.

Other rules:
- **Never call `clearAttendanceLog()` or `clearData()`** anywhere.
- Graceful shutdown on SIGINT/SIGTERM: clear timers, stop real-time, final flush, close the DB, exit 0. NSSM stops the service with Ctrl+C, so SIGINT must work on Windows.
- Log unhandled rejections and keep running.

### 6. Phase 1 POC (`poc.ts`, `npm run poc`)

Device only, no CRM config needed. It:
- prints stats,
- prints the user count and a table of the first 20 users,
- prints the log count and a table of the latest 20 logs (userId, UTC, local time, state),
- then listens for live punches and prints `LIVE punch: user X at <local time>` until Ctrl+C.

On failure, print `errMsg` and a hint: check IP/port, same network, ping, Comm Key = 0.

### 7. Windows service (`scripts/install-service.ps1`)

A PowerShell script, run as Administrator, that uses **NSSM**:
- check that nssm, `dist/index.js` and `.env` exist
- remove any existing service
- install `node dist/index.js` with AppDirectory = project dir
- auto start
- stdout/stderr to `logs/bridge.log` with rotation (10 MB)
- restart delay 5s
- `AppStopMethodConsole 10000`
- start the service and print the manage commands

Parameters: `-ServiceName` (default `ZKBridge`), `-Nssm` path.

### 8. README.md

Cover:
- what the bridge does
- K40 setup: static IP, port 4370, **Comm Key = 0**, same switch
- laptop setup: Node install, `npm install`, `.env`, `npm run poc` (and check that the local time matches the device screen), `npm run build && npm start`, service install
- Windows laptop settings: sleep never, lid "do nothing", NIC power saving off, Windows Update active hours, Ethernet preferred, UPS for router + K40
- "If the laptop is off" (the device keeps logs and startup catches up)
- a troubleshooting table
- how to move to a Raspberry Pi (systemd/pm2)

## Testing (do this before finishing)

1. `npm run typecheck` passes with zero errors.
2. Write a small unit-style script (or `node:test` tests) for the outbox: dedupe, pending order, markSent, pruneSent, meta.
3. Create `test/mock-crm.js`, a plain Node http server implementing the 4 endpoints above. It logs requests and serves one `GET_USERS` command once. Run the bridge against it with `DEVICE_IP=127.0.0.1` (no device) and confirm:
   - pre-seeded outbox punches get sent and marked sent
   - heartbeats arrive with `deviceOnline:false`
   - the command is acked with `success:false` and a readable error (not `[object Object]`)
   - device connection failures retry with backoff without crashing
   - Ctrl+C shuts down cleanly
4. `npm run poc` with an unreachable IP prints a clean error and the hint.

## Acceptance criteria

- No punch is ever lost: every punch hits SQLite before any network send and is marked sent only after a 2xx.
- Restarting the bridge or turning the laptop off for days results in a complete backfill on the next start.
- Timestamps sent to the CRM are UTC ISO strings that match the device's local clock in `DEVICE_TIMEZONE`.
- Runs unattended as a Windows service, survives reboots, device restarts, network drops and CRM downtime.
- Code is small, readable and commented where behaviour is non-obvious (library quirks, why sessions are exclusive).
