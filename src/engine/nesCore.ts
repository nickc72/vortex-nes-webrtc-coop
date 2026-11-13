import { NES, Controller } from 'jsnes';

export const NES_WIDTH = 256;
export const NES_HEIGHT = 240;

// Standard 8-button NES Controller Bitmask
export const NES_BTN_A = 1 << 0;
export const NES_BTN_B = 1 << 1;
export const NES_BTN_SELECT = 1 << 2;
export const NES_BTN_START = 1 << 3;
export const NES_BTN_UP = 1 << 4;
export const NES_BTN_DOWN = 1 << 5;
export const NES_BTN_LEFT = 1 << 6;
export const NES_BTN_RIGHT = 1 << 7;

export interface InesRomMetadata {
  valid: boolean;
  fileName: string;
  fileSizeBytes: number;
  prgRomSizeKb: number;
  chrRomSizeKb: number;
  mapperId: number;
  mapperName: string;
  mirroring: 'Horizontal' | 'Vertical' | 'Four-Screen';
  hasBatteryRam: boolean;
  crc32: string;
}

const MAPPER_NAMES: Record<number, string> = {
  0: 'NROM (Super Mario Bros / Arcade)',
  1: 'MMC1 / SxROM (Metroid / Zelda / Mega Man 2)',
  2: 'UxROM (Contra USA / Castlevania / DuckTales)',
  3: 'CNROM (Arkanoid / Gradius / Paperboy)',
  4: 'MMC3 / TxROM (Super Mario Bros 3 / Contra Force)',
  7: 'AxROM (Battletoads / Marble Madness)',
  23: 'VRC2b / VRC4 (Contra Japan / Crisis Force)',
};

export function computeCrc32(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function parseInesHeader(bytes: Uint8Array, fileName: string): InesRomMetadata {
  if (
    bytes.length < 16 ||
    bytes[0] !== 0x4e || // 'N'
    bytes[1] !== 0x45 || // 'E'
    bytes[2] !== 0x53 || // 'S'
    bytes[3] !== 0x1a
  ) {
    return {
      valid: false,
      fileName,
      fileSizeBytes: bytes.length,
      prgRomSizeKb: 0,
      chrRomSizeKb: 0,
      mapperId: -1,
      mapperName: 'Invalid iNES Header',
      mirroring: 'Horizontal',
      hasBatteryRam: false,
      crc32: '00000000',
    };
  }

  const prgBanks = bytes[4];
  const chrBanks = bytes[5];
  const flags6 = bytes[6];
  const flags7 = bytes[7];

  const mapperId = (flags7 & 0xf0) | (flags6 >> 4);
  const fourScreen = (flags6 & 0x08) !== 0;
  const vertical = (flags6 & 0x01) !== 0;
  const hasBatteryRam = (flags6 & 0x02) !== 0;

  return {
    valid: true,
    fileName,
    fileSizeBytes: bytes.length,
    prgRomSizeKb: prgBanks * 16,
    chrRomSizeKb: chrBanks * 8,
    mapperId,
    mapperName: MAPPER_NAMES[mapperId] || `Mapper #${mapperId}`,
    mirroring: fourScreen ? 'Four-Screen' : vertical ? 'Vertical' : 'Horizontal',
    hasBatteryRam,
    crc32: computeCrc32(bytes),
  };
}

export function uint8ArrayToBinaryString(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode.apply(null, Array.from(slice)));
  }
  return chunks.join('');
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(uint8ArrayToBinaryString(bytes));
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Real 2A03 NES Stereo Audio Ring Buffer & WebAudio Output
 */
class NesAudioRingBuffer {
  private ctx: AudioContext | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private bufferSize = 8192;
  private leftSamples = new Float32Array(this.bufferSize);
  private rightSamples = new Float32Array(this.bufferSize);
  private writeIndex = 0;
  private readIndex = 0;
  public muted = false;
  public volume = 0.55;

  public start(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.scriptNode = this.ctx.createScriptProcessor(1024, 0, 2);
      this.scriptNode.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0);
        const outR = e.outputBuffer.getChannelData(1);
        const len = outL.length;

        for (let i = 0; i < len; i++) {
          if (this.readIndex !== this.writeIndex && !this.muted) {
            outL[i] = this.leftSamples[this.readIndex] * this.volume;
            outR[i] = this.rightSamples[this.readIndex] * this.volume;
            this.readIndex = (this.readIndex + 1) % this.bufferSize;
          } else {
            outL[i] = 0;
            outR[i] = 0;
          }
        }
      };
      this.scriptNode.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  public clearBuffer(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
  }

  public pushSample = (left: number, right: number): void => {
    if (this.muted) return;
    this.leftSamples[this.writeIndex] = left;
    this.rightSamples[this.writeIndex] = right;
    const nextWrite = (this.writeIndex + 1) % this.bufferSize;
    if (nextWrite !== this.readIndex) {
      this.writeIndex = nextWrite;
    }
  };
}

export type ContraWeaponCode = 'M' | 'F' | 'S' | 'L' | 'R';

/**
 * Real 6502 CPU + 2C02 PPU + 2A03 APU Hardware Emulator Wrapper
 */
export class RealNesHardwareCore {
  public nes: NES;
  public audio = new NesAudioRingBuffer();
  public romLoaded = false;
  public romMeta: InesRomMetadata | null = null;
  public frameCounter = 0;

  // Game Genie / 6502 RAM Cheat locks for Contra (NES)
  public lock30Lives = false;

  private lastRomBinaryString: string | null = null;
  private rgbaBuffer = new Uint32Array(NES_WIDTH * NES_HEIGHT);
  private prevMask: [number, number] = [0, 0];
  private konamiQueue: number[] = [];

  constructor() {
    this.nes = this.createNesInstance();
  }

  private createNesInstance(): NES {
    return new NES({
      onFrame: (framebuffer24: number[]) => {
        for (let i = 0; i < NES_WIDTH * NES_HEIGHT; i++) {
          this.rgbaBuffer[i] = 0xff000000 | framebuffer24[i];
        }
      },
      onAudioSample: this.audio.pushSample,
      emulateSound: true,
      sampleRate: 44100,
    });
  }

  public loadNesRomBytes(bytes: Uint8Array, fileName: string): InesRomMetadata {
    const meta = parseInesHeader(bytes, fileName);
    if (!meta.valid) {
      throw new Error(
        `Invalid .nes file "${fileName}". Please upload an uncompressed iNES (.nes) ROM file.`
      );
    }

    const binaryStr = uint8ArrayToBinaryString(bytes);
    this.lastRomBinaryString = binaryStr;
    this.nes = this.createNesInstance();
    this.nes.loadROM(binaryStr);
    this.romLoaded = true;
    this.romMeta = meta;
    this.frameCounter = 0;
    this.prevMask = [0, 0];
    this.konamiQueue = [];
    this.audio.clearBuffer();
    this.audio.start();
    return meta;
  }

  /**
   * Injects 30 Lives directly into NES 6502 Zero-Page RAM ($0032 = P1 Lives, $0033 = P2 Lives)
   * Works immediately during active Contra gameplay WITHOUT pressing Start or pausing the game!
   * Also queues the non-pausing Konami Code (↑ ↑ ↓ ↓ ← → ← → B A) if currently on the Title Screen.
   */
  public activate30LivesCheat(enableLock = false): void {
    if (!this.romLoaded || !this.nes.cpu?.mem) return;

    if (enableLock) {
      this.lock30Lives = !this.lock30Lives;
    }

    // In Contra (NES), RAM $0030 contains game mode/state, $0032 = P1 Lives, $0033 = P2 Lives
    this.nes.cpu.mem[0x0032] = 29; // 29 reserve + 1 active = 30 Lives for Player 1
    this.nes.cpu.mem[0x0033] = 29; // 29 reserve + 1 active = 30 Lives for Player 2

    // If the user is still on the Contra Title Screen ($0032 is 0 before stage load),
    // also feed ↑ ↑ ↓ ↓ ← → ← → B A (without START so it never pauses!)
    if (this.frameCounter < 900) {
      const seq = [
        NES_BTN_UP,
        0,
        NES_BTN_UP,
        0,
        NES_BTN_DOWN,
        0,
        NES_BTN_DOWN,
        0,
        NES_BTN_LEFT,
        0,
        NES_BTN_RIGHT,
        0,
        NES_BTN_LEFT,
        0,
        NES_BTN_RIGHT,
        0,
        NES_BTN_B,
        0,
        NES_BTN_A,
        0,
      ];
      this.konamiQueue = [];
      for (const mask of seq) {
        this.konamiQueue.push(mask, mask);
      }
    }
  }

  /**
   * Directly injects a weapon into Player 1 ($00AA) & Player 2 ($00AB) RAM in Contra (NES)
   * without pausing or needing a flying capsule!
   */
  public injectContraWeapon(weapon: ContraWeaponCode): void {
    if (!this.romLoaded || !this.nes.cpu?.mem) return;
    // Contra (NES) Weapon Byte ($00AA = P1, $00AB = P2):
    // Low nibble: 0 = Rifle, 1 = Machine Gun (M), 2 = Flame (F), 3 = Spread (S), 4 = Laser (L)
    // Bit 4 (0x10): Rapid Fire (R) upgrade enabled!
    const mapCode: Record<ContraWeaponCode, number> = {
      M: 0x11, // Machine Gun + Rapid
      F: 0x12, // Flame Thrower + Rapid
      S: 0x13, // Spread Gun + Rapid Fire
      L: 0x14, // Laser + Rapid Fire
      R: 0x10 | ((this.nes.cpu.mem[0x00aa] || 0) & 0x0f), // Add Rapid Fire to current weapon
    };
    const val = mapCode[weapon];
    this.nes.cpu.mem[0x00aa] = val;
    this.nes.cpu.mem[0x00ab] = val;
  }

  public applyControllerMask(controllerIndex: 1 | 2, mask: number): void {
    const prev = this.prevMask[controllerIndex - 1];
    if (prev === mask) return;

    const mapping: [number, number][] = [
      [NES_BTN_A, Controller.BUTTON_A],
      [NES_BTN_B, Controller.BUTTON_B],
      [NES_BTN_SELECT, Controller.BUTTON_SELECT],
      [NES_BTN_START, Controller.BUTTON_START],
      [NES_BTN_UP, Controller.BUTTON_UP],
      [NES_BTN_DOWN, Controller.BUTTON_DOWN],
      [NES_BTN_LEFT, Controller.BUTTON_LEFT],
      [NES_BTN_RIGHT, Controller.BUTTON_RIGHT],
    ];

    for (const [bit, jsnesBtn] of mapping) {
      const wasDown = (prev & bit) !== 0;
      const isDown = (mask & bit) !== 0;
      if (isDown && !wasDown) {
        this.nes.buttonDown(controllerIndex, jsnesBtn);
      } else if (!isDown && wasDown) {
        this.nes.buttonUp(controllerIndex, jsnesBtn);
      }
    }

    this.prevMask[controllerIndex - 1] = mask;
  }

  /**
   * Advance one 60Hz NTSC frame on the 6502 CPU + 2C02 PPU
   */
  public stepFrame(p1Mask: number, p2Mask: number): void {
    if (!this.romLoaded) return;

    let effectiveP1 = p1Mask;
    if (this.konamiQueue.length > 0) {
      effectiveP1 = this.konamiQueue.shift()!;
    }

    // Keep 30 lives locked in 6502 RAM if the user enabled the 30-Lives Lock toggle
    if (this.lock30Lives && this.nes.cpu?.mem) {
      if (this.nes.cpu.mem[0x0032] > 0 && this.nes.cpu.mem[0x0032] < 29) {
        this.nes.cpu.mem[0x0032] = 29;
      }
      if (this.nes.cpu.mem[0x0033] > 0 && this.nes.cpu.mem[0x0033] < 29) {
        this.nes.cpu.mem[0x0033] = 29;
      }
    }

    try {
      this.applyControllerMask(1, effectiveP1);
      this.applyControllerMask(2, p2Mask);
      this.nes.frame();
      this.frameCounter += 1;
    } catch (err) {
      console.error('NES frame step error, recovering:', err);
    }
  }

  public renderToCanvas(ctx: CanvasRenderingContext2D): void {
    if (!this.romLoaded) return;
    const imgData = ctx.createImageData(NES_WIDTH, NES_HEIGHT);
    const buf32 = new Uint32Array(imgData.data.buffer);
    buf32.set(this.rgbaBuffer);
    ctx.putImageData(imgData, 0, 0);
  }

  public saveStateSnapshot(): Record<string, unknown> | null {
    if (!this.romLoaded) return null;
    try {
      return this.nes.toJSON();
    } catch {
      return null;
    }
  }

  public loadStateSnapshot(snapshot: Record<string, unknown>): void {
    if (!this.romLoaded || !snapshot) return;
    try {
      this.nes.fromJSON(snapshot);
      this.prevMask = [0, 0];
    } catch (err) {
      console.error('Failed to restore snapshot:', err);
    }
  }

  /**
   * Safe Hardware Reboot: Reloads the stored iNES binary into a clean NES instance
   * (Calling jsnes .reset() directly unmaps Mapper 2 PRG banks and freezes the CPU).
   */
  public resetConsole(): void {
    if (!this.romLoaded || !this.lastRomBinaryString) return;
    this.nes = this.createNesInstance();
    this.nes.loadROM(this.lastRomBinaryString);
    this.frameCounter = 0;
    this.prevMask = [0, 0];
    this.konamiQueue = [];
    this.audio.clearBuffer();
  }

  public computeRamChecksum(): number {
    if (!this.romLoaded || !this.nes.cpu?.mem) return 0;
    const mem = this.nes.cpu.mem;
    let hash = this.frameCounter * 31;
    for (let i = 0; i < 0x0800; i += 4) {
      hash = ((hash << 5) - hash + (mem[i] || 0)) | 0;
    }
    return hash >>> 0;
  }
}
