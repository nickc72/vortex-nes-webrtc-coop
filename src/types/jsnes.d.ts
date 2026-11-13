declare module 'jsnes' {
  export const Controller: {
    BUTTON_A: 0;
    BUTTON_B: 1;
    BUTTON_SELECT: 2;
    BUTTON_START: 3;
    BUTTON_UP: 4;
    BUTTON_DOWN: 5;
    BUTTON_LEFT: 6;
    BUTTON_RIGHT: 7;
  };

  export interface NESOptions {
    onFrame?: (framebuffer24: number[]) => void;
    onAudioSample?: (left: number, right: number) => void;
    onStatusUpdate?: (status: string) => void;
    emulateSound?: boolean;
    sampleRate?: number;
  }

  export class NES {
    constructor(options?: NESOptions);
    loadROM(romDataBinaryString: string): void;
    frame(): void;
    buttonDown(controller: 1 | 2, button: number): void;
    buttonUp(controller: 1 | 2, button: number): void;
    reset(): void;
    toJSON(): Record<string, unknown>;
    fromJSON(state: Record<string, unknown>): void;
    cpu: {
      mem: number[];
      REG_PC: number;
      REG_A: number;
      REG_X: number;
      REG_Y: number;
      REG_SP: number;
    };
    ppu: {
      vramMem: number[];
      spriteMem: number[];
    };
    rom: {
      mapperType: number;
      romCount: number;
      vromCount: number;
      verticalMirroring: boolean;
      batteryRam: boolean;
      getMapperName(): string;
    } | null;
  }
}
