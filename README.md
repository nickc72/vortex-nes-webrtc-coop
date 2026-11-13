# VORTEX-NES: 60FPS WebRTC Peer-to-Peer NES Emulator & Co-Op Platform

**Suggested GitHub Repository Name:** `vortex-nes-webrtc-coop`  
**Suggested Repository Description:** *A 60fps browser-based NES hardware emulator (6502 CPU / 2C02 PPU / 2A03 APU) with WebRTC peer-to-peer multiplayer, automatic ROM syncing, and direct RAM cheat injection for classic 2-player co-op games like Contra.*

---

## Overview

**VORTEX-NES** is a full-stack browser arcade workstation built for playing classic 2-player NES games (such as *Contra*, *Super C*, *Double Dragon II*, and *Life Force*) at a locked **60.0988 FPS (NTSC)** with a friend over the internet or LAN using **WebRTC `RTCDataChannel`** peer-to-peer networking.

To remain **100% copyright-clean**, the repository ships zero proprietary ROMs. Instead, it uses a **Bring-Your-Own-ROM (`.nes`)** architecture:
- When the Host (Player 1) drags and drops a `.nes` file into their browser, the emulator parses the 16-byte iNES header (`Mapper 002 UxROM`, `NROM`, `MMC1`, `CNROM`, `MMC3`), boots the 6502 CPU + 2C02 PPU + 2A03 stereo APU locally, and **automatically beams the `.nes` binary to Player 2** when they join the 6-character room code.

---

## Key Features

- **Real MOS 6502 + Ricoh 2C02/2A03 Hardware Emulation**:
  - Native `256×240` framebuffer with **3 Display Scaling Modes** (`16:9 Max Fill`, `4:3 CRT TV`, and `Pixel 16:15`), **Wide Cinema Mode**, and **100% Edge-to-Edge Fullscreen** (`Double-Click` screen or click `Max Fullscreen`).
  - Real-time 44.1 kHz stereo 2A03 APU chiptune synthesis via a low-latency WebAudio ring buffer.
  - Built-in bootable 40KB 6502 dual-controller test ROM on startup plus a built-in widescreen Run & Gun demo mode.
- **Zero-Lag WebRTC P2P Netplay + Automatic ROM Transfer**:
  - Uses an unordered, unreliable WebRTC `RTCDataChannel` (`{ ordered: false, maxRetransmits: 0 }`) with an 8-frame sliding input window so single dropped UDP packets never cause TCP head-of-line blocking.
  - Includes an automatic WebSocket frame relay fallback (`/ws-signaling`) when strict symmetric NATs block direct STUN UDP hole-punching.
  - One-click **Force Sync Exact NES State to Friend** snaps Player 2's 6502 RAM, PPU VRAM, and mapper banks to the exact same frame as Player 1 at any time.
  - **Live Co-Op Tactical Callouts & Quick-Chat** rendered as non-intrusive arcade banners inside the gameplay viewport.
- **Direct 6502 RAM Cheat Engine & Hardware Turbo Fire for *Contra (NES)***:
  - **Give 30 Lives (No Pause)**: Directly writes `29` reserve lives (`30` total lives) into NES Zero-Page RAM (`$0032` for Player 1 and `$0033` for Player 2) during active gameplay without pressing `START` or pausing the game.
  - **Infinite 30 Lives Lock**: Locks `$0032` and `$0033` at 30 lives on every 60Hz tick.
  - **Direct Weapon RAM Injector (`[S] Spread`, `[L] Laser`, `[M] Machine`, `[F] Flame`)**: Writes directly to `$00AA` (P1) and `$00AB` (P2) with the Rapid Fire bit (`0x10`) enabled.
  - **20Hz Hardware Turbo Fire**: Hold down Fire (`J` / `Z` / `F`) for automatic rapid-fire on any weapon.
  - **Quick Save / Load State & Disk `.SAV` Export/Import**: Download `.vortex.sav` state files to your computer and load/sync them with your friend anytime.

---

## System Requirements & Node.js Version

To avoid any `npm install` errors (`ERESOLVE` or `ETARGET`), make sure you are running a modern LTS version of **Node.js**:

| Tool | Required Version | Recommended Version |
| :--- | :--- | :--- |
| **Node.js** | `>= 20.19.0` | **`v22.14.0 LTS`** (or latest **Node 22 LTS**) |
| **npm** | `>= 10.0.0` | **`v10.9.0+`** (bundled with Node 22 LTS) |

### Installing the Correct Node.js Version

- **Using `nvm` (macOS / Linux / WSL) or `nvm-windows`:**
  This repository includes an `.nvmrc` file pinned to `22.14.0`. Simply run:
  ```bash
  nvm install 22.14.0
  nvm use 22.14.0
  ```
- **Direct Installer (Windows / macOS):**
  Download the **Node.js v22 LTS** installer from [https://nodejs.org/](https://nodejs.org/).
- Verify your installed versions before running `npm install`:
  ```bash
  node -v   # Should output v22.x.x (or >= v20.19.0)
  npm -v    # Should output 10.x.x
  ```

---

## Quick Start (Local Installation)

### 1. Clone & Install Dependencies
This project includes a pre-configured `.npmrc` (`legacy-peer-deps=true`) and public-registry compatible version ranges in `package.json` so `npm install` succeeds cleanly out of the box:

```bash
git clone https://github.com/<YOUR_GITHUB_USERNAME>/vortex-nes-webrtc-coop.git
cd vortex-nes-webrtc-coop
npm install
```

> **Troubleshooting `npm install`:**  
> If you have an older npm cache or strict peer-dependency settings globally, run:
> ```bash
> npm cache clean --force
> npm install --legacy-peer-deps
> ```

### 2. Start the Development Server
```bash
npm run dev
```
Open **`http://localhost:3000`** in Chrome, Edge, Brave, or Firefox, and drag-and-drop your `Contra.nes` file onto the screen!

---

## Playing Multiplayer Co-Op with a Friend

### Option A: Same Wi-Fi / Home LAN (`< 2ms` Latency)
The Express + WebSocket server binds to `0.0.0.0:3000`.
1. Find your computer's local IP address (`ipconfig` on Windows, `ifconfig` or `ip a` on macOS/Linux — e.g., `192.168.1.25`).
2. Have your friend open `http://192.168.1.25:3000` in their browser.
3. Upload `Contra.nes` on your machine, click **Create P2P Room**, and give your friend the 6-character room code. Your browser will automatically transfer the ROM to theirs!

### Option B: Over the Internet from Your Local Machine
Keep `npm run dev` running in your first terminal, and in a second terminal expose port `3000` using a free Cloudflare Tunnel:
```bash
npx cloudflared tunnel --url http://localhost:3000
```
Send your friend the generated `https://....trycloudflare.com` URL and your 6-character room code. Both WebSocket signaling and WebRTC peer-to-peer DataChannels work automatically through the tunnel.

---

## Controls

| Action | Controller 1 (Host / Solo / Online Peer) | Controller 2 (Local Shared Keyboard) | USB / Bluetooth Gamepad |
| :--- | :--- | :--- | :--- |
| **D-Pad (Move / 8-Way Aim)** | `W`, `A`, `S`, `D` (or `Arrow Keys` in Online mode) | `Arrow Keys` | Left Stick / D-Pad |
| **B Button (Turbo Fire / Shoot)** | `J` or `Z` or `F` (or `U`) | `N` or `,` (Comma) | Square / X / Right Trigger |
| **A Button (Jump)** | `K` or `X` or `Space` (or `I`) | `M` or `.` (Period) | Cross / A / B |
| **SELECT (1P / 2P Cursor)** | `Left Shift` / `Right Shift` | `[` | Select / Back |
| **START (Begin / Pause)** | `Enter` | `]` | Start / Options |

---

## Production Build

```bash
npm run build
npm start
```

---

## License

Apache-2.0
