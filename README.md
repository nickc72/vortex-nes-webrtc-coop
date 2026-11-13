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
  - Native `256×240` pixel-perfect integer canvas rendering with toggleable CRT scanlines and Fullscreen / Theater mode (`Double-Click` or `Fullscreen` button).
  - Real-time 44.1 kHz stereo 2A03 APU chiptune synthesis via a low-latency WebAudio ring buffer.
  - Built-in bootable 40KB 6502 dual-controller test ROM on startup plus a built-in widescreen Run & Gun demo mode.
- **Zero-Lag WebRTC P2P Netplay + Automatic ROM Transfer**:
  - Uses an unordered, unreliable WebRTC `RTCDataChannel` (`{ ordered: false, maxRetransmits: 0 }`) with an 8-frame sliding input window so single dropped UDP packets never cause TCP head-of-line blocking.
  - Includes an automatic WebSocket frame relay fallback (`/ws-signaling`) when strict symmetric NATs block direct STUN UDP hole-punching.
  - One-click **Force Sync Exact NES CPU/PPU State** snaps Player 2's 6502 RAM, PPU VRAM, and mapper banks to the exact same frame as Player 1 at any time.
- **Direct 6502 RAM Cheat Engine for *Contra (NES)***:
  - **Give 30 Lives (No Pause)**: Directly writes `29` reserve lives (`30` total lives) into NES Zero-Page RAM (`$0032` for Player 1 and `$0033` for Player 2) during active gameplay without pressing `START` or pausing the game.
  - **Infinite 30 Lives Lock**: Locks `$0032` and `$0033` at 30 lives on every 60Hz tick.
  - **Direct Weapon RAM Injector (`[S] Spread`, `[L] Laser`, `[M] Machine`, `[F] Flame`)**: Writes directly to `$00AA` (P1) and `$00AB` (P2) with the Rapid Fire bit (`0x10`) enabled.
  - **Quick Save & Load State**: Instant in-memory snapshots of the entire 6502 CPU, RAM, PPU, and Mapper state.

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                        VORTEX-NES BROWSER CLIENT (60 FPS)                    │
│                                                                              │
│  ┌─────────────────────────┐        ┌─────────────────────────────────────┐  │
│  │ Controller Poller (60Hz)│        │   WebRTC P2P Netplay Coordinator    │  │
│  │ • Keyboard (WASD/Arrows)│───────▶│ • 8-Frame Redundant Input Window    │  │
│  │ • HTML5 Gamepad API     │        │ • Auto .NES Binary ROM Sync (CRC32) │  │
│  │ • 8-Bit NES Pad Bitmask │        │ • Instant CPU/PPU Save-State Sync   │  │
│  └─────────────────────────┘        └──────────┬──────────────────┬───────┘  │
│                                                │                  │          │
│                                    Step(Frame) │                  │ Net I/O  │
│                                                ▼                  ▼          │
│  ┌─────────────────────────────────────────────────┐   ┌──────────────────┐  │
│  │       MOS 6502 + 2C02 PPU + 2A03 APU CORE       │   │ WebRTC Engine    │  │
│  │ • iNES Header Parser (UxROM Mapper 2, MMC1/3)   │   │ • RTCPeerConnect │  │
│  │ • 6502 RAM Cheat Injector ($0032/$0033/$00AA)   │   │ • Unordered UDP  │  │
│  │ • 256×240 BGR-to-RGBA Framebuffer & CRT Shader  │   │   RTCDataChannel │  │
│  │ • 44.1kHz Stereo Ring-Buffer WebAudio Output    │   └────────┬─────────┘  │
│  └─────────────────────────────────────────────────┘            │            │
└─────────────────────────────────────────────────────────────────┼────────────┘
                                                                  │
                        SDP / ICE Signaling & ROM Transfer        │ Direct P2P
                                    │                             │ UDP Frames
                                    ▼                             ▼
┌────────────────────────────────────────────────────┐   ┌─────────────────────┐
│     EXPRESS + WEBSOCKET SIGNALING SERVER (:3000)   │   │  REMOTE PEER CLIENT │
│  • 6-Character Room Creation & Public Lobby List   │◀─▶│  • Controller 2     │
│  • WebRTC SDP Offer/Answer & ICE Candidate Routing │   │  • Auto-Synced ROM  │
│  • Automatic Low-Latency WS Frame Relay Fallback   │   └─────────────────────┘
└────────────────────────────────────────────────────┘
```

---

## Controls

| Action | Controller 1 (Host / Solo / Online Peer) | Controller 2 (Local Shared Keyboard) | USB / Bluetooth Gamepad |
| :--- | :--- | :--- | :--- |
| **D-Pad (Move / 8-Way Aim)** | `W`, `A`, `S`, `D` (or `Arrow Keys` in Online mode) | `Arrow Keys` | Left Stick / D-Pad |
| **B Button (Fire / Shoot)** | `J` or `Z` or `F` | `N` or `,` (Comma) | Square / X / Right Trigger |
| **A Button (Jump)** | `K` or `X` or `Space` | `M` or `.` (Period) | Cross / A / B |
| **SELECT (1P / 2P Cursor)** | `Left Shift` / `Right Shift` | `[` | Select / Back |
| **START (Begin / Pause)** | `Enter` | `]` | Start / Options |

---

## Quick Start (Local Development)

### Prerequisites
- **Node.js 18+** and `npm`

### 1. Install Dependencies & Start the Server
```bash
npm install
npm run dev
```
Open **`http://localhost:3000`** in Chrome, Edge, Brave, or Firefox.

### 2. Playing with a Friend on Home Wi-Fi / LAN
The server listens on `0.0.0.0:3000`. Find your machine's LAN IP (`ipconfig` on Windows, `ifconfig` or `ip a` on macOS/Linux) and have your friend open:
```text
http://<YOUR_LAN_IP>:3000
```

### 3. Playing with a Friend Over the Internet from Localhost
While `npm run dev` is running on port `3000`, open a second terminal and start a free tunnel:
```bash
npx cloudflared tunnel --url http://localhost:3000
```
Share the generated `https://....trycloudflare.com` URL and your 6-character room code with your friend.

---

## Production Build

```bash
npm run build
npm start
```

---

## License

Apache-2.0
