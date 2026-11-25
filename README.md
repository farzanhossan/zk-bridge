# zk-bridge

A small agent that reads attendance punches from a **ZKTeco K40** on the office LAN and pushes them to the CRM over HTTPS.

```
K40 (TCP 4370, LAN)  ->  zk-bridge (office laptop)  ->  HTTPS  ->  CRM /device-api/*
```

- **Outbound connections only.** No ports are opened or forwarded on the office router.
- **No punch is lost.** Every punch is written to a local SQLite outbox before anything is sent, and it is marked sent only after the CRM answers 2xx. Re-sending is always safe because the CRM deduplicates on `(device, deviceUserId, punchedAt)`.
- **It catches up on its own.** On every start, and every 10 minutes after that, it downloads the full device log. If the laptop was off for days, the next start backfills everything.
- **Live punches arrive within seconds.** A real-time listener stores each punch and sends it immediately.
- It runs as a native Windows service through NSSM, with no Docker or WSL. It also runs on Linux or a Raspberry Pi.

## How it works

| Piece | What it does |
|---|---|
| `src/device.ts` | Talks to the K40 through `zkteco-js`. Runs one device operation at a time, each on a fresh connection, and pauses the real-time listener around it. |
| `src/live-events.ts` | The live-punch protocol (start, decode, acknowledge), done here because the library's version gets nothing from the K40. |
| `src/outbox.ts` | SQLite queue (`data/outbox.db`, WAL). Each punch's key is `deviceUserId|punchedAt`, so pulling the same log again is harmless. |
| `src/crm-client.ts` | HTTPS client for the four CRM endpoints (`x-device-key` header, 20 s timeout). |
| `src/commands.ts` | Runs commands queued in the CRM (`SET_USER`, `DELETE_USER`, `SYNC_TIME`, `PULL_ALL`, `GET_USERS`) and acks each result. |
| `src/index.ts` | Startup catch-up, real-time listener, timers, graceful shutdown. |
| `src/poc.ts` | Device-only test (`npm run poc`). |

Schedules (all configurable in `.env`):

| Task | Default | Notes |
|---|---|---|
| Full pull | 10 min | Downloads every log on the device. Catches anything the live listener missed. |
| Flush | 15 s | Sends queued punches in batches of 500. Also runs immediately on every live punch. |
| Heartbeat | 60 s | Device online flag, queue size, version and cached device stats. Never touches the device. |
| Command poll | 20 s | Fetches and runs CRM commands. |
| Time sync | 24 h | Sets the K40 clock from the laptop clock. Checked at startup and then hourly. `0` disables it. |
| Prune | daily | Deletes sent punches older than 90 days, but only once they are no longer on the device. Otherwise the next pull would queue them again. |
| Status line | 15 min | Writes one `Status: OK - …` or `Status: PROBLEM - …` line to the log, also about 1 min after start and after a wake. See "How to see that it's working" in [WINDOWS-SETUP.md](WINDOWS-SETUP.md). |

The bridge **never clears logs or data on the device**.

Timestamps: the K40 stores local wall-clock time with no offset. The bridge runs in `DEVICE_TIMEZONE` (default `Asia/Dhaka`), whatever the Windows timezone is, and sends **UTC ISO-8601** strings such as `2026-11-24T03:01:02.000Z` for a punch made at 09:01:02 in Dhaka.

## 1. K40 setup

On the device (menu names vary a little by firmware, usually under **Menu > Comm.**):

1. **Static IP**, e.g. `192.168.1.201`, with the netmask and gateway of the office LAN. Reserve that address in the router's DHCP settings too, so nothing else takes it.
2. **Port 4370** (the default).
3. **Comm Key = 0.** This is required. `zkteco-js` cannot send a Comm Key. With a key set, the bridge reports `ACK_UNAUTH: a Comm Key is set on the K40`.
4. Plug the K40 into the **same switch** as the laptop, on the same subnet.
5. Don't leave other attendance software (ZKTime, ZKBioTime…) connected to the device at the same time. The K40 handles one client at a time.

## 2. Laptop setup (Windows)

> For a full step-by-step walkthrough with what you should see at each step, follow **[WINDOWS-SETUP.md](WINDOWS-SETUP.md)**. The short version is below.

1. **Install Node.js 22.13 or newer** (LTS) from <https://nodejs.org>, or run `winget install OpenJS.NodeJS.LTS`. Open a new PowerShell and check with `node --version`.
2. **Copy this folder** to a permanent place, e.g. `C:\zk-bridge`, then:

   ```powershell
   cd C:\zk-bridge
   npm install
   copy .env.example .env
   notepad .env
   ```

   Set at least `DEVICE_IP`, `CRM_BASE_URL` (must be `https://`) and `CRM_DEVICE_KEY`.

3. **Test the device connection** (no CRM needed):

   ```powershell
   npm run poc
   ```

   It prints device stats, the first 20 users and the latest 20 logs, then waits for live punches. **Check that "device time (local)" matches the clock on the K40 screen**, and that the `local` column of the logs looks right. Punch a finger and you should see `LIVE punch: user X at …`. Press Ctrl+C to stop.

4. **Build and run it in the foreground** once, to see it work end to end:

   ```powershell
   npm run build
   npm start
   ```

   You should see `Pull: N log(s) on the device…`, `Sent … punch(es) to the CRM` and `Real-time listener connected`. Press Ctrl+C to stop.

5. **Install it as a service.** Download NSSM from <https://nssm.cc/download> and unzip it (e.g. to `C:\tools\nssm`). Then, in **PowerShell as Administrator**:

   ```powershell
   cd C:\zk-bridge
   powershell -ExecutionPolicy Bypass -File .\scripts\install-service.ps1 -Nssm C:\tools\nssm\win64\nssm.exe
   ```

   The service is called `ZKBridge`. It starts automatically at boot (no login needed), restarts 5 s after any crash, and logs to `logs\bridge.log` (rotated at 10 MB). Run the script again after an update to reinstall the service.

   ```powershell
   nssm status ZKBridge
   nssm restart ZKBridge
   Get-Content C:\zk-bridge\logs\bridge.log -Tail 50 -Wait
   ```

   **Updating:** `nssm stop ZKBridge`, replace the files (keep `.env` and `data\`), `npm install`, `npm run build`, `nssm start ZKBridge`.

## 3. Windows laptop settings

The laptop is now infrastructure. Set it up like a small server.

- **Never sleep or hibernate**, on mains or battery. In an Administrator PowerShell:

  ```powershell
  powercfg /change standby-timeout-ac 0
  powercfg /change standby-timeout-dc 0
  powercfg /change hibernate-timeout-ac 0
  powercfg /change hibernate-timeout-dc 0
  ```

  The screen may still turn off. That's fine.
- **Lid closed = "Do nothing"** (Control Panel > Power Options > Choose what closing the lid does), or:

  ```powershell
  powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
  powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
  powercfg /setactive SCHEME_CURRENT
  ```

- **Network adapter power saving off:** Device Manager > Network adapters > your Ethernet adapter > Power Management > untick "Allow the computer to turn off this device to save power". If the Advanced tab has "Energy Efficient Ethernet" or "Green Ethernet", disable that too.
- **Use Ethernet, not Wi-Fi.** Plug into the same switch as the K40. If Wi-Fi is also on, make sure it isn't the route to the K40 (or turn Wi-Fi off).
- **Windows Update:** set Active hours to cover office hours (Settings > Windows Update > Advanced options) so restarts happen at night. The service comes back by itself after a reboot.
- **Put a UPS on the router, the switch and the K40.** The laptop has its own battery.
- Keep the Windows clock on automatic time sync (the default). The bridge copies it to the K40 once a day.

## 4. After shutdown, restart, sleep or a power cut

You never need to start anything by hand after the one-time install.

| What happened | What the bridge does by itself |
|---|---|
| PC shut down or restarted (also after Windows Update) | The service starts at boot, before anyone logs in, then pulls the full device log and sends whatever is new. |
| PC slept or hibernated (also Windows "Fast Startup") | The service was only paused. On wake it logs `Resumed after ~X min`, waits 5 s for the network, then pulls and sends the punches made while asleep. |
| Network or K40 not ready yet (after boot, a K40 reboot, an unplugged cable) | It keeps retrying the live connection (5 s, doubling up to 2 min). Once the K40 answers, it logs `Device reachable again` and pulls straight away. |
| Internet or CRM down | Punches wait in `data\outbox.db` and are sent when the CRM answers again. |
| The bridge crashed | NSSM restarts it after 5 s. |

To check after a restart, open `logs\bridge.log` and look for `Bridge running`.

### If the laptop is off for a long time

Nothing is lost. The K40 keeps every punch in its own memory (`npm run poc` shows its log capacity). When the bridge starts again, it downloads the full device log, queues whatever is new and sends it. The same applies if the CRM or the internet is down: punches wait in `data\outbox.db` and go out when the CRM answers again. Don't delete `data\outbox.db` while punches are pending (the heartbeat reports `pendingPunches`). Even if it is deleted, the next full pull re-queues everything still on the device, and the CRM ignores duplicates.

Because the bridge never clears the device, the K40 log slowly fills up. Watch `logCounts` and `logCapacity` in the heartbeat stats. When it gets close to full, first check that `pendingPunches` is 0 and that the CRM has the punches, then clear the attendance log from the device menu.

## 5. Troubleshooting

| Symptom (log or POC output) | Likely cause | What to do |
|---|---|---|
| `No answer from the device at … within 10 s` | Wrong `DEVICE_IP`, K40 off, or not on the same network | Check the IP on the K40 screen. Run `ping <ip>`. Check both are on the same switch and subnet. |
| `connect ECONNREFUSED <ip>:4370` | Wrong port, or something else is at that IP | Check `DEVICE_PORT` and the device's communication settings. |
| `ACK_UNAUTH: a Comm Key is set on the K40` | Comm Key is not 0 | Set Comm Key = 0 on the device. |
| `connect ECONNRESET` / `Real-time connection lost` again and again | Another program is connected to the K40, the network is unstable, or the NIC is power-saving | Close ZKTime or similar. Check the cable and switch. Turn NIC power saving off. Punches are still collected by the full pull. |
| Live punches don't show, but `Pull: … new` picks them up later | Look for `Could not decode a live punch (…)` in the log: this firmware sends a record layout the bridge doesn't know yet | Nothing is lost. Punches arrive within `FULL_PULL_INTERVAL_SEC`; lower it (e.g. 120) if needed. Send the hex from that log line to add the layout to `src/live-events.ts`. |
| Times in the CRM are off by whole hours | `DEVICE_TIMEZONE` is wrong | Set it to the timezone the K40 clock runs in. Check with `npm run poc`. |
| Times are off by minutes | The K40 clock drifted | Leave `TIME_SYNC_INTERVAL_HOURS` on, or queue a `SYNC_TIME` command from the CRM. |
| `HTTP 401` / `HTTP 403` … `check CRM_DEVICE_KEY` | Wrong or revoked device key | Fix `CRM_DEVICE_KEY` in `.env`, then `nssm restart ZKBridge`. Queued punches are kept. |
| `fetch failed: getaddrinfo ENOTFOUND …` | No internet or DNS on the laptop | Punches stay queued. Fix the network. |
| `fetch failed: … certificate …` | TLS problem: wrong laptop clock, proxy or antivirus intercepting HTTPS | Fix the clock. Allow the CRM host in the proxy or antivirus. |
| `Invalid configuration (check .env)` and the service keeps restarting | A missing or invalid setting | The message lists every problem. Fix `.env` and restart. |
| `database is locked` | Two bridges using the same `data\outbox.db` (e.g. `npm start` while the service runs) | Stop one of them. |
| Files like `24112026.err.log` in the project folder | `zkteco-js` writes these itself when it can't parse a packet | Harmless. You can delete them. |
| Need more detail | | Set `LOG_LEVEL=debug` in `.env` and restart. This also shows the library's own messages. |

## 6. Moving to a Raspberry Pi / Linux

The code is cross-platform. Only the service wrapper changes.

1. Install Node.js 22.13+ (e.g. from NodeSource or with `nvm`), copy the project to `/opt/zk-bridge`, then run `npm ci && npm run build`. Copy your `.env`. Copying `data/outbox.db` is optional: the first full pull backfills, and the CRM ignores duplicates.
2. Leave the OS timezone as it is. `DEVICE_TIMEZONE` takes care of the device time.
3. **systemd** (`/etc/systemd/system/zk-bridge.service`):

   ```ini
   [Unit]
   Description=zk-bridge (ZKTeco K40 to CRM)
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=zkbridge
   WorkingDirectory=/opt/zk-bridge
   ExecStart=/usr/bin/node /opt/zk-bridge/dist/index.js
   Restart=always
   RestartSec=5
   KillSignal=SIGINT
   TimeoutStopSec=15

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo useradd --system --home /opt/zk-bridge zkbridge && sudo chown -R zkbridge /opt/zk-bridge
   sudo systemctl daemon-reload && sudo systemctl enable --now zk-bridge
   journalctl -u zk-bridge -f
   ```

4. **Or pm2:** `pm2 start dist/index.js --name zk-bridge --kill-timeout 10000 && pm2 save && pm2 startup`.

## Configuration reference

See `.env.example`. Real environment variables override `.env`. Relative paths are resolved from the project folder.

| Variable | Default | Meaning |
|---|---|---|
| `DEVICE_IP` | (required) | K40 address on the LAN |
| `DEVICE_PORT` | `4370` | K40 TCP port |
| `DEVICE_TIMEOUT_MS` | `10000` | Connect and request timeout for the device |
| `DEVICE_UDP_INPORT` | `5200` | Local UDP port, used only by the library's UDP fallback |
| `DEVICE_TIMEZONE` | `Asia/Dhaka` | IANA timezone of the K40 clock |
| `CRM_BASE_URL` | (required) | e.g. `https://crm.example.com/api`. `http://` only for localhost |
| `CRM_DEVICE_KEY` | (required) | Sent as `x-device-key` |
| `FULL_PULL_INTERVAL_SEC` | `600` | Full log download interval |
| `FLUSH_INTERVAL_SEC` | `15` | Send interval for queued punches |
| `HEARTBEAT_INTERVAL_SEC` | `60` | Heartbeat interval |
| `COMMAND_POLL_INTERVAL_SEC` | `20` | CRM command poll interval |
| `TIME_SYNC_INTERVAL_HOURS` | `24` | Device clock sync interval. `0` disables it |
| `OUTBOX_PATH` | `./data/outbox.db` | SQLite outbox file |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |

## CRM API contract

All requests send `x-device-key`, `content-type: application/json` and `user-agent: zk-bridge/<version>`.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/device-api/punches` | `{ punches: Punch[] }` (max 1000) | `{ accepted, duplicates }` |
| POST | `/device-api/heartbeat` | `{ deviceOnline, pendingPunches, bridgeVersion, stats }` | `{ ok: true }` |
| GET | `/device-api/commands` | | `{ commands: [{ id, type, payload }] }` |
| POST | `/device-api/commands/:id/ack` | `{ success, result?, error? }` | `{ ok: true }` |

`Punch` is `{ deviceUserId, punchedAt (UTC ISO), state, verifyType, source: 'realtime' | 'pull' }`. `state` (check-in/out…) and `verifyType` (finger, card…) come from both pulled logs and live punches; they are `null` only if the device didn't send them.

Commands and their payloads:

| Type | Payload | Result |
|---|---|---|
| `SET_USER` | `{ uid 1-3000, userId ≤9, name ≤24, password? ≤8, role? 0-14, cardno? 0-65535 }` | `{ uid, userId }` |
| `DELETE_USER` | `{ uid }` | `{ uid }` |
| `SYNC_TIME` | | `{ deviceTime }` |
| `PULL_ALL` | | `{ onDevice, newlyQueued }` |
| `GET_USERS` | | `{ users: [{ uid, userId, name, role, cardno }] }`. Passwords and fingerprints are never sent. |

A 4xx response (except 408 and 429) is treated as permanent and logged as an error. Everything else is retried on the next round.

## Development and testing

```bash
npm run typecheck   # strict TypeScript, src + test
npm test            # outbox, record normalization and errMsg tests (node:test)
npm run dev         # run from source with tsx
npm run poc         # device-only test
```

To test without the real CRM, use the mock server in `test/mock-crm.js`. It implements the four endpoints, logs every request and serves one `GET_USERS` command:

```bash
node test/mock-crm.js                                   # http://127.0.0.1:8787
npx tsx test/seed-outbox.ts ./data/test.db 3            # optional: queue 3 fake punches
DEVICE_IP=127.0.0.1 CRM_BASE_URL=http://127.0.0.1:8787/api CRM_DEVICE_KEY=test-key \
  OUTBOX_PATH=./data/test.db FLUSH_INTERVAL_SEC=3 npm run dev
```

The mock also reads `MOCK_PORT`, `MOCK_DEVICE_KEY`, `MOCK_FAIL_PUNCHES` (simulate an outage) and `MOCK_COMMANDS` (a JSON array of commands to serve once).

## Known limitations of zkteco-js 1.7.2

These come from the library. The bridge works around them where it can.

- **No Comm Key support.** The device must use Comm Key 0.
- **The library's live listener gets nothing from the K40.** `getRealTimeLogs` sends only `CMD_REG_EVENT`, but the K40 sends live punches only to a session that sent `CMD_ENABLEDEVICE` first (checked on a real K40). The bridge does live punches itself in `src/live-events.ts`: it sends `CMD_ENABLEDEVICE` then `CMD_REG_EVENT`, decodes the records (with state and verify type), and answers each with `ACK_OK` like pyzk. The live time matches the pulled log to the second, so the pulled copy is a duplicate.
- **The UDP fallback never triggers.** It is coded for `ECONNREFUSED`, but the error is already wrapped by then. The K40 speaks TCP, so this doesn't matter. Both record shapes are still handled.
- **A cut-short download can come back without an error.** A TCP log download that times out partway returns a partial list. The bridge compares the result with the device's log count, logs a warning, and the next pull fills the gap.
- **The library is chatty and sometimes leaves promises rejected with no handler.** Its console output goes to the log at `debug` level, and stray rejections are logged and ignored.
