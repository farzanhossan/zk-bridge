# Installing zk-bridge on the Windows laptop

This guide sets the bridge up **once**. After that it runs by itself: it starts when Windows starts (even if nobody logs in), it catches up after sleep or shutdown, and it restarts itself if it crashes.

This setup is for:
- the **K40 connected with a network cable** to the office router (or a switch behind it), and
- the **laptop connected over Wi-Fi** to that same router.

Plan for about 45 minutes. Do the steps in order. Each step says what you should see before you move on.

---

## What you need

- [ ] The office Windows 10 or 11 laptop, with an **administrator** account
- [ ] The **office Wi-Fi name and password**: the main network of the router the K40's cable goes to, **not a guest network**
- [ ] Internet on the laptop (to download Node.js and NSSM, and to reach the CRM)
- [ ] The **CRM address**, e.g. `https://crm.example.com/api`
- [ ] The **device key** for this bridge, from the CRM
- [ ] This project folder (see step 3)

### How to open PowerShell

- **Normal PowerShell:** press Start, type `PowerShell`, press Enter.
- **PowerShell as Administrator:** press Start, type `PowerShell`, right-click **Windows PowerShell**, then **Run as administrator**, and click **Yes**. The window title starts with "Administrator:".

To paste into PowerShell, right-click inside the window, or press Ctrl+V.

---

## Step 1: Set up the K40

1. Plug the K40's network cable into the office **router** (or a switch connected to it).
2. On the K40 menu (usually **Menu > Comm.** or **Comm. > Ethernet**; names vary by firmware):
   - **IP address:** set a fixed one, e.g. `192.168.1.201`. Use the same first three numbers as the office network. Also reserve this address in the router so nothing else takes it.
   - **Port:** `4370` (the default).
   - **Comm Key:** `0`. **This is required.** The bridge cannot connect if a Comm Key is set.
3. Write down the IP address. You need it in steps 2 and 6.

If another attendance program (ZKTime, ZKBioTime, …) is connected to the K40, close it. The K40 talks to one program at a time.

---

## Step 2: Connect the laptop to Wi-Fi and check it can reach the K40

### 2a. Join the right Wi-Fi

1. Click the Wi-Fi icon in the taskbar and pick the **main office Wi-Fi**: the one from the router the K40 is plugged into. **Not** the guest network, and not a phone hotspot.
2. Tick **Connect automatically**, then click **Connect** and enter the password.
3. Open **Settings > Network & internet > Wi-Fi**, click the network's name (or **Properties**) and check:
   - **Connect automatically when in range:** **On**. This is what makes the laptop rejoin Wi-Fi by itself after a restart, even before anyone logs in.
   - **Metered connection:** **Off**.
   - **Random hardware addresses:** **Off**, so the router always sees the same laptop.

> **If your Wi-Fi asks for a username and password** (company "enterprise" Wi-Fi, not just a Wi-Fi password), Windows may only connect **after someone logs in**. The bridge would then do nothing after a restart until somebody logs in. In that case, use a Wi-Fi network with a normal password for this laptop, or keep the laptop logged in.

### 2b. Check the laptop can reach the K40

In a normal PowerShell, using your K40's IP:

```powershell
ipconfig
Test-NetConnection 192.168.1.201 -Port 4370
```

**Check:**
- In the `ipconfig` output, under **Wireless LAN adapter Wi-Fi**, the **IPv4 Address** starts with the **same first three numbers** as the K40. For example, laptop `192.168.1.57` and K40 `192.168.1.201`.
- `Test-NetConnection` ends with **`TcpTestSucceeded : True`**. A "ping failed" warning above it doesn't matter; only `TcpTestSucceeded` counts.

If it says `False`:

| What you see | Cause | Fix |
|---|---|---|
| The laptop's first three numbers are different (e.g. `192.168.0.x` vs `192.168.1.x`) | The laptop is on a different network: guest Wi-Fi, another router, or a hotspot | Join the Wi-Fi of the router the K40 is plugged into. |
| Same first three numbers, still `False` | The router blocks Wi-Fi devices from talking to wired devices | In the router settings, turn **off** "AP isolation", "client isolation" or "wireless isolation" for the main Wi-Fi. |
| Same first three numbers, still `False` | Wrong K40 IP, the K40's cable is unplugged, or the K40 is off | Check the IP on the K40 screen and its cable. |

Don't continue until you see `TcpTestSucceeded : True`.

### 2c. Stop Windows from switching off the Wi-Fi card

Press Start, type `Device Manager`, open it. Expand **Network adapters** and double-click your Wi-Fi adapter (its name contains "Wi-Fi", "Wireless" or "WLAN", e.g. "Intel Wi-Fi 6 AX201"). On the **Power Management** tab, untick **Allow the computer to turn off this device to save power**, then click **OK**. If there is no Power Management tab, skip this.

---

## Step 3: Copy the project to the laptop

Put the folder at **`C:\zk-bridge`**.

> Don't put it on the Desktop, in Documents or Downloads, or anywhere under OneDrive. Those folders are often synced, which can damage the bridge's database, and the service runs as a system account rather than as you.

**On the Mac**, make a zip without the parts that are rebuilt on Windows:

```bash
cd ~/Desktop/Workspace/ZKTeco-bridge-agent
zip -r ~/Desktop/zk-bridge.zip . -x 'node_modules/*' 'dist/*' 'data/*' 'logs/*' '.env' '*.err.log'
```

**On the laptop:**

1. Copy `zk-bridge.zip` over (USB stick, shared drive, email…).
2. If it came from the internet or email: right-click the zip, choose **Properties**, tick **Unblock** if you see it, then click **OK**.
3. Right-click the zip, choose **Extract All…**, and extract to `C:\zk-bridge`.

**Check:** the file `C:\zk-bridge\package.json` exists. Make sure it isn't at `C:\zk-bridge\zk-bridge\package.json`. If it is, move the inner folder's contents up one level.

---

## Step 4: Install Node.js

1. Go to <https://nodejs.org> and download the **LTS** version, "Windows Installer (.msi)".
2. Run it and keep clicking **Next** with the default options.
3. **Close every PowerShell window**, then open a new normal PowerShell and run:

   ```powershell
   node --version
   ```

**Check:** it prints `v22.13.0` or higher (any `v22.x` from 22.13 up, or `v24.x` and newer). If it says `v22.12` or older, install the current LTS.

> Use the normal installer above, not `nvm` or a portable zip, so the Windows service can find Node.

---

## Step 5: Install the bridge's packages

In a normal PowerShell:

```powershell
cd C:\zk-bridge
npm install
```

**Check:** it ends with something like `added 34 packages` and `found 0 vulnerabilities`. Warnings are fine.

> If you get **"running scripts is disabled on this system"**, run this once, answer `Y`, then run `npm install` again:
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```

---

## Step 6: Fill in the settings (`.env`)

```powershell
copy .env.example .env
notepad .env
```

In Notepad, change these lines:

```ini
DEVICE_IP=192.168.1.201                    # the K40 IP from step 1
CRM_BASE_URL=https://crm.example.com/api   # the CRM address (must start with https://)
CRM_DEVICE_KEY=paste-the-device-key-here   # the device key from the CRM
DEVICE_TIMEZONE=Asia/Dhaka                 # the timezone the K40 clock is set to
```

Leave everything else as it is. Save (Ctrl+S) and close Notepad.

> `.env` holds the device key. Don't email it around or share it.

---

## Step 7: Test the connection to the K40

```powershell
npm run poc
```

**Check:**

- It shows **Device stats**, a **Users** table and a **Logs** table.
- **"device time (local)" matches the clock on the K40 screen.** If it's off by whole hours, `DEVICE_TIMEZONE` is wrong.
- The `local` column of the logs shows the times people actually punched.
- At the end it says `Listening for live punches…`. **Punch a finger on the K40.** Within a second or two you should see `LIVE punch: user 7 at 2026-11-25 09:01:02` (with your own user and time).

Press **Ctrl+C** to stop.

If it says `Device test failed`, read the message and the list of checks it prints, fix the problem, and run `npm run poc` again. The most common fixes:

| Message | Fix |
|---|---|
| `No answer from the device at … within 10 s` | The laptop can't reach the K40. Redo the check in step 2b. |
| `connect ECONNREFUSED …` | Wrong port, or wrong IP (something else is at that address). |
| `ACK_UNAUTH: a Comm Key is set` | Set Comm Key = 0 on the K40. |
| `ECONNRESET` | Another program is connected to the K40. Close it. |

---

## Step 8: Build and do a test run

```powershell
npm run build
npm start
```

**Check:** within about 30 seconds the log shows lines like these:

```
INFO  zk-bridge 1.0.0 starting ...
INFO  Pull: 1234 log(s) on the device, 1234 new
INFO  Sent 500 punch(es) to the CRM (accepted 500, duplicates 0)
INFO  Bridge running
INFO  Real-time listener connected to 192.168.1.201:4370
```

and after about one minute:

```
INFO  Status: OK - K40 reachable, live listener on, CRM OK (last sent 09:41), 0 waiting, today 37 punch(es), last punch user 7 at 09:40
```

Punch a finger. You should see `Live punch: …` followed by `Sent 1 punch(es) to the CRM`. Check in the CRM that the punches arrived with the right times.

Press **Ctrl+C**. It should end with `Stopped. 0 punch(es) still queued.`

| If you see | Fix |
|---|---|
| `Invalid configuration (check .env)` | It lists exactly what's wrong in `.env`. Fix it and run `npm start` again. |
| `HTTP 401` / `HTTP 403` … `check CRM_DEVICE_KEY` | Wrong device key, or the key isn't active in the CRM yet. |
| `fetch failed: getaddrinfo ENOTFOUND` | Wrong `CRM_BASE_URL`, or no internet. |

---

## Step 9: Install it as a Windows service

### 9a. Download NSSM

NSSM is a small free tool that runs the bridge as a Windows service.

1. Go to <https://nssm.cc/download> and download the latest zip. If the page offers a newer **pre-release** build (e.g. `2.24-101`), take that one; it fixes a start-up problem on recent Windows.
2. Right-click the zip, choose **Properties**, tick **Unblock**, then click **OK**.
3. Extract it, and copy the folder to `C:\tools\nssm` so that this file exists:
   **`C:\tools\nssm\win64\nssm.exe`**

### 9b. Install the service

Open **PowerShell as Administrator** (see "How to open PowerShell" above) and run:

```powershell
cd C:\zk-bridge
powershell -ExecutionPolicy Bypass -File .\scripts\install-service.ps1 -Nssm C:\tools\nssm\win64\nssm.exe
```

**Check:** it prints the project, Node and NSSM paths, then `Installing service 'ZKBridge'...`, then `SERVICE_RUNNING`, and finally a list of manage commands.

Wait a minute, then run:

```powershell
Get-Service ZKBridge
Get-Content C:\zk-bridge\logs\bridge.log | Select-String 'Status:' | Select-Object -Last 1
```

**Check:** `Status` is **Running**, and the last line says **`Status: OK`**.

> The service is set to **Automatic**: it starts with Windows, before anyone logs in. If it ever crashes, it restarts after 5 seconds. Its log is `C:\zk-bridge\logs\bridge.log` (a new file is started at 10 MB).

---

## Step 10: Laptop settings so it keeps running

The bridge recovers after sleep, but it can only see live punches while the laptop is awake and on Wi-Fi. Do these once.

**1. Never sleep, and closing the lid does nothing.** In **PowerShell as Administrator**:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-dc 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
```

The screen may still turn off; that's fine. (Lines with `-dc` apply on battery. Leave them out if you want the laptop to sleep on battery.)

**2. Wi-Fi at full power.** In the same Administrator PowerShell:

```powershell
powercfg /setacvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a 0
powercfg /setdcvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a 0
powercfg /setactive SCHEME_CURRENT
```

If these say "Invalid Parameters", do it by hand instead: Control Panel > **Power Options** > **Change plan settings** > **Change advanced power settings** > **Wireless Adapter Settings** > **Power Saving Mode** > **Maximum Performance**. If that option isn't listed, skip it.

**3. Good Wi-Fi signal.** Keep the laptop where Wi-Fi is strong (at least 3 bars), not in a closed metal cabinet or a far corner. Weak Wi-Fi doesn't lose punches, but live punches then arrive later.

**4. Windows Update restarts at night.** Go to **Settings > Windows Update > Advanced options > Active hours** and set them to cover office hours. The service comes back by itself after the update restart.

**5. Power cuts.** Put the **router** (the laptop needs it for Wi-Fi), any switch and the K40 on a UPS. The laptop has its own battery.

**6. Clock.** Keep **Settings > Time & language > Date & time > Set time automatically** turned on. The bridge copies the laptop's time to the K40 once a day.

---

## Step 11: Final check (do this once)

**Restart test**
1. Restart the laptop. Don't log in for two minutes.
2. Punch a finger on the K40.
3. Log in and run:
   ```powershell
   Get-Content C:\zk-bridge\logs\bridge.log -Tail 30
   ```
   You should see a new `zk-bridge 1.0.0 starting`, then `Bridge running` and a `Status: OK` with times from **before** you logged in, and your punch (`Live punch: …` or `Pull: … new`) sent to the CRM. If the log only starts at the moment you logged in, Wi-Fi isn't connecting before login; see the note in step 2a.

**Sleep test**
1. Start > Power > **Sleep**.
2. While it sleeps, punch a finger on the K40.
3. Wake the laptop and wait about one minute (Wi-Fi needs a moment to rejoin). Look at the log again. You should see `Resumed after ~X min`, then `Pull: … 1 new`, `Sent 1 punch(es) to the CRM` and a fresh `Status: OK`.

If both tests pass, you're done. You don't need to start anything by hand again.

---

## How to see that it's working

### The quick check: one command

```powershell
Get-Content C:\zk-bridge\logs\bridge.log | Select-String 'Status:' | Select-Object -Last 5
```

The bridge writes a **status line** about 1 minute after it starts, about 1 minute after the laptop wakes up, and then **every 15 minutes**.

**All good:**

```
2026-11-25T03:41:02.113Z INFO  Status: OK - K40 reachable, live listener on, CRM OK (last sent 09:41), 0 waiting, today 37 punch(es), last punch user 7 at 09:40
```

| Part | Meaning |
|---|---|
| `K40 reachable` | The laptop can talk to the K40 over Wi-Fi. |
| `live listener on` | Punches arrive within seconds. (`reconnecting` is normal for a few seconds after each 10-minute pull.) |
| `CRM OK (last sent 09:41)` | The CRM answers. The time is when punches were last delivered. |
| `0 waiting` | Punches stored on the laptop but not yet sent. It should be 0, or drop back to 0 within a minute. |
| `today 37 punch(es)` | Punches made today that the bridge has seen. Compare with the CRM. |
| `last punch user 7 at 09:40` | The most recent punch it has seen. |

Times in the status line are local time (`DEVICE_TIMEZONE`). The time at the start of each log line is UTC (the `Z` at the end means UTC). For Dhaka that's 6 hours behind.

**Something is wrong:**

```
2026-11-25T03:56:02.400Z WARN  Status: PROBLEM - K40 not reachable since 09:52; CRM OK (last sent 09:41), 3 waiting, today 37 punch(es), last punch user 7 at 09:40
```

The part after `PROBLEM -` says what's wrong:

| Problem | What to check |
|---|---|
| `K40 not reachable since …` | Is the laptop still on the office Wi-Fi (step 2b)? Is the K40 on, with its cable in? Punches are kept on the K40 and are collected when it's reachable again. |
| `CRM not answering since … (reason)` | Internet down, or a CRM problem. The reason in brackets says which; e.g. `HTTP 401` means a wrong device key. Punches wait on the laptop and are sent automatically later. |

**If the newest status line is older than 15 minutes** while the laptop is on, the service isn't running. Run `Get-Service ZKBridge` (and see Troubleshooting).

### Watching it live

```powershell
Get-Content C:\zk-bridge\logs\bridge.log -Tail 50 -Wait
```

Punch a finger and watch it appear. Press Ctrl+C to stop watching; the bridge keeps running.

| Line | Meaning |
|---|---|
| `Live punch: user 7 at …` then `Sent 1 punch(es) to the CRM` | A punch was received and delivered. |
| `Pull: 1250 log(s) on the device, 0 new` | The regular full check (every 10 min). `0 new` is normal: nothing was missed. |
| `Resumed after ~X min` | The laptop woke from sleep; the bridge is catching up. |
| `Device reachable again, pulling to catch up …` | The K40 or Wi-Fi was gone for a while and is back; missed punches are being collected. |
| `Real-time connection lost` / `Real-time connect … failed` (WARN) | Wi-Fi or the K40 dropped for a moment. Normal now and then, especially right after waking. It retries by itself. |
| `Could not send punches, N stay queued` (WARN) | Internet or the CRM is down. Punches are kept and resent. |
| `ERROR` lines | Need attention. The message says what to check. |

A few WARN lines right after a restart or wake are normal on Wi-Fi, while it rejoins the network. They should be followed by `Device reachable again` and a `Status: OK`.

---

## Everyday use

All of these need **PowerShell as Administrator**, except reading the log.

| I want to… | Command |
|---|---|
| Check it's working | `Get-Content C:\zk-bridge\logs\bridge.log \| Select-String 'Status:' \| Select-Object -Last 5` |
| See if the service is running | `Get-Service ZKBridge` |
| Watch the log live | `Get-Content C:\zk-bridge\logs\bridge.log -Tail 50 -Wait` (Ctrl+C to stop watching) |
| Restart it | `Restart-Service ZKBridge` |
| Stop / start it | `Stop-Service ZKBridge` / `Start-Service ZKBridge` |
| Change a setting | `notepad C:\zk-bridge\.env`, save, then `Restart-Service ZKBridge` |
| See more detail in the log | Set `LOG_LEVEL=debug` in `.env`, then restart. Set it back to `info` afterwards. |
| Run the device test again | `Stop-Service ZKBridge`, then `cd C:\zk-bridge`, `npm run poc`, Ctrl+C, then `Start-Service ZKBridge`. (The K40 talks to one program at a time, so stop the service first.) |

You can also manage it in the **Services** window: Start, type `services.msc`, find **ZK Bridge (ZKTeco K40 to CRM)**.

### Updating to a new version

```powershell
Stop-Service ZKBridge
```

Copy the new project files over `C:\zk-bridge`. **Keep** `.env`, the `data` folder (queued punches) and the `logs` folder. Then:

```powershell
cd C:\zk-bridge
npm install
npm run build
Start-Service ZKBridge
```

If the update changed how the service is installed, run the step 9b command again instead of `Start-Service`. It replaces the old service.

### Uninstalling

```powershell
C:\tools\nssm\win64\nssm.exe stop ZKBridge
C:\tools\nssm\win64\nssm.exe remove ZKBridge confirm
```

Then you can delete `C:\zk-bridge`. Before deleting, check the log says `0 punch(es) still queued`. Even if it doesn't, the punches are still on the K40, and a new install collects them again.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| `Status: PROBLEM - K40 not reachable` | Run the check in step 2b. Usually the laptop has joined another Wi-Fi network (guest or hotspot), or the K40 is off or unplugged. |
| `Real-time connection lost` many times an hour | Weak Wi-Fi or Wi-Fi power saving. Move the laptop closer to the router and redo steps 2c and 10.2. Punches aren't lost; they arrive with the 10-minute check. To shorten that wait, set `FULL_PULL_INTERVAL_SEC=120` in `.env` and restart. |
| Nothing happens after a restart until someone logs in | Wi-Fi only connects after login (enterprise Wi-Fi, or "Connect automatically" is off). See step 2a. |
| The laptop's IP address changes | That's fine. Only the K40 needs a fixed IP. |
| `'node' is not recognized` | Close PowerShell and open a new one. If it still fails, reinstall Node.js (step 4). |
| `No such built-in module: node:sqlite` | Node is too old. Install the current LTS (step 4), then `npm run build` and `Restart-Service ZKBridge`. |
| `running scripts is disabled on this system` | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, answer `Y`. |
| Install script says `Run this script from an elevated PowerShell` | Open PowerShell **as Administrator** (title starts with "Administrator:"). |
| Install script says `nssm not found` | Check the file `C:\tools\nssm\win64\nssm.exe` exists and the `-Nssm` path in the command matches. |
| Install script says `dist\index.js not found` or `.env not found` | Do steps 6 and 8 first. |
| Service keeps stopping or restarting | Look at the last lines of `C:\zk-bridge\logs\bridge.log`. Usually it's `Invalid configuration`, which lists what to fix in `.env`. |
| `database is locked` | Two copies are running, e.g. `npm start` while the service runs. Close the `npm start` window. |
| Times in the CRM are off by whole hours | `DEVICE_TIMEZONE` in `.env` is wrong. Fix it and restart. |
| Files like `25112026.err.log` in `C:\zk-bridge` | Written by the device library itself. Harmless; you can delete them. |

More details, including how the bridge works and the full settings list, are in [README.md](README.md).
