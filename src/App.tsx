import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Copy,
  Check,
  Volume2,
  VolumeX,
  RotateCcw,
  Play,
  Pause,
  Users,
  Disc,
  Radio,
  Upload,
  Zap,
  RefreshCw,
  Save,
  FolderOpen,
  Gamepad2,
  Maximize2,
  Minimize2,
  ShieldCheck,
  Terminal,
  PanelRightClose,
  PanelRightOpen,
  Download,
  Flame,
  MessageSquare,
} from 'lucide-react';
import {
  ContraWeaponCode,
  InesRomMetadata,
  NES_BTN_A,
  NES_BTN_B,
  NES_BTN_DOWN,
  NES_BTN_LEFT,
  NES_BTN_RIGHT,
  NES_BTN_SELECT,
  NES_BTN_START,
  NES_BTN_UP,
  NES_HEIGHT,
  NES_WIDTH,
} from './engine/nesCore';
import {
  ChatMessageItem,
  NesNetplayTelemetry,
  NesWebRtcCoordinator,
} from './engine/nesNetplay';
import { buildBootable6502NesRomBytes } from './engine/homebrewNesRom';
import { BUILTIN_CARTRIDGES } from './engine/cartridges';
import {
  INPUT_DOWN,
  INPUT_FIRE,
  INPUT_JUMP,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_UP,
  INPUT_WEAPON_SWAP,
} from './engine/types';
import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from './engine/vm';
import { renderVortexFrame } from './engine/renderer';
import { RollbackNetcodeEngine } from './engine/rollbackNetcode';

interface PublicRoomInfo {
  code: string;
  romName: string;
  romCrc32: string;
  players: number;
  createdAt: number;
}

type ScreenScaleMode = 'FULL_STRETCH' | 'CRT_4_3' | 'PIXEL_NATIVE';

export default function App() {
  const viewportContainerRef = useRef<HTMLDivElement | null>(null);
  const nesCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const demoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const savInputRef = useRef<HTMLInputElement | null>(null);

  const nesCoordinatorRef = useRef<NesWebRtcCoordinator | null>(null);
  const demoEngineRef = useRef<RollbackNetcodeEngine | null>(null);

  const keysPressedRef = useRef<Set<string>>(new Set());
  const virtualNesMaskRef = useRef<number>(0);
  const turboTickRef = useRef<number>(0);

  const [coreMode, setCoreMode] = useState<'NES_ROM' | 'BUILTIN_DEMO'>('NES_ROM');
  const [romMeta, setRomMeta] = useState<InesRomMetadata | null>(null);
  const [romError, setRomError] = useState<string | null>(null);
  const [statusToast, setStatusToast] = useState<string>(
    'Ready! Upload your Contra.nes (or any .nes ROM) to play solo or 2-Player WebRTC Co-Op.'
  );
  const [isDraggingRom, setIsDraggingRom] = useState<boolean>(false);

  // Screen Size, Aspect Scaling, Fullscreen & Cinema Controls
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [cinemaWideMode, setCinemaWideMode] = useState<boolean>(false);
  const [scaleMode, setScaleMode] = useState<ScreenScaleMode>('FULL_STRETCH');

  // Hardware Cheats & Turbo Fire
  const [lock30Lives, setLock30Lives] = useState<boolean>(false);
  const [turboFireEnabled, setTurboFireEnabled] = useState<boolean>(true);
  const [speedMultiplier, setSpeedMultiplier] = useState<1 | 2>(1);
  const [paused, setPaused] = useState<boolean>(false);
  const [muted, setMuted] = useState<boolean>(false);
  const [crtEnabled, setCrtEnabled] = useState<boolean>(true);
  const [rightTab, setRightTab] = useState<'ROM_LOADER' | 'NETPLAY' | 'CONTROLS'>('ROM_LOADER');

  // Save State slot in memory
  const [savedNesState, setSavedNesState] = useState<Record<string, unknown> | null>(null);

  // WebRTC Lobby & Tactical Chat State
  const [joinCodeInput, setJoinCodeInput] = useState<string>('');
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [publicRooms, setPublicRooms] = useState<PublicRoomInfo[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessageItem[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [liveBannerCallout, setLiveBannerCallout] = useState<ChatMessageItem | null>(null);

  const [telemetry, setTelemetry] = useState<NesNetplayTelemetry>({
    engineMode: 'NES_HARDWARE',
    netMode: 'SOLO_2P_LOCAL',
    connectionState: 'DISCONNECTED',
    roomCode: null,
    localPlayerIndex: 0,
    peerConnected: false,
    fps: 60,
    frameTimeMs: 0.8,
    pingRttMs: 0,
    frameAdvantage: 0,
    packetsSent: 0,
    packetsReceived: 0,
    romSyncedWithPeer: false,
  });

  // Poll Keyboard & HTML5 Gamepad into 8-bit NES Controller 1 and Controller 2 bitmasks
  const pollNesControllers = useCallback((): [number, number] => {
    turboTickRef.current = (turboTickRef.current + 1) % 60;
    // 20Hz pulse (on for 2 frames, off for 1 frame) so NES Contra registers maximum rapid-fire shots
    const turboPulse = turboTickRef.current % 3 !== 0;

    const keys = keysPressedRef.current;
    let p1 = virtualNesMaskRef.current;
    let p2 = 0;

    if (keys.has('KeyW')) p1 |= NES_BTN_UP;
    if (keys.has('KeyS')) p1 |= NES_BTN_DOWN;
    if (keys.has('KeyA')) p1 |= NES_BTN_LEFT;
    if (keys.has('KeyD')) p1 |= NES_BTN_RIGHT;

    // B Button (Fire): J / Z / F (uses Turbo pulse if turboFireEnabled is ON, or dedicated KeyU for Turbo B)
    const holdFireP1 = keys.has('KeyJ') || keys.has('KeyZ') || keys.has('KeyF');
    if (holdFireP1) {
      if (!turboFireEnabled || turboPulse) {
        p1 |= NES_BTN_B;
      }
    }
    if (keys.has('KeyU') && turboPulse) {
      p1 |= NES_BTN_B;
    }

    // A Button (Jump): K / X / Space (or KeyI for Turbo Jump)
    if (keys.has('KeyK') || keys.has('KeyX') || keys.has('Space')) p1 |= NES_BTN_A;
    if (keys.has('KeyI') && turboPulse) p1 |= NES_BTN_A;

    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) {
      p1 |= NES_BTN_SELECT;
    }
    if (keys.has('Enter')) p1 |= NES_BTN_START;

    // When playing Online WebRTC P2P, also let Arrow keys control the local player
    const isOnline = nesCoordinatorRef.current?.telemetry.netMode === 'WEBRTC_P2P';
    if (isOnline) {
      if (keys.has('ArrowUp')) p1 |= NES_BTN_UP;
      if (keys.has('ArrowDown')) p1 |= NES_BTN_DOWN;
      if (keys.has('ArrowLeft')) p1 |= NES_BTN_LEFT;
      if (keys.has('ArrowRight')) p1 |= NES_BTN_RIGHT;
    } else {
      // In Local 2P mode, Arrow keys + N/M + [ / ] control NES Controller 2!
      if (keys.has('ArrowUp')) p2 |= NES_BTN_UP;
      if (keys.has('ArrowDown')) p2 |= NES_BTN_DOWN;
      if (keys.has('ArrowLeft')) p2 |= NES_BTN_LEFT;
      if (keys.has('ArrowRight')) p2 |= NES_BTN_RIGHT;
      if (keys.has('KeyN') || keys.has('Comma') || keys.has('Numpad1')) {
        if (!turboFireEnabled || turboPulse) {
          p2 |= NES_BTN_B;
        }
      }
      if (keys.has('KeyM') || keys.has('Period') || keys.has('Numpad2')) p2 |= NES_BTN_A;
      if (keys.has('BracketLeft')) p2 |= NES_BTN_SELECT;
      if (keys.has('BracketRight')) p2 |= NES_BTN_START;
    }

    // Poll Physical USB / Bluetooth Gamepads via HTML5 Gamepad API
    if (typeof navigator !== 'undefined' && navigator.getGamepads) {
      const pads = navigator.getGamepads();
      const mapGamepadToNes = (pad: Gamepad | null): number => {
        if (!pad) return 0;
        let m = 0;
        const axX = pad.axes[0] ?? 0;
        const axY = pad.axes[1] ?? 0;
        if (axY < -0.4 || pad.buttons[12]?.pressed) m |= NES_BTN_UP;
        if (axY > 0.4 || pad.buttons[13]?.pressed) m |= NES_BTN_DOWN;
        if (axX < -0.4 || pad.buttons[14]?.pressed) m |= NES_BTN_LEFT;
        if (axX > 0.4 || pad.buttons[15]?.pressed) m |= NES_BTN_RIGHT;
        if (pad.buttons[0]?.pressed || pad.buttons[1]?.pressed) m |= NES_BTN_A;
        if (pad.buttons[2]?.pressed || pad.buttons[3]?.pressed || pad.buttons[7]?.pressed) {
          if (!turboFireEnabled || turboPulse) {
            m |= NES_BTN_B;
          }
        }
        if (pad.buttons[8]?.pressed) m |= NES_BTN_SELECT;
        if (pad.buttons[9]?.pressed) m |= NES_BTN_START;
        return m;
      };
      p1 |= mapGamepadToNes(pads[0] ?? null);
      p2 |= mapGamepadToNes(pads[1] ?? null);
    }

    return [p1, p2];
  }, [turboFireEnabled]);

  // Toggle Fullscreen (Works both via Native Fullscreen API and Edge-to-Edge CSS Fullscreen inside iframes)
  const toggleFullscreen = useCallback(async () => {
    const nextState = !isFullscreen;
    setIsFullscreen(nextState);

    try {
      if (nextState && viewportContainerRef.current && document.fullscreenEnabled) {
        if (!document.fullscreenElement) {
          await viewportContainerRef.current.requestFullscreen();
        }
      } else if (!nextState && document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {
      // Fallback to Edge-to-Edge CSS Full-Window mode automatically
    }
  }, [isFullscreen]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [isFullscreen]);

  // Initialize Real NES Coordinator + Bootable 6502 Test ROM + Built-in Fallback Demo Engine
  useEffect(() => {
    const coordinator = new NesWebRtcCoordinator({
      onTelemetryChange: (t) => {
        setTelemetry((prev) => ({ ...t, fps: prev.fps }));
      },
      onRomLoadedFromPeer: (meta) => {
        setRomMeta(meta);
        setCoreMode('NES_ROM');
        setRomError(null);
      },
      onStatusToast: (msg) => {
        setStatusToast(msg);
      },
      onChatReceived: (item) => {
        setChatMessages((prev) => [...prev.slice(-24), item]);
        setLiveBannerCallout(item);
        setTimeout(() => {
          setLiveBannerCallout((curr) => (curr?.id === item.id ? null : curr));
        }, 4000);
      },
    });
    nesCoordinatorRef.current = coordinator;

    try {
      const bootRomBytes = buildBootable6502NesRomBytes();
      const meta = coordinator.loadUserNesRom(
        bootRomBytes,
        'VORTEX_6502_TEST_DUAL_PAD.nes',
        false
      );
      setRomMeta(meta);
    } catch (err) {
      console.error('Boot ROM init error:', err);
    }

    demoEngineRef.current = new RollbackNetcodeEngine(BUILTIN_CARTRIDGES[0]);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        setIsFullscreen(false);
        return;
      }

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }

      if (
        [
          'Space',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Tab',
        ].includes(e.code)
      ) {
        e.preventDefault();
      }
      keysPressedRef.current.add(e.code);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysPressedRef.current.delete(e.code);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      coordinator.disconnectRoom();
    };
  }, []);

  // 60Hz Fixed-Timestep Emulator Loop (Supports 1x Normal 60fps & 2x Fast-Forward)
  useEffect(() => {
    let animId = 0;
    let lastTime = performance.now();
    let accumulator = 0;
    const STEP_MS = 1000 / (60.0988 * speedMultiplier);
    let framesRendered = 0;
    let fpsTimer = performance.now();

    const loop = (now: number) => {
      const delta = Math.min(100, now - lastTime);
      lastTime = now;

      if (!paused) {
        accumulator += delta;
        let subSteps = 0;
        const maxSteps = speedMultiplier === 2 ? 6 : 3;
        while (accumulator >= STEP_MS && subSteps < maxSteps) {
          if (coreMode === 'NES_ROM' && nesCoordinatorRef.current) {
            const [p1, p2] = pollNesControllers();
            nesCoordinatorRef.current.tickNesFrame(p1, p2);
          } else if (coreMode === 'BUILTIN_DEMO' && demoEngineRef.current) {
            const [nesP1, nesP2] = pollNesControllers();
            const mapNesToDemo = (m: number): number => {
              let out = 0;
              if (m & NES_BTN_UP) out |= INPUT_UP;
              if (m & NES_BTN_DOWN) out |= INPUT_DOWN;
              if (m & NES_BTN_LEFT) out |= INPUT_LEFT;
              if (m & NES_BTN_RIGHT) out |= INPUT_RIGHT;
              if (m & NES_BTN_A) out |= INPUT_JUMP;
              if (m & NES_BTN_B) out |= INPUT_FIRE;
              if (m & NES_BTN_SELECT) out |= INPUT_WEAPON_SWAP;
              return out;
            };
            demoEngineRef.current.tickFrame(mapNesToDemo(nesP1), mapNesToDemo(nesP2));
          }
          accumulator -= STEP_MS;
          subSteps += 1;
        }
      }

      if (coreMode === 'NES_ROM' && nesCanvasRef.current && nesCoordinatorRef.current) {
        const ctx = nesCanvasRef.current.getContext('2d');
        if (ctx) {
          nesCoordinatorRef.current.nesCore.renderToCanvas(ctx);
        }
      } else if (coreMode === 'BUILTIN_DEMO' && demoCanvasRef.current && demoEngineRef.current) {
        const ctx = demoCanvasRef.current.getContext('2d');
        if (ctx) {
          renderVortexFrame(
            ctx,
            demoEngineRef.current.getState(),
            demoEngineRef.current.getCartridge(),
            { showHitboxes: false }
          );
        }
      }

      framesRendered += 1;
      if (now - fpsTimer >= 1000) {
        const currentFps = Math.min(60, Math.round((framesRendered * 1000) / (now - fpsTimer)));
        setTelemetry((prev) => ({ ...prev, fps: currentFps }));
        framesRendered = 0;
        fpsTimer = now;
      }

      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [paused, coreMode, speedMultiplier, pollNesControllers]);

  // Poll open rooms list
  const refreshRooms = useCallback(async () => {
    try {
      const res = await fetch('/api/rooms');
      if (res.ok) {
        const data = await res.json();
        setPublicRooms(data.rooms || []);
      }
    } catch {
      // Ignore transient poll errors
    }
  }, []);

  useEffect(() => {
    refreshRooms();
    const timer = setInterval(refreshRooms, 3500);
    return () => clearInterval(timer);
  }, [refreshRooms]);

  // Process uploaded or dropped .nes file
  const processNesFile = async (file: File) => {
    setRomError(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      if (!nesCoordinatorRef.current) return;

      const meta = nesCoordinatorRef.current.loadUserNesRom(bytes, file.name, true);
      setRomMeta(meta);
      setCoreMode('NES_ROM');
      setPaused(false);
      setStatusToast(
        `Loaded "${meta.fileName}" (${meta.mapperName}). Press Enter (Start) to begin, then click "Give 30 Lives" anytime!`
      );
    } catch (err) {
      setRomError(
        err instanceof Error
          ? err.message
          : 'Failed to load .nes ROM. Make sure it is an uncompressed iNES (.nes) file.'
      );
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      processNesFile(file);
    }
  };

  const handleDropRom = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingRom(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processNesFile(file);
    }
  };

  const handleGive30Lives = (toggleLock: boolean) => {
    if (!nesCoordinatorRef.current) return;
    nesCoordinatorRef.current.nesCore.audio.start();
    nesCoordinatorRef.current.nesCore.activate30LivesCheat(toggleLock);
    setLock30Lives(nesCoordinatorRef.current.nesCore.lock30Lives);

    if (nesCoordinatorRef.current.telemetry.peerConnected) {
      nesCoordinatorRef.current.syncExactSaveStateToPeer();
    }

    setStatusToast(
      toggleLock
        ? `Infinite 30-Lives RAM Lock ${
            nesCoordinatorRef.current.nesCore.lock30Lives ? 'ENABLED' : 'DISABLED'
          } ($0032 & $0033 = 30 Lives for P1 & P2, no Start pause!).`
        : 'Injected 30 Lives directly into NES RAM ($0032 & $0033) for both Player 1 & Player 2 without pausing!'
    );
  };

  const handleInjectContraWeapon = (weapon: ContraWeaponCode) => {
    if (coreMode === 'NES_ROM' && nesCoordinatorRef.current) {
      nesCoordinatorRef.current.nesCore.injectContraWeapon(weapon);
      if (nesCoordinatorRef.current.telemetry.peerConnected) {
        nesCoordinatorRef.current.syncExactSaveStateToPeer();
      }
      setStatusToast(
        `Injected Weapon [${weapon}] + Rapid Fire directly into NES RAM ($00AA / $00AB) for P1 & P2!`
      );
    } else if (demoEngineRef.current) {
      const mapDemo = {
        S: 'SPREAD',
        L: 'LASER',
        M: 'RAPID',
        F: 'CRUSH',
        R: 'RAPID',
      } as const;
      const st = demoEngineRef.current.getState();
      st.players[0].weapon = mapDemo[weapon];
      st.players[1].weapon = mapDemo[weapon];
    }
  };

  const handleQuickSave = () => {
    if (!nesCoordinatorRef.current) return;
    const snap = nesCoordinatorRef.current.nesCore.saveStateSnapshot();
    if (snap) {
      setSavedNesState(snap);
      setStatusToast(
        `Saved 6502 CPU + PPU state at Frame #${nesCoordinatorRef.current.nesCore.frameCounter}.`
      );
    }
  };

  const handleQuickLoad = () => {
    if (!nesCoordinatorRef.current || !savedNesState) return;
    nesCoordinatorRef.current.nesCore.loadStateSnapshot(savedNesState);
    setStatusToast('Restored saved NES state!');
  };

  const handleExportSaveFile = () => {
    if (!nesCoordinatorRef.current) return;
    const snap = nesCoordinatorRef.current.nesCore.saveStateSnapshot();
    if (!snap) return;
    const blob = new Blob([JSON.stringify(snap)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${romMeta?.fileName || 'contra'}.vortex.sav`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusToast('Exported .vortex.sav save-state file to your computer!');
  };

  const handleImportSaveFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !nesCoordinatorRef.current) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      nesCoordinatorRef.current.nesCore.loadStateSnapshot(parsed);
      setSavedNesState(parsed);
      if (nesCoordinatorRef.current.telemetry.peerConnected) {
        nesCoordinatorRef.current.syncExactSaveStateToPeer();
      }
      setStatusToast(`Loaded save file "${file.name}" and synced state!`);
    } catch {
      setRomError('Invalid .sav file format.');
    }
  };

  const handleToggleMute = () => {
    const nextMuted = !muted;
    if (nesCoordinatorRef.current) {
      nesCoordinatorRef.current.nesCore.audio.muted = nextMuted;
    }
    setMuted(nextMuted);
  };

  const handleResetConsole = () => {
    if (coreMode === 'NES_ROM' && nesCoordinatorRef.current) {
      nesCoordinatorRef.current.nesCore.resetConsole();
      setPaused(false);
      setStatusToast('Cleanly rebooted .NES ROM cartridge from PRG bank 0.');
    } else if (demoEngineRef.current) {
      demoEngineRef.current.resetSession();
      setPaused(false);
    }
  };

  const handleHostRoom = () => {
    setRightTab('NETPLAY');
    setCinemaWideMode(false);
    nesCoordinatorRef.current?.connectRoom('CREATE');
  };

  const handleJoinRoom = (codeOverride?: string) => {
    const code = (codeOverride ?? joinCodeInput).trim().toUpperCase();
    if (!code) return;
    nesCoordinatorRef.current?.connectRoom('JOIN', code);
  };

  const handleCopyCode = () => {
    if (!telemetry.roomCode) return;
    navigator.clipboard.writeText(telemetry.roomCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleSendCallout = (text: string) => {
    if (!text.trim()) return;
    nesCoordinatorRef.current?.sendChatOrCallout(text.trim());
    setChatInput('');
  };

  const pulseVirtualButton = (bit: number, holdMs = 120) => {
    nesCoordinatorRef.current?.nesCore.audio.start();
    virtualNesMaskRef.current |= bit;
    setTimeout(() => {
      virtualNesMaskRef.current &= ~bit;
    }, holdMs);
  };

  const setVirtualBit = (bit: number, down: boolean) => {
    nesCoordinatorRef.current?.nesCore.audio.start();
    if (down) {
      virtualNesMaskRef.current |= bit;
    } else {
      virtualNesMaskRef.current &= ~bit;
    }
  };

  // Compute CSS classes for the <canvas> based on chosen ScreenScaleMode
  const getNesCanvasScaleClass = () => {
    if (scaleMode === 'FULL_STRETCH') {
      return 'w-full h-full object-fill';
    }
    if (scaleMode === 'CRT_4_3') {
      return 'h-full w-auto aspect-[4/3] max-w-full object-fill';
    }
    return 'h-full w-auto aspect-[16/15] max-w-full object-contain';
  };

  return (
    <div className="min-h-screen bg-[#0B0F17] text-[#F1F5F9] font-sans flex flex-col">
      {/* Hidden File Inputs for .nes ROM & .sav Save State */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".nes,application/octet-stream"
        onChange={handleFileInputChange}
        className="hidden"
      />
      <input
        ref={savInputRef}
        type="file"
        accept=".sav,.json"
        onChange={handleImportSaveFile}
        className="hidden"
      />

      {/* Strict 3-Zone Top Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 border-b border-[#263248] bg-[#0B0F17]/95 sticky top-0 z-30">
        {/* Zone 1: Brand Wordmark */}
        <a
          href="#emulator-deck"
          className="text-2xl font-bold tracking-wider font-display text-[#F1F5F9] whitespace-nowrap shrink-0"
        >
          VORTEX-NES
        </a>

        {/* Zone 2: 4 Single-Line Navigation Links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-[#94A3B8]">
          <a
            href="#emulator-deck"
            onClick={() => {
              setCinemaWideMode(false);
              setRightTab('ROM_LOADER');
            }}
            className="hover:text-[#F1F5F9] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Upload .NES ROM
          </a>
          <a
            href="#emulator-deck"
            onClick={() => {
              setCinemaWideMode(false);
              setRightTab('NETPLAY');
            }}
            className="hover:text-[#F1F5F9] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            WebRTC Co-Op Lobby
          </a>
          <a
            href="#emulator-deck"
            onClick={() => {
              setCinemaWideMode(false);
              setRightTab('CONTROLS');
            }}
            className="hover:text-[#F1F5F9] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Controller Mapping
          </a>
          <a
            href="#local-setup"
            className="hover:text-[#F1F5F9] hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Local Download Guide
          </a>
        </nav>

        {/* Zone 3: 1 Primary Action Button */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 text-xs font-semibold text-[#0B0F17] bg-[#F59E0B] rounded-lg hover:bg-[#FBBF24] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Upload .NES ROM File
          </button>
        </div>
      </header>

      {/* Main 1440px Workstation Container */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-5 space-y-6">
        {/* Top Banner: Prominent Drag-and-Drop .NES Loader + Non-Pausing 30-Lives & Fullscreen Controls */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDraggingRom(true);
          }}
          onDragLeave={() => setIsDraggingRom(false)}
          onDrop={handleDropRom}
          className={`rounded-xl border-2 border-dashed p-4 transition-colors flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
            isDraggingRom
              ? 'border-[#F59E0B] bg-[#F59E0B]/10'
              : 'border-[#263248] bg-[#151C28]'
          }`}
        >
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#94A3B8]">
              <span>REAL 6502 CPU + 2C02 PPU + 2A03 APU</span>
              <span aria-hidden="true">·</span>
              <span>TURBO AUTO-FIRE: {turboFireEnabled ? 'ACTIVE' : 'OFF'}</span>
              <span aria-hidden="true">·</span>
              <span>AUTO P2P ROM TRANSFER</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-bold font-display tracking-wide text-[#F1F5F9]">
              {romMeta
                ? `ACTIVE CARTRIDGE: ${romMeta.fileName}`
                : 'DROP YOUR CONTRA.NES OR ANY .NES ROM FILE HERE'}
            </h1>
            <p className="text-xs text-[#94A3B8]">{statusToast}</p>
            {romError && (
              <p className="text-xs font-mono text-[#F43F5E] mt-1">{romError}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold bg-[#F59E0B] text-[#0B0F17] hover:bg-[#FBBF24] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              Select .NES ROM
            </button>

            <button
              onClick={() => handleGive30Lives(false)}
              className="flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-mono font-semibold bg-[#1E293B] border border-[#38BDF8] text-[#38BDF8] hover:bg-[#38BDF8]/15 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Directly writes 30 Lives into NES RAM ($0032 & $0033) without pressing Start or pausing the game!"
            >
              <Zap className="w-3.5 h-3.5" />
              Give 30 Lives (No Pause)
            </button>

            <button
              onClick={() => handleGive30Lives(true)}
              className={`flex items-center gap-1.5 px-3.5 py-2.5 text-xs font-mono font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                lock30Lives
                  ? 'bg-[#10B981] text-[#0B0F17]'
                  : 'bg-[#1E293B] border border-[#10B981]/50 text-[#10B981] hover:bg-[#10B981]/15'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              Infinite 30 Lives: {lock30Lives ? 'ON' : 'OFF'}
            </button>

            <button
              onClick={toggleFullscreen}
              className="flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold bg-[#38BDF8] text-[#0B0F17] hover:bg-[#7DD3FC] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
              Max Fullscreen
            </button>
          </div>
        </div>

        {/* Main Split: 12-Col Full Cinema Width OR 8-Col + 4-Col Split */}
        <section
          id="emulator-deck"
          className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch"
        >
          {/* Gameplay Deck Container (In Fullscreen Mode: fixed inset-0 z-50 w-screen h-screen edge-to-edge!) */}
          <div
            ref={viewportContainerRef}
            className={
              isFullscreen
                ? 'fixed inset-0 z-50 bg-black flex flex-col justify-between overflow-hidden'
                : `${
                    cinemaWideMode ? 'lg:col-span-12' : 'lg:col-span-8'
                  } flex flex-col justify-between bg-[#151C28] border border-[#263248] rounded-xl p-4 space-y-3`
            }
          >
            {/* Top Bar Above Screen (Hidden in Fullscreen in favor of a sleek floating overlay so canvas gets 100% height!) */}
            {!isFullscreen && (
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[#263248]">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Core Switcher */}
                  <div className="flex items-center gap-1 p-1 bg-[#0B0F17] rounded-lg border border-[#263248]">
                    <button
                      onClick={() => setCoreMode('NES_ROM')}
                      className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        coreMode === 'NES_ROM'
                          ? 'bg-[#F59E0B] text-[#0B0F17]'
                          : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                      }`}
                    >
                      Real .NES Core
                    </button>
                    <button
                      onClick={() => setCoreMode('BUILTIN_DEMO')}
                      className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        coreMode === 'BUILTIN_DEMO'
                          ? 'bg-[#38BDF8] text-[#0B0F17]'
                          : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                      }`}
                    >
                      Built-In Demo
                    </button>
                  </div>

                  {/* Screen Aspect / Scaling Selector to make gameplay as huge as desired */}
                  <div className="flex items-center gap-1 p-1 bg-[#0B0F17] rounded-lg border border-[#263248]">
                    {(
                      [
                        { id: 'FULL_STRETCH', label: '16:9 Max Fill' },
                        { id: 'CRT_4_3', label: '4:3 CRT TV' },
                        { id: 'PIXEL_NATIVE', label: 'Pixel 16:15' },
                      ] as const
                    ).map((sc) => (
                      <button
                        key={sc.id}
                        onClick={() => setScaleMode(sc.id)}
                        className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          scaleMode === sc.id
                            ? 'bg-[#1E293B] text-[#38BDF8]'
                            : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                        }`}
                      >
                        {sc.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Direct Contra Weapon RAM Buttons + Cinema Expand + Fullscreen */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-[#94A3B8] font-mono">RAM Gun:</span>
                  {(
                    [
                      { code: 'S', label: '[S] Spread' },
                      { code: 'L', label: '[L] Laser' },
                      { code: 'M', label: '[M] Machine' },
                      { code: 'F', label: '[F] Flame' },
                    ] as const
                  ).map((w) => (
                    <button
                      key={w.code}
                      onClick={() => handleInjectContraWeapon(w.code)}
                      className="px-2 py-1 text-xs font-mono font-semibold rounded bg-[#0B0F17] border border-[#263248] text-[#E2E8F0] hover:border-[#F59E0B] hover:text-[#F59E0B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {w.label}
                    </button>
                  ))}

                  <button
                    onClick={() => setCinemaWideMode((w) => !w)}
                    className="hidden lg:flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-[#1E293B] text-[#E2E8F0] hover:bg-[#334155] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    title="Expand gameplay window across full 12-column width"
                  >
                    {cinemaWideMode ? (
                      <>
                        <PanelRightOpen className="w-3.5 h-3.5 text-[#38BDF8]" />
                        Show Sidebar
                      </>
                    ) : (
                      <>
                        <PanelRightClose className="w-3.5 h-3.5 text-[#38BDF8]" />
                        Wide Cinema
                      </>
                    )}
                  </button>

                  <button
                    onClick={toggleFullscreen}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded bg-[#F59E0B] text-[#0B0F17] hover:bg-[#FBBF24] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    Fullscreen
                  </button>
                </div>
              </div>
            )}

            {/* NES Viewport Container — Edge-to-Edge 100vw x 100vh in Fullscreen, Tall & Wide in Normal/Cinema Mode */}
            <div
              onDoubleClick={toggleFullscreen}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingRom(true);
              }}
              onDragLeave={() => setIsDraggingRom(false)}
              onDrop={handleDropRom}
              className={`relative w-full bg-[#05070B] overflow-hidden flex items-center justify-center ${
                isFullscreen
                  ? 'w-screen h-screen flex-1 rounded-none border-0'
                  : cinemaWideMode
                  ? 'h-[68vh] min-h-[520px] rounded-lg border border-[#263248]'
                  : 'h-[58vh] min-h-[440px] rounded-lg border border-[#263248]'
              }`}
            >
              {/* Real 256x240 NES Hardware Canvas Scaled Up */}
              <canvas
                ref={nesCanvasRef}
                width={NES_WIDTH}
                height={NES_HEIGHT}
                className={`${getNesCanvasScaleClass()} pixelated ${
                  coreMode === 'NES_ROM' ? 'block' : 'hidden'
                }`}
              />

              {/* Fallback Built-In Widescreen Demo Canvas */}
              <canvas
                ref={demoCanvasRef}
                width={INTERNAL_WIDTH}
                height={INTERNAL_HEIGHT}
                className={`w-full h-full object-fill pixelated ${
                  coreMode === 'BUILTIN_DEMO' ? 'block' : 'hidden'
                }`}
              />

              {crtEnabled && (
                <div className="pointer-events-none absolute inset-0 crt-scanlines opacity-65" />
              )}

              {/* Floating Ultra-Compact HUD Pill when in Fullscreen Mode (So the canvas gets 100% of the screen!) */}
              {isFullscreen && (
                <div className="absolute top-3 right-3 z-50 flex flex-wrap items-center gap-1.5 bg-[#0B0F17]/80 hover:bg-[#0B0F17] border border-[#263248] px-3 py-1.5 rounded-lg opacity-45 hover:opacity-100 transition-opacity">
                  {(
                    [
                      { id: 'FULL_STRETCH', label: '16:9 Fill' },
                      { id: 'CRT_4_3', label: '4:3 CRT' },
                      { id: 'PIXEL_NATIVE', label: 'Pixel' },
                    ] as const
                  ).map((sc) => (
                    <button
                      key={sc.id}
                      onClick={() => setScaleMode(sc.id)}
                      className={`px-2 py-1 text-xs font-mono rounded cursor-pointer ${
                        scaleMode === sc.id
                          ? 'bg-[#38BDF8] text-[#0B0F17] font-bold'
                          : 'text-[#E2E8F0] hover:bg-[#1E293B]'
                      }`}
                    >
                      {sc.label}
                    </button>
                  ))}

                  <button
                    onClick={() => handleGive30Lives(false)}
                    className="px-2.5 py-1 text-xs font-mono font-semibold bg-[#10B981] text-[#0B0F17] rounded cursor-pointer"
                  >
                    +30 Lives
                  </button>

                  <button
                    onClick={() => handleInjectContraWeapon('S')}
                    className="px-2.5 py-1 text-xs font-mono font-semibold bg-[#F59E0B] text-[#0B0F17] rounded cursor-pointer"
                  >
                    [S] Spread
                  </button>

                  <button
                    onClick={toggleFullscreen}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-[#F43F5E] text-white rounded cursor-pointer"
                  >
                    <Minimize2 className="w-3.5 h-3.5" />
                    Exit (Esc)
                  </button>
                </div>
              )}

              {/* Live P2P Tactical Callout Toast Inside Viewport */}
              {liveBannerCallout && (
                <div className="absolute top-3 left-3 z-40 bg-[#0B0F17]/90 border border-[#38BDF8] px-3.5 py-2 rounded-lg flex items-center gap-2">
                  <span className="text-xs font-mono font-bold text-[#38BDF8]">
                    [{liveBannerCallout.sender}]
                  </span>
                  <span className="text-xs font-semibold text-[#F1F5F9]">
                    {liveBannerCallout.text}
                  </span>
                </div>
              )}

              {/* Helpful overlay prompt when still running the tiny 6502 test ROM */}
              {coreMode === 'NES_ROM' &&
                romMeta?.fileName === 'VORTEX_6502_TEST_DUAL_PAD.nes' && (
                  <div className="absolute bottom-3 left-3 right-3 bg-[#0B0F17]/90 border border-[#F59E0B]/50 rounded-lg px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="text-xs text-[#E2E8F0]">
                      <strong className="text-[#F59E0B]">6502 CPU Active:</strong> Running the
                      built-in 6502 dual-controller test ROM. Drop your{' '}
                      <code className="font-mono text-[#38BDF8]">Contra.nes</code> file here to
                      boot real Contra!
                    </div>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="px-3 py-1.5 text-xs font-semibold bg-[#F59E0B] text-[#0B0F17] rounded hover:bg-[#FBBF24] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Browse .NES File
                    </button>
                  </div>
                )}
            </div>

            {/* Bottom Hardware Deck Toolbar (Hidden in Fullscreen so canvas fills 100vh) */}
            {!isFullscreen && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      onClick={() => setPaused((p) => !p)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#1E293B] hover:bg-[#334155] text-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {paused ? (
                        <Play className="w-3.5 h-3.5" />
                      ) : (
                        <Pause className="w-3.5 h-3.5" />
                      )}
                      {paused ? 'Resume' : 'Pause'}
                    </button>

                    <button
                      onClick={handleResetConsole}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#1E293B] hover:bg-[#334155] text-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Reset NES
                    </button>

                    <button
                      onClick={() => setTurboFireEnabled((t) => !t)}
                      className={`flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 cursor-pointer ${
                        turboFireEnabled
                          ? 'bg-[#F43F5E]/20 border border-[#F43F5E]/50 text-[#F43F5E]'
                          : 'bg-[#1E293B] text-[#94A3B8]'
                      }`}
                      title="Automatically rapid-fires when holding down the Shoot button (J/Z/F)"
                    >
                      <Flame className="w-3.5 h-3.5" />
                      Turbo Fire: {turboFireEnabled ? 'ON' : 'OFF'}
                    </button>

                    <button
                      onClick={() => setSpeedMultiplier((s) => (s === 1 ? 2 : 1))}
                      className={`px-2.5 py-1.5 text-xs font-mono font-semibold rounded-lg whitespace-nowrap shrink-0 cursor-pointer ${
                        speedMultiplier === 2
                          ? 'bg-[#F59E0B] text-[#0B0F17]'
                          : 'bg-[#1E293B] text-[#94A3B8]'
                      }`}
                    >
                      Speed: {speedMultiplier}x
                    </button>

                    <button
                      onClick={handleQuickSave}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-[#1E293B] hover:bg-[#334155] text-[#38BDF8] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      Save
                    </button>

                    <button
                      onClick={handleQuickLoad}
                      disabled={!savedNesState}
                      className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 ${
                        savedNesState
                          ? 'bg-[#1E293B] hover:bg-[#334155] text-[#10B981] cursor-pointer'
                          : 'bg-[#0B0F17] text-[#475569] cursor-not-allowed'
                      }`}
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      Load
                    </button>

                    <button
                      onClick={handleExportSaveFile}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-[#1E293B] hover:bg-[#334155] text-[#E2E8F0] whitespace-nowrap shrink-0 cursor-pointer"
                      title="Download .vortex.sav save state to disk"
                    >
                      <Download className="w-3.5 h-3.5" />
                      .SAV
                    </button>

                    <button
                      onClick={() => setCrtEnabled((c) => !c)}
                      className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 cursor-pointer ${
                        crtEnabled
                          ? 'bg-[#F59E0B]/20 text-[#F59E0B] border border-[#F59E0B]/40'
                          : 'bg-[#1E293B] text-[#94A3B8]'
                      }`}
                    >
                      CRT: {crtEnabled ? 'On' : 'Off'}
                    </button>

                    <button
                      onClick={handleToggleMute}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg bg-[#1E293B] hover:bg-[#334155] text-[#F1F5F9] whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {muted ? (
                        <VolumeX className="w-3.5 h-3.5 text-[#F43F5E]" />
                      ) : (
                        <Volume2 className="w-3.5 h-3.5 text-[#10B981]" />
                      )}
                    </button>
                  </div>

                  {/* Interactive On-Screen NES Pad (Select 2-Players / Start / B / A) */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      onClick={() => pulseVirtualButton(NES_BTN_SELECT, 150)}
                      className="px-2.5 py-1.5 text-xs font-mono font-semibold bg-[#0B0F17] border border-[#475569] rounded hover:border-[#F59E0B] text-[#E2E8F0] cursor-pointer"
                    >
                      SELECT (Shift)
                    </button>
                    <button
                      onClick={() => pulseVirtualButton(NES_BTN_START, 150)}
                      className="px-2.5 py-1.5 text-xs font-mono font-semibold bg-[#F59E0B]/20 border border-[#F59E0B] rounded text-[#F59E0B] hover:bg-[#F59E0B]/30 cursor-pointer"
                    >
                      START (Enter)
                    </button>
                    <button
                      onMouseDown={() => setVirtualBit(NES_BTN_B, true)}
                      onMouseUp={() => setVirtualBit(NES_BTN_B, false)}
                      onMouseLeave={() => setVirtualBit(NES_BTN_B, false)}
                      className="px-2.5 py-1.5 text-xs font-mono font-bold bg-[#F43F5E]/20 border border-[#F43F5E] rounded text-[#F43F5E] select-none cursor-pointer"
                    >
                      B · FIRE (J/Z)
                    </button>
                    <button
                      onMouseDown={() => setVirtualBit(NES_BTN_A, true)}
                      onMouseUp={() => setVirtualBit(NES_BTN_A, false)}
                      onMouseLeave={() => setVirtualBit(NES_BTN_A, false)}
                      className="px-2.5 py-1.5 text-xs font-mono font-bold bg-[#38BDF8]/20 border border-[#38BDF8] rounded text-[#38BDF8] select-none cursor-pointer"
                    >
                      A · JUMP (K/X)
                    </button>
                  </div>
                </div>

                {/* Control Binding Footer */}
                <div className="pt-2 border-t border-[#263248] flex flex-wrap items-center justify-between gap-2 text-xs text-[#94A3B8]">
                  <div>
                    <strong className="text-[#E2E8F0]">Controller 1:</strong> D-Pad:{' '}
                    <code className="font-mono text-[#38BDF8]">WASD</code> · B (Turbo Shoot):{' '}
                    <code className="font-mono text-[#38BDF8]">J / Z / F</code> · A (Jump):{' '}
                    <code className="font-mono text-[#38BDF8]">K / X / Space</code> · Select:{' '}
                    <code className="font-mono text-[#38BDF8]">Shift</code> · Start:{' '}
                    <code className="font-mono text-[#38BDF8]">Enter</code>
                  </div>
                  <div>
                    <strong className="text-[#E2E8F0]">Screen Tip:</strong> Double-click screen for
                    100% Edge-to-Edge Fullscreen
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Right 4 Columns: .NES ROM Inspector & WebRTC P2P Co-Op Room Deck (Hidden when Cinema Wide Mode is active) */}
          {!cinemaWideMode && (
            <aside className="lg:col-span-4 bg-[#151C28] border border-[#263248] rounded-xl p-5 flex flex-col justify-between space-y-5">
              <div className="space-y-4">
                {/* 3 Functional Tabs */}
                <div className="grid grid-cols-3 gap-1 p-1 bg-[#0B0F17] rounded-lg border border-[#263248]">
                  <button
                    onClick={() => setRightTab('ROM_LOADER')}
                    className={`flex items-center justify-center gap-1.5 py-2 px-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      rightTab === 'ROM_LOADER'
                        ? 'bg-[#1E293B] text-[#F59E0B]'
                        : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    <Disc className="w-3.5 h-3.5" />
                    .NES Cartridge
                  </button>
                  <button
                    onClick={() => setRightTab('NETPLAY')}
                    className={`flex items-center justify-center gap-1.5 py-2 px-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      rightTab === 'NETPLAY'
                        ? 'bg-[#1E293B] text-[#F59E0B]'
                        : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    <Radio className="w-3.5 h-3.5" />
                    WebRTC Co-Op
                  </button>
                  <button
                    onClick={() => setRightTab('CONTROLS')}
                    className={`flex items-center justify-center gap-1.5 py-2 px-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      rightTab === 'CONTROLS'
                        ? 'bg-[#1E293B] text-[#F59E0B]'
                        : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    <Gamepad2 className="w-3.5 h-3.5" />
                    Controls
                  </button>
                </div>

                {/* TAB 1: .NES CARTRIDGE LOADER & HEADER INSPECTOR */}
                {rightTab === 'ROM_LOADER' && (
                  <div className="space-y-4">
                    <div>
                      <h2 className="text-lg font-bold font-display tracking-wide text-[#F1F5F9]">
                        Bring-Your-Own .NES ROM Loader
                      </h2>
                      <p className="text-xs text-[#94A3B8] mt-0.5">
                        Upload your <code className="font-mono text-[#E2E8F0]">Contra (USA).nes</code>{' '}
                        or any iNES ROM file locally. When you host a WebRTC room, your browser
                        automatically transfers the ROM to your friend.
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="py-2.5 px-3 rounded-lg bg-[#F59E0B] hover:bg-[#FBBF24] text-[#0B0F17] font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Load .NES ROM
                      </button>

                      <button
                        onClick={() => savInputRef.current?.click()}
                        className="py-2.5 px-3 rounded-lg bg-[#1E293B] hover:bg-[#334155] text-[#E2E8F0] font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <FolderOpen className="w-3.5 h-3.5 text-[#38BDF8]" />
                        Import .SAV File
                      </button>
                    </div>

                    {romMeta && (
                      <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-[#263248] font-mono text-xs space-y-2 tabular-nums">
                        <div className="text-[#F59E0B] font-bold truncate">
                          {romMeta.fileName}
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[#94A3B8]">iNES Mapper:</span>
                          <span className="text-[#F1F5F9] text-right">{romMeta.mapperName}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[#94A3B8]">PRG-ROM / CHR-ROM:</span>
                          <span className="text-[#38BDF8]">
                            {romMeta.prgRomSizeKb} KB /{' '}
                            {romMeta.chrRomSizeKb > 0
                              ? `${romMeta.chrRomSizeKb} KB`
                              : '8 KB CHR-RAM'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[#94A3B8]">Nametable Mirroring:</span>
                          <span className="text-[#E2E8F0]">{romMeta.mirroring}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[#94A3B8]">ROM CRC32 Checksum:</span>
                          <span className="text-[#10B981]">0x{romMeta.crc32}</span>
                        </div>
                      </div>
                    )}

                    {/* Contra 30-Lives & Co-Op Quick Launch Checklist */}
                    <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-[#263248] space-y-2">
                      <div className="text-xs font-semibold text-[#E2E8F0]">
                        Built-In Hardware Features:
                      </div>
                      <ul className="text-xs text-[#94A3B8] space-y-1.5 list-disc list-inside">
                        <li>
                          <strong className="text-[#38BDF8]">Give 30 Lives (No Pause):</strong>{' '}
                          Directly sets NES RAM <code className="font-mono">$0032/$0033 = 29</code>{' '}
                          without pressing Start or pausing.
                        </li>
                        <li>
                          <strong className="text-[#F43F5E]">Turbo Fire (20Hz):</strong> Hold down{' '}
                          <code className="font-mono">J/Z/F</code> for automatic rapid-fire on any
                          weapon.
                        </li>
                        <li>
                          <strong className="text-[#F59E0B]">16:9 / 4:3 / Fullscreen:</strong> Use
                          the scaling buttons above the screen to fill 100% of your display.
                        </li>
                      </ul>
                    </div>
                  </div>
                )}

                {/* TAB 2: WEBRTC P2P MULTIPLAYER LOBBY & TACTICAL CALLOUTS */}
                {rightTab === 'NETPLAY' && (
                  <div className="space-y-4">
                    <div>
                      <h2 className="text-lg font-bold font-display tracking-wide text-[#F1F5F9]">
                        WebRTC Peer-to-Peer NES Co-Op
                      </h2>
                      <p className="text-xs text-[#94A3B8] mt-0.5">
                        Host a room as Controller 1 or join a friend&apos;s room as Controller 2.
                      </p>
                    </div>

                    <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-[#263248] space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-[#E2E8F0]">P2P Connection State</span>
                        <span className="font-mono text-[#10B981]">
                          {telemetry.connectionState}
                        </span>
                      </div>

                      {telemetry.roomCode ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between p-2.5 rounded bg-[#151C28] border border-[#263248]">
                            <div>
                              <div className="text-[11px] text-[#94A3B8]">
                                Room Code ·{' '}
                                <strong className="text-[#38BDF8]">
                                  Controller {telemetry.localPlayerIndex + 1}
                                </strong>
                              </div>
                              <div className="text-xl font-mono font-bold tracking-widest text-[#F59E0B]">
                                {telemetry.roomCode}
                              </div>
                            </div>
                            <button
                              onClick={handleCopyCode}
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-[#1E293B] hover:bg-[#334155] text-[#F1F5F9] cursor-pointer"
                            >
                              {copiedCode ? (
                                <Check className="w-3.5 h-3.5 text-[#10B981]" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                              {copiedCode ? 'Copied' : 'Copy'}
                            </button>
                          </div>

                          <button
                            onClick={() => nesCoordinatorRef.current?.syncExactSaveStateToPeer()}
                            className="w-full py-2 px-3 text-xs font-semibold rounded-lg bg-[#1E293B] hover:bg-[#334155] text-[#38BDF8] flex items-center justify-center gap-1.5 cursor-pointer"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            Force Sync Exact NES State to Friend
                          </button>

                          <button
                            onClick={() => nesCoordinatorRef.current?.disconnectRoom()}
                            className="w-full py-1 text-xs font-semibold text-[#F43F5E] hover:underline cursor-pointer"
                          >
                            Disconnect from Room
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          <button
                            onClick={handleHostRoom}
                            className="w-full py-2.5 px-4 text-xs font-semibold text-[#0B0F17] bg-[#F59E0B] hover:bg-[#FBBF24] rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
                          >
                            <Users className="w-4 h-4" />
                            Create P2P Room (Host as 1P)
                          </button>

                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              maxLength={6}
                              value={joinCodeInput}
                              onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                              placeholder="Enter 6-Char Code"
                              className="flex-1 px-3 py-2 text-xs font-mono uppercase bg-[#151C28] border border-[#263248] rounded-lg text-[#F1F5F9] placeholder-[#64748B] focus:outline-none focus:border-[#38BDF8]"
                            />
                            <button
                              onClick={() => handleJoinRoom()}
                              className="px-4 py-2 text-xs font-semibold bg-[#38BDF8] text-[#0B0F17] hover:bg-[#7DD3FC] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              Join as 2P
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Open Rooms List */}
                      {publicRooms.length > 0 && !telemetry.roomCode && (
                        <div className="pt-2 border-t border-[#263248] space-y-1.5">
                          <div className="text-[11px] text-[#94A3B8]">
                            Open Rooms Waiting for Player 2:
                          </div>
                          {publicRooms.map((rm) => (
                            <div
                              key={rm.code}
                              className="flex items-center justify-between text-xs bg-[#151C28] px-2.5 py-1.5 rounded border border-[#263248]"
                            >
                              <span className="font-mono font-semibold text-[#F59E0B]">
                                {rm.code}
                              </span>
                              <span className="text-[#94A3B8] text-[11px] truncate max-w-[130px]">
                                {rm.romName}
                              </span>
                              <button
                                onClick={() => handleJoinRoom(rm.code)}
                                className="text-xs font-semibold text-[#38BDF8] hover:underline cursor-pointer"
                              >
                                Join
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Co-Op Tactical Callouts & Quick-Chat */}
                    <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-[#263248] space-y-2.5">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-[#E2E8F0]">
                        <MessageSquare className="w-3.5 h-3.5 text-[#38BDF8]" />
                        Co-Op Tactical Callouts
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {[
                          'Take Spread [S]!',
                          'Pop 30 Lives!',
                          'Hold Bridge!',
                          'Boss Ahead!',
                        ].map((preset) => (
                          <button
                            key={preset}
                            onClick={() => handleSendCallout(preset)}
                            className="px-2 py-1 text-[11px] font-mono bg-[#151C28] hover:bg-[#1E293B] border border-[#263248] rounded text-[#38BDF8] cursor-pointer"
                          >
                            {preset}
                          </button>
                        ))}
                      </div>

                      {chatMessages.length > 0 && (
                        <div className="max-h-24 overflow-y-auto space-y-1 text-xs font-mono bg-[#151C28] p-2 rounded border border-[#263248]">
                          {chatMessages.map((m) => (
                            <div key={m.id}>
                              <span
                                className={
                                  m.sender === 'P1' ? 'text-[#38BDF8]' : 'text-[#F43F5E]'
                                }
                              >
                                [{m.sender}]:
                              </span>{' '}
                              <span className="text-[#E2E8F0]">{m.text}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleSendCallout(chatInput);
                        }}
                        className="flex gap-1.5"
                      >
                        <input
                          type="text"
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          placeholder="Send message to co-op partner..."
                          className="flex-1 px-2.5 py-1.5 text-xs bg-[#151C28] border border-[#263248] rounded text-[#F1F5F9] placeholder-[#64748B] focus:outline-none focus:border-[#38BDF8]"
                        />
                        <button
                          type="submit"
                          className="px-3 py-1.5 text-xs font-semibold bg-[#1E293B] hover:bg-[#334155] text-[#F1F5F9] rounded cursor-pointer"
                        >
                          Send
                        </button>
                      </form>
                    </div>
                  </div>
                )}

                {/* TAB 3: CONTROLLER MAPPING & GAMEPAD SUPPORT */}
                {rightTab === 'CONTROLS' && (
                  <div className="space-y-4">
                    <div>
                      <h2 className="text-lg font-bold font-display tracking-wide text-[#F1F5F9]">
                        NES Controller 1 &amp; 2 Mapping
                      </h2>
                      <p className="text-xs text-[#94A3B8] mt-0.5">
                        Supports Keyboard and USB/Bluetooth Gamepads (Xbox, PlayStation, 8BitDo).
                      </p>
                    </div>

                    <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-[#263248] space-y-2 text-xs font-mono">
                      <div className="text-[#38BDF8] font-bold">
                        NES CONTROLLER 1 (Host / Solo / Online Peer)
                      </div>
                      <div className="flex justify-between text-[#94A3B8]">
                        <span>D-Pad (8-Way Aim):</span>
                        <span className="text-[#F1F5F9]">W / A / S / D</span>
                      </div>
                      <div className="flex justify-between text-[#94A3B8]">
                        <span>B Button (Turbo Fire):</span>
                        <span className="text-[#F1F5F9]">J or Z or F (or U)</span>
                      </div>
                      <div className="flex justify-between text-[#94A3B8]">
                        <span>A Button (Jump):</span>
                        <span className="text-[#F1F5F9]">K or X or Space</span>
                      </div>
                      <div className="flex justify-between text-[#94A3B8]">
                        <span>SELECT (1P / 2P Cursor):</span>
                        <span className="text-[#F1F5F9]">Right/Left Shift</span>
                      </div>
                      <div className="flex justify-between text-[#94A3B8]">
                        <span>START (Begin / Pause):</span>
                        <span className="text-[#F1F5F9]">Enter</span>
                      </div>
                    </div>

                    <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-[#263248] space-y-2 text-xs font-mono">
                      <div className="text-[#F43F5E] font-bold">
                        NES CONTROLLER 2 (Shared Local Keyboard)
                      </div>
                      <div className="flex justify-between text-[#94A3B8]">
                        <span>D-Pad:</span>
                        <span className="text-[#F1F5F9]">Arrow Keys</span>
                      </div>
                      <div className="flex justify-between text-[#94A3B8]">
                        <span>B Button (Fire):</span>
                        <span className="text-[#F1F5F9]">N or Comma (,)</span>
                      </div>
                      <div className="flex justify-between text-[#94A3B8]">
                        <span>A Button (Jump):</span>
                        <span className="text-[#F1F5F9]">M or Period (.)</span>
                      </div>
                      <div className="flex justify-between text-[#94A3B8]">
                        <span>SELECT / START:</span>
                        <span className="text-[#F1F5F9]">[ and ]</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="pt-3 border-t border-[#263248] flex items-center justify-between text-xs text-[#94A3B8] font-mono tabular-nums">
                <span>CPU: MOS 6502 (1.79 MHz)</span>
                <span>NTSC: 60.0988 FPS</span>
              </div>
            </aside>
          )}
        </section>

        {/* Full-Width 4-Card Live NES & WebRTC Telemetry Strip */}
        <section
          id="telemetry-strip"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
        >
          <div className="bg-[#151C28] border border-[#263248] rounded-xl p-4 space-y-1">
            <div className="text-xs text-[#94A3B8]">NTSC Frame Rate &amp; CPU Step</div>
            <div className="text-2xl font-bold font-mono tabular-nums text-[#10B981]">
              {telemetry.fps} FPS · {telemetry.frameTimeMs} ms
            </div>
            <div className="text-xs text-[#94A3B8] font-mono tabular-nums">
              256×240 2C02 PPU · 44.1kHz 2A03 APU
            </div>
          </div>

          <div className="bg-[#151C28] border border-[#263248] rounded-xl p-4 space-y-1">
            <div className="text-xs text-[#94A3B8]">Loaded iNES Cartridge Hardware</div>
            <div className="text-xl font-bold font-mono tabular-nums text-[#F59E0B] truncate">
              {romMeta ? `Mapper #${romMeta.mapperId} (${romMeta.prgRomSizeKb}KB)` : 'No ROM'}
            </div>
            <div className="text-xs text-[#94A3B8] font-mono tabular-nums truncate">
              {romMeta ? `${romMeta.fileName} · CRC ${romMeta.crc32}` : 'Upload .nes file'}
            </div>
          </div>

          <div className="bg-[#151C28] border border-[#263248] rounded-xl p-4 space-y-1">
            <div className="text-xs text-[#94A3B8]">WebRTC P2P Transport &amp; Ping</div>
            <div className="text-2xl font-bold font-mono tabular-nums text-[#38BDF8]">
              {telemetry.connectionState === 'DISCONNECTED'
                ? 'Local Mode'
                : `${telemetry.pingRttMs} ms RTT`}
            </div>
            <div className="text-xs text-[#94A3B8] font-mono tabular-nums">
              State: {telemetry.connectionState} · Room: {telemetry.roomCode || 'None'}
            </div>
          </div>

          <div className="bg-[#151C28] border border-[#263248] rounded-xl p-4 space-y-1">
            <div className="text-xs text-[#94A3B8]">P2P Packets &amp; Frame Sync</div>
            <div className="text-2xl font-bold font-mono tabular-nums text-[#F1F5F9]">
              {telemetry.packetsSent} TX / {telemetry.packetsReceived} RX
            </div>
            <div className="text-xs text-[#94A3B8] font-mono tabular-nums">
              Frame Drift: {telemetry.frameAdvantage >= 0 ? `+${telemetry.frameAdvantage}` : telemetry.frameAdvantage}f · Auto ROM Sync
            </div>
          </div>
        </section>

        {/* How to Run Locally When Downloaded Section */}
        <section
          id="local-setup"
          className="bg-[#151C28] border border-[#263248] rounded-xl p-6 space-y-5"
        >
          <div className="flex items-center gap-2 text-xs font-mono text-[#F59E0B]">
            <Terminal className="w-4 h-4" />
            <span>LOCAL DOWNLOAD &amp; MULTIPLAYER HOSTING GUIDE</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-[#0B0F17] border border-[#263248] rounded-lg p-4 space-y-2">
              <div className="text-xs font-mono text-[#38BDF8]">STEP 1 · INSTALL &amp; START</div>
              <h3 className="text-base font-bold font-display text-[#F1F5F9]">
                Run on Your Computer (Node.js 18+)
              </h3>
              <p className="text-xs text-[#94A3B8] leading-relaxed">
                Unzip the downloaded project folder, open a terminal inside it, and run:
              </p>
              <pre className="p-2.5 rounded bg-[#151C28] border border-[#263248] text-xs font-mono text-[#10B981] overflow-x-auto">
                {`npm install\nnpm run dev`}
              </pre>
              <p className="text-xs text-[#94A3B8]">
                Then open <code className="font-mono text-[#E2E8F0]">http://localhost:3000</code> in
                Chrome, Edge, or Brave.
              </p>
            </div>

            <div className="bg-[#0B0F17] border border-[#263248] rounded-lg p-4 space-y-2">
              <div className="text-xs font-mono text-[#F59E0B]">STEP 2 · SAME WI-FI / LAN CO-OP</div>
              <h3 className="text-base font-bold font-display text-[#F1F5F9]">
                Play with a Friend on Home Wi-Fi / LAN
              </h3>
              <p className="text-xs text-[#94A3B8] leading-relaxed">
                The server binds to <code className="font-mono text-[#E2E8F0]">0.0.0.0:3000</code>.
                Find your computer&apos;s local IP (<code className="font-mono">ipconfig</code> on
                Windows or <code className="font-mono">ifconfig</code> on Mac/Linux) and have your
                friend open:
              </p>
              <pre className="p-2.5 rounded bg-[#151C28] border border-[#263248] text-xs font-mono text-[#F59E0B] overflow-x-auto">
                {`http://192.168.1.XX:3000`}
              </pre>
              <p className="text-xs text-[#94A3B8]">
                Create a room, share the 6-character code, and play with &lt;2ms LAN latency!
              </p>
            </div>

            <div className="bg-[#0B0F17] border border-[#263248] rounded-lg p-4 space-y-2">
              <div className="text-xs font-mono text-[#10B981]">STEP 3 · INTERNET CO-OP TUNNEL</div>
              <h3 className="text-base font-bold font-display text-[#F1F5F9]">
                Play Over the Internet from Localhost
              </h3>
              <p className="text-xs text-[#94A3B8] leading-relaxed">
                To invite a friend in another city while running locally, expose port 3000 with a
                free Cloudflare Tunnel in a second terminal:
              </p>
              <pre className="p-2.5 rounded bg-[#151C28] border border-[#263248] text-xs font-mono text-[#38BDF8] overflow-x-auto">
                {`npx cloudflared tunnel --url http://localhost:3000`}
              </pre>
              <p className="text-xs text-[#94A3B8]">
                Send your friend the generated <code className="font-mono">https://...trycloudflare.com</code>{' '}
                link—WebSocket signaling and WebRTC P2P work automatically!
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-[#263248] py-4 px-6 text-xs text-[#94A3B8] flex flex-col sm:flex-row items-center justify-between gap-2 max-w-[1440px] w-full mx-auto">
        <span>VORTEX-NES · Bring-Your-Own .NES ROM Emulator &amp; WebRTC Co-Op Platform</span>
        <span className="font-mono">MOS 6502 + Ricoh 2C02/2A03 · Unordered WebRTC DataChannel</span>
      </footer>
    </div>
  );
}
