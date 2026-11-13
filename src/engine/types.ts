// 16-Bit Input Bitmask Constants for Deterministic Fantasy Console Execution
export const INPUT_UP = 1 << 0;
export const INPUT_DOWN = 1 << 1;
export const INPUT_LEFT = 1 << 2;
export const INPUT_RIGHT = 1 << 3;
export const INPUT_JUMP = 1 << 4;
export const INPUT_FIRE = 1 << 5;
export const INPUT_WEAPON_SWAP = 1 << 6;
export const INPUT_START = 1 << 7;

export type WeaponType = 'RIFLE' | 'SPREAD' | 'LASER' | 'RAPID' | 'CRUSH';

export type AimDirection =
  | 'RIGHT'
  | 'UP_RIGHT'
  | 'UP'
  | 'UP_LEFT'
  | 'LEFT'
  | 'DOWN_LEFT'
  | 'DOWN'
  | 'DOWN_RIGHT';

export interface PlatformTile {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  oneWay: boolean; // true = jump-through / drop-through bridge or ledge
  destructible?: boolean;
  style: 'JUNGLE_GRASS' | 'STEEL_BRIDGE' | 'BUNKER_METAL' | 'WATER_HAZARD';
}

export interface EnemySpawnDef {
  triggerX: number;
  x: number;
  y: number;
  type: 'RUNNER' | 'SNIPER' | 'TURRET' | 'CAPSULE' | 'MECH_WALKER' | 'BOSS_CORE';
  dropWeapon?: WeaponType;
  patrolRange?: number;
}

export interface CartridgeDefinition {
  id: string;
  title: string;
  subtitle: string;
  author: string;
  version: string;
  description: string;
  levelLength: number;
  gravity: number;
  playerSpeed: number;
  jumpForce: number;
  startingLives: number;
  startingWeapon: WeaponType;
  palette: {
    skyTop: string;
    skyBottom: string;
    distantMountains: string;
    foliageOrWall: string;
    accentGlow: string;
  };
  platforms: PlatformTile[];
  spawns: EnemySpawnDef[];
  bossConfig: {
    triggerX: number;
    x: number;
    y: number;
    name: string;
    maxHp: number;
    phases: number;
  };
}

export interface PlayerEntity {
  index: 0 | 1;
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  aimDir: AimDirection;
  crouching: boolean;
  grounded: boolean;
  weapon: WeaponType;
  altWeapon: WeaponType;
  fireCooldown: number;
  invulnTimer: number;
  respawnTimer: number;
  lives: number;
  score: number;
  kills: number;
  animTick: number;
  prevInputMask: number;
}

export interface BulletEntity {
  id: number;
  owner: 'P1' | 'P2' | 'ENEMY';
  weapon: WeaponType | 'ENEMY_ORB' | 'BOSS_PLASMA' | 'BOSS_MORTAR';
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  damage: number;
  pierce: boolean;
  ttl: number;
  gravityFactor?: number;
}

export interface EnemyEntity {
  id: number;
  type: 'RUNNER' | 'SNIPER' | 'TURRET' | 'CAPSULE' | 'MECH_WALKER' | 'BOSS_CORE';
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  hp: number;
  maxHp: number;
  facing: 1 | -1;
  fireTimer: number;
  phase: number;
  stateTimer: number;
  dropWeapon?: WeaponType;
  baseY: number;
}

export interface PowerUpPickup {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  weapon: WeaponType;
  ttl: number;
}

export interface ParticleEntity {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  life: number;
  maxLife: number;
}

export type SoundCueType =
  | 'SHOOT_RIFLE'
  | 'SHOOT_SPREAD'
  | 'SHOOT_LASER'
  | 'SHOOT_CRUSH'
  | 'JUMP'
  | 'POWERUP'
  | 'HIT_ENEMY'
  | 'EXPLODE_SMALL'
  | 'EXPLODE_BOSS'
  | 'PLAYER_DEATH'
  | 'VICTORY';

export interface VortexVMState {
  frame: number;
  rngState: number;
  status: 'PLAYING' | 'VICTORY' | 'GAME_OVER';
  cameraX: number;
  screenShake: number;
  bossActive: boolean;
  bossDefeated: boolean;
  triggeredSpawns: number[]; // indices of CartridgeDefinition.spawns already spawned
  nextEntityId: number;
  players: [PlayerEntity, PlayerEntity];
  bullets: BulletEntity[];
  enemies: EnemyEntity[];
  pickups: PowerUpPickup[];
  particles: ParticleEntity[];
  soundEvents: SoundCueType[]; // emitted on current frame for WebAudio APU
}

export interface NetFramePacket {
  frame: number;
  playerIndex: 0 | 1;
  /** Redundant sliding window of inputs: index 0 is `frame`, index 1 is `frame - 1`, up to 10 frames back */
  inputs: number[];
  timestamp: number;
  stateChecksum: number;
}

export interface NetcodeTelemetry {
  mode: 'SOLO' | 'LOCAL_2P' | 'SANDBOX_ROLLBACK' | 'WEBRTC_P2P';
  connectionState: 'DISCONNECTED' | 'SIGNALING' | 'WEBRTC_DIRECT' | 'WS_RELAY';
  roomCode: string | null;
  localPlayerIndex: 0 | 1;
  fps: number;
  frameTimeMs: number;
  pingRttMs: number;
  rollbackFramesLastSecond: number;
  totalRollbacks: number;
  maxRollbackDepth: number;
  frameAdvantage: number;
  predictionAccuracyPct: number;
  packetsSent: number;
  packetsReceived: number;
  simulatedLagMs: number;
  checksumMatch: boolean;
}
