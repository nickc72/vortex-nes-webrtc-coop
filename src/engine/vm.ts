import {
  AimDirection,
  BulletEntity,
  CartridgeDefinition,
  EnemyEntity,
  INPUT_DOWN,
  INPUT_FIRE,
  INPUT_JUMP,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_UP,
  INPUT_WEAPON_SWAP,
  ParticleEntity,
  PlayerEntity,
  VortexVMState,
  WeaponType,
} from './types';

export const INTERNAL_WIDTH = 640;
export const INTERNAL_HEIGHT = 360;
const PLAYER_WIDTH = 18;
const PLAYER_HEIGHT = 32;
const PLAYER_CROUCH_HEIGHT = 18;

/**
 * Deterministic XorShift32 PRNG so both WebRTC peers generate identical enemy behavior and particles
 */
function nextRng(state: VortexVMState): number {
  let x = state.rngState | 0;
  if (x === 0) x = 1337420;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.rngState = x >>> 0;
  return (state.rngState % 10000) / 10000;
}

export function cloneVMState(s: VortexVMState): VortexVMState {
  return {
    frame: s.frame,
    rngState: s.rngState,
    status: s.status,
    cameraX: s.cameraX,
    screenShake: s.screenShake,
    bossActive: s.bossActive,
    bossDefeated: s.bossDefeated,
    triggeredSpawns: [...s.triggeredSpawns],
    nextEntityId: s.nextEntityId,
    players: [{ ...s.players[0] }, { ...s.players[1] }],
    bullets: s.bullets.map((b) => ({ ...b })),
    enemies: s.enemies.map((e) => ({ ...e })),
    pickups: s.pickups.map((p) => ({ ...p })),
    particles: s.particles.map((pt) => ({ ...pt })),
    soundEvents: [],
  };
}

export function computeStateChecksum(s: VortexVMState): number {
  let hash = (s.frame * 31 + s.rngState) | 0;
  for (const p of s.players) {
    if (p.active) {
      hash = (hash * 31 + Math.round(p.x) + Math.round(p.y) * 17 + p.lives * 101 + p.score) | 0;
    }
  }
  hash = (hash * 31 + s.enemies.length * 13 + s.bullets.length * 7) | 0;
  return hash >>> 0;
}

export function createInitialVMState(
  cartridge: CartridgeDefinition,
  seed: number,
  twoPlayerActive: boolean
): VortexVMState {
  const createPlayer = (index: 0 | 1, active: boolean): PlayerEntity => ({
    index,
    active,
    x: index === 0 ? 70 : 108,
    y: 180,
    vx: 0,
    vy: 0,
    facing: 1,
    aimDir: 'RIGHT',
    crouching: false,
    grounded: false,
    weapon: cartridge.startingWeapon,
    altWeapon: 'RIFLE',
    fireCooldown: 0,
    invulnTimer: 90,
    respawnTimer: 0,
    lives: cartridge.startingLives,
    score: 0,
    kills: 0,
    animTick: 0,
    prevInputMask: 0,
  });

  return {
    frame: 0,
    rngState: seed || 1337420,
    status: 'PLAYING',
    cameraX: 0,
    screenShake: 0,
    bossActive: false,
    bossDefeated: false,
    triggeredSpawns: [],
    nextEntityId: 1,
    players: [createPlayer(0, true), createPlayer(1, twoPlayerActive)],
    bullets: [],
    enemies: [],
    pickups: [],
    particles: [],
    soundEvents: [],
  };
}

function resolveAimDirection(mask: number, facing: 1 | -1, grounded: boolean): AimDirection {
  const up = (mask & INPUT_UP) !== 0;
  const down = (mask & INPUT_DOWN) !== 0;
  const left = (mask & INPUT_LEFT) !== 0;
  const right = (mask & INPUT_RIGHT) !== 0;

  if (up && right) return 'UP_RIGHT';
  if (up && left) return 'UP_LEFT';
  if (down && right) return 'DOWN_RIGHT';
  if (down && left) return 'DOWN_LEFT';
  if (up) return 'UP';
  if (down && !grounded) return 'DOWN';
  if (left) return 'LEFT';
  if (right) return 'RIGHT';
  return facing === 1 ? 'RIGHT' : 'LEFT';
}

function aimDirectionVector(dir: AimDirection): { dx: number; dy: number } {
  const diag = 0.70710678;
  switch (dir) {
    case 'RIGHT':
      return { dx: 1, dy: 0 };
    case 'LEFT':
      return { dx: -1, dy: 0 };
    case 'UP':
      return { dx: 0, dy: -1 };
    case 'DOWN':
      return { dx: 0, dy: 1 };
    case 'UP_RIGHT':
      return { dx: diag, dy: -diag };
    case 'UP_LEFT':
      return { dx: -diag, dy: -diag };
    case 'DOWN_RIGHT':
      return { dx: diag, dy: diag };
    case 'DOWN_LEFT':
      return { dx: -diag, dy: diag };
  }
}

function spawnParticles(
  state: VortexVMState,
  x: number,
  y: number,
  count: number,
  color: string,
  speedScale = 3.2
): void {
  for (let i = 0; i < count; i++) {
    if (state.particles.length > 90) break;
    const angle = nextRng(state) * Math.PI * 2;
    const spd = (0.4 + nextRng(state) * 0.8) * speedScale;
    const life = 12 + Math.floor(nextRng(state) * 16);
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd - 0.6,
      color,
      size: 2 + Math.floor(nextRng(state) * 3),
      life,
      maxLife: life,
    });
  }
}

function firePlayerWeapon(
  state: VortexVMState,
  player: PlayerEntity
): void {
  const ownerTag = player.index === 0 ? 'P1' : 'P2';
  const vec = aimDirectionVector(player.aimDir);
  const muzzleX = player.x + PLAYER_WIDTH / 2 + vec.dx * 12;
  const muzzleY =
    player.crouching && player.grounded
      ? player.y + PLAYER_HEIGHT - 10
      : player.y + 11 + vec.dy * 8;

  const baseAngle = Math.atan2(vec.dy, vec.dx);

  switch (player.weapon) {
    case 'RIFLE': {
      player.fireCooldown = 9;
      state.soundEvents.push('SHOOT_RIFLE');
      state.bullets.push({
        id: state.nextEntityId++,
        owner: ownerTag,
        weapon: 'RIFLE',
        x: muzzleX,
        y: muzzleY,
        vx: Math.cos(baseAngle) * 8.5,
        vy: Math.sin(baseAngle) * 8.5,
        radius: 3,
        damage: 2,
        pierce: false,
        ttl: 65,
      });
      break;
    }
    case 'RAPID': {
      player.fireCooldown = 5;
      state.soundEvents.push('SHOOT_RIFLE');
      state.bullets.push({
        id: state.nextEntityId++,
        owner: ownerTag,
        weapon: 'RAPID',
        x: muzzleX,
        y: muzzleY,
        vx: Math.cos(baseAngle) * 9.8,
        vy: Math.sin(baseAngle) * 9.8,
        radius: 3.5,
        damage: 2,
        pierce: false,
        ttl: 65,
      });
      break;
    }
    case 'SPREAD': {
      player.fireCooldown = 14;
      state.soundEvents.push('SHOOT_SPREAD');
      const spreadAngles = [-0.26, -0.13, 0, 0.13, 0.26];
      for (const offset of spreadAngles) {
        const a = baseAngle + offset;
        state.bullets.push({
          id: state.nextEntityId++,
          owner: ownerTag,
          weapon: 'SPREAD',
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(a) * 7.8,
          vy: Math.sin(a) * 7.8,
          radius: 4,
          damage: 2,
          pierce: false,
          ttl: 58,
        });
      }
      break;
    }
    case 'LASER': {
      player.fireCooldown = 16;
      state.soundEvents.push('SHOOT_LASER');
      for (let seg = 0; seg < 3; seg++) {
        state.bullets.push({
          id: state.nextEntityId++,
          owner: ownerTag,
          weapon: 'LASER',
          x: muzzleX - vec.dx * seg * 7,
          y: muzzleY - vec.dy * seg * 7,
          vx: Math.cos(baseAngle) * 10.5,
          vy: Math.sin(baseAngle) * 10.5,
          radius: 4,
          damage: 3,
          pierce: true,
          ttl: 52,
        });
      }
      break;
    }
    case 'CRUSH': {
      player.fireCooldown = 18;
      state.soundEvents.push('SHOOT_CRUSH');
      state.bullets.push({
        id: state.nextEntityId++,
        owner: ownerTag,
        weapon: 'CRUSH',
        x: muzzleX,
        y: muzzleY,
        vx: Math.cos(baseAngle) * 7.2,
        vy: Math.sin(baseAngle) * 7.2,
        radius: 5.5,
        damage: 7,
        pierce: false,
        ttl: 60,
      });
      break;
    }
  }
}

/**
 * Pure, deterministic 60Hz Fantasy Console Step Function
 */
export function stepVortexVM(
  prevState: VortexVMState,
  cartridge: CartridgeDefinition,
  p1InputMask: number,
  p2InputMask: number
): VortexVMState {
  const state = cloneVMState(prevState);
  state.frame += 1;
  state.soundEvents = [];

  if (state.screenShake > 0) {
    state.screenShake = Math.max(0, state.screenShake - 1);
  }

  if (state.status !== 'PLAYING') {
    // Update celebratory/explosion particles even after victory/game-over
    updateParticles(state);
    return state;
  }

  const inputMasks: [number, number] = [p1InputMask, p2InputMask];

  // 1. Update Both Players
  for (let i = 0; i < 2; i++) {
    const p = state.players[i];
    if (!p.active) continue;

    const mask = inputMasks[i];
    const prevMask = p.prevInputMask;
    const justPressedJump = (mask & INPUT_JUMP) !== 0 && (prevMask & INPUT_JUMP) === 0;
    const justPressedSwap =
      (mask & INPUT_WEAPON_SWAP) !== 0 && (prevMask & INPUT_WEAPON_SWAP) === 0;

    p.prevInputMask = mask;

    // Handle Respawn Delay
    if (p.respawnTimer > 0) {
      p.respawnTimer -= 1;
      if (p.respawnTimer === 0 && p.lives > 0) {
        p.x = state.cameraX + 64 + i * 32;
        p.y = 60;
        p.vx = 0;
        p.vy = 0;
        p.invulnTimer = 120;
        p.weapon = cartridge.startingWeapon;
      }
      continue;
    }

    if (p.lives <= 0) continue;

    if (p.invulnTimer > 0) p.invulnTimer -= 1;
    if (p.fireCooldown > 0) p.fireCooldown -= 1;

    // Swap Primary & Alt Weapon
    if (justPressedSwap) {
      const tmp = p.weapon;
      p.weapon = p.altWeapon;
      p.altWeapon = tmp;
    }

    // Horizontal Movement
    const moveLeft = (mask & INPUT_LEFT) !== 0;
    const moveRight = (mask & INPUT_RIGHT) !== 0;
    const holdDown = (mask & INPUT_DOWN) !== 0;

    if (moveLeft && !moveRight) {
      p.facing = -1;
      p.vx = -cartridge.playerSpeed;
      p.crouching = false;
    } else if (moveRight && !moveLeft) {
      p.facing = 1;
      p.vx = cartridge.playerSpeed;
      p.crouching = false;
    } else {
      p.vx = 0;
      p.crouching = holdDown && p.grounded;
    }

    // Aim Direction
    p.aimDir = resolveAimDirection(mask, p.facing, p.grounded);

    // Jump or Drop-Through One-Way Platform
    if (justPressedJump && p.grounded) {
      const standingTile = findStandingPlatform(p, cartridge);
      if (holdDown && standingTile && standingTile.oneWay) {
        // Drop down through bridge/ledge
        p.y += 6;
        p.grounded = false;
        p.crouching = false;
      } else {
        p.vy = cartridge.jumpForce;
        p.grounded = false;
        p.crouching = false;
        state.soundEvents.push('JUMP');
      }
    }

    // Apply Gravity & Velocity
    const prevBottom = p.y + PLAYER_HEIGHT;
    p.x += p.vx;
    p.vy = Math.min(9.5, p.vy + cartridge.gravity);
    p.y += p.vy;

    // Clamp to camera bounds
    const minX = state.cameraX + 8;
    const maxX = state.cameraX + INTERNAL_WIDTH - PLAYER_WIDTH - 8;
    if (p.x < minX) p.x = minX;
    if (p.x > maxX) p.x = maxX;

    // Platform Collision Resolution
    p.grounded = false;
    const nextBottom = p.y + PLAYER_HEIGHT;

    for (const plat of cartridge.platforms) {
      if (plat.style === 'WATER_HAZARD') continue;
      const horizOverlap =
        p.x + PLAYER_WIDTH - 2 > plat.x && p.x + 2 < plat.x + plat.width;
      if (horizOverlap && p.vy >= 0 && prevBottom <= plat.y + 6 && nextBottom >= plat.y) {
        p.y = plat.y - PLAYER_HEIGHT;
        p.vy = 0;
        p.grounded = true;
        break;
      }
    }

    // Fall into abyss / water hazard check
    if (p.y > INTERNAL_HEIGHT + 20) {
      killPlayer(state, p);
      continue;
    }

    // Animation Tick
    if (Math.abs(p.vx) > 0.1 || !p.grounded) {
      p.animTick += 1;
    }

    // Firing Weapon
    if ((mask & INPUT_FIRE) !== 0 && p.fireCooldown === 0) {
      firePlayerWeapon(state, p);
    }
  }

  // 2. Update Camera Horizontal Scroll
  const livingPlayers = state.players.filter((p) => p.active && p.lives > 0 && p.respawnTimer === 0);
  if (livingPlayers.length > 0) {
    const avgX =
      livingPlayers.reduce((acc, p) => acc + p.x, 0) / livingPlayers.length;
    const targetCamX = Math.max(state.cameraX, avgX - INTERNAL_WIDTH * 0.36);
    const maxCamX = cartridge.levelLength - INTERNAL_WIDTH;
    state.cameraX = Math.min(maxCamX, state.cameraX + (targetCamX - state.cameraX) * 0.15);
  } else if (state.players.every((p) => !p.active || (p.lives <= 0 && p.respawnTimer === 0))) {
    state.status = 'GAME_OVER';
  }

  // 3. Trigger Cartridge Enemy & Capsule Spawns Based on Camera Scroll
  cartridge.spawns.forEach((spawn, idx) => {
    if (!state.triggeredSpawns.includes(idx) && state.cameraX >= spawn.triggerX) {
      state.triggeredSpawns.push(idx);
      state.enemies.push(createEnemyFromSpawn(state, spawn));
    }
  });

  // Trigger End-of-Sector Boss Core
  if (
    !state.bossActive &&
    !state.bossDefeated &&
    state.cameraX >= cartridge.bossConfig.triggerX
  ) {
    state.bossActive = true;
    state.enemies.push({
      id: state.nextEntityId++,
      type: 'BOSS_CORE',
      x: cartridge.bossConfig.x,
      y: cartridge.bossConfig.y,
      vx: 0,
      vy: 0,
      width: 68,
      height: 105,
      hp: cartridge.bossConfig.maxHp,
      maxHp: cartridge.bossConfig.maxHp,
      facing: -1,
      fireTimer: 45,
      phase: 1,
      stateTimer: 0,
      baseY: cartridge.bossConfig.y,
    });
  }

  // 4. Update Pickups (Weapon Power-Up Badges)
  for (let i = state.pickups.length - 1; i >= 0; i--) {
    const pk = state.pickups[i];
    pk.x += pk.vx;
    pk.vy = Math.min(5, pk.vy + cartridge.gravity * 0.65);
    pk.y += pk.vy;
    pk.ttl -= 1;

    for (const plat of cartridge.platforms) {
      if (plat.style === 'WATER_HAZARD') continue;
      if (
        pk.x + 14 > plat.x &&
        pk.x < plat.x + plat.width &&
        pk.y + 14 >= plat.y &&
        pk.y + 14 <= plat.y + 12 &&
        pk.vy >= 0
      ) {
        pk.y = plat.y - 14;
        pk.vy = -2.4;
        pk.vx *= 0.6;
      }
    }

    // Check Player Pickup Collection
    let collected = false;
    for (const p of livingPlayers) {
      if (
        Math.abs(p.x + PLAYER_WIDTH / 2 - (pk.x + 8)) < 20 &&
        Math.abs(p.y + PLAYER_HEIGHT / 2 - (pk.y + 8)) < 24
      ) {
        if (p.weapon !== pk.weapon) {
          p.altWeapon = p.weapon;
          p.weapon = pk.weapon;
        }
        p.score += 500;
        state.soundEvents.push('POWERUP');
        spawnParticles(state, pk.x + 8, pk.y + 8, 12, '#F59E0B', 2.8);
        collected = true;
        break;
      }
    }

    if (collected || pk.ttl <= 0) {
      state.pickups.splice(i, 1);
    }
  }

  // 5. Update Enemies & Boss AI
  updateEnemies(state, cartridge, livingPlayers);

  // 6. Update Bullets & Hitbox Collisions
  updateBullets(state, cartridge, livingPlayers);

  // 7. Update Particles
  updateParticles(state);

  return state;
}

function findStandingPlatform(p: PlayerEntity, cartridge: CartridgeDefinition) {
  const bottom = p.y + PLAYER_HEIGHT;
  for (const plat of cartridge.platforms) {
    if (
      p.x + PLAYER_WIDTH - 2 > plat.x &&
      p.x + 2 < plat.x + plat.width &&
      Math.abs(bottom - plat.y) <= 4
    ) {
      return plat;
    }
  }
  return null;
}

function killPlayer(state: VortexVMState, p: PlayerEntity): void {
  p.lives -= 1;
  p.respawnTimer = p.lives > 0 ? 75 : 0;
  p.vx = 0;
  p.vy = 0;
  state.screenShake = 8;
  state.soundEvents.push('PLAYER_DEATH');
  spawnParticles(
    state,
    p.x + PLAYER_WIDTH / 2,
    p.y + PLAYER_HEIGHT / 2,
    18,
    p.index === 0 ? '#38BDF8' : '#F43F5E',
    3.8
  );
}

function createEnemyFromSpawn(
  state: VortexVMState,
  spawn: CartridgeDefinition['spawns'][number]
): EnemyEntity {
  switch (spawn.type) {
    case 'CAPSULE':
      return {
        id: state.nextEntityId++,
        type: 'CAPSULE',
        x: state.cameraX - 16,
        y: spawn.y,
        vx: 2.35,
        vy: 0,
        width: 24,
        height: 16,
        hp: 3,
        maxHp: 3,
        facing: 1,
        fireTimer: 999,
        phase: 1,
        stateTimer: 0,
        dropWeapon: spawn.dropWeapon || 'SPREAD',
        baseY: spawn.y,
      };
    case 'TURRET':
      return {
        id: state.nextEntityId++,
        type: 'TURRET',
        x: spawn.x,
        y: spawn.y,
        vx: 0,
        vy: 0,
        width: 26,
        height: 26,
        hp: 12,
        maxHp: 12,
        facing: -1,
        fireTimer: 55,
        phase: 1,
        stateTimer: 0,
        baseY: spawn.y,
      };
    case 'MECH_WALKER':
      return {
        id: state.nextEntityId++,
        type: 'MECH_WALKER',
        x: spawn.x,
        y: spawn.y,
        vx: -0.65,
        vy: 0,
        width: 34,
        height: 40,
        hp: 24,
        maxHp: 24,
        facing: -1,
        fireTimer: 50,
        phase: 1,
        stateTimer: 0,
        baseY: spawn.y,
      };
    case 'SNIPER':
      return {
        id: state.nextEntityId++,
        type: 'SNIPER',
        x: spawn.x,
        y: spawn.y,
        vx: 0,
        vy: 0,
        width: 18,
        height: 30,
        hp: 4,
        maxHp: 4,
        facing: -1,
        fireTimer: 60,
        phase: 1,
        stateTimer: 0,
        baseY: spawn.y,
      };
    case 'RUNNER':
    default:
      return {
        id: state.nextEntityId++,
        type: 'RUNNER',
        x: spawn.x,
        y: spawn.y,
        vx: -1.65,
        vy: 0,
        width: 18,
        height: 30,
        hp: 2,
        maxHp: 2,
        facing: -1,
        fireTimer: 75,
        phase: 1,
        stateTimer: 0,
        baseY: spawn.y,
      };
  }
}

function updateEnemies(
  state: VortexVMState,
  cartridge: CartridgeDefinition,
  livingPlayers: PlayerEntity[]
): void {
  for (let i = state.enemies.length - 1; i >= 0; i--) {
    const e = state.enemies[i];
    e.stateTimer += 1;

    // Pick nearest living player as target
    let target: PlayerEntity | null = null;
    let bestDist = Infinity;
    for (const p of livingPlayers) {
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d < bestDist) {
        bestDist = d;
        target = p;
      }
    }

    if (e.type === 'CAPSULE') {
      e.x += e.vx;
      e.y = e.baseY + Math.sin(e.stateTimer * 0.09) * 22;
      if (e.x > state.cameraX + INTERNAL_WIDTH + 60) {
        state.enemies.splice(i, 1);
        continue;
      }
    } else if (e.type === 'RUNNER') {
      e.x += e.vx;
      e.vy = Math.min(8, e.vy + cartridge.gravity);
      e.y += e.vy;
      for (const plat of cartridge.platforms) {
        if (plat.style === 'WATER_HAZARD') continue;
        if (
          e.x + e.width > plat.x &&
          e.x < plat.x + plat.width &&
          e.y + e.height >= plat.y &&
          e.y + e.height <= plat.y + 12 &&
          e.vy >= 0
        ) {
          e.y = plat.y - e.height;
          e.vy = 0;
        }
      }
      if (e.x < state.cameraX - 60 || e.y > INTERNAL_HEIGHT + 40) {
        state.enemies.splice(i, 1);
        continue;
      }
    } else if (e.type === 'MECH_WALKER') {
      if (Math.sin(e.stateTimer * 0.04) > 0) {
        e.x -= 0.55;
      } else {
        e.x += 0.35;
      }
      e.fireTimer -= 1;
      if (e.fireTimer <= 0 && target) {
        e.fireTimer = 68;
        const angle = Math.atan2(target.y - e.y, target.x - e.x);
        state.bullets.push({
          id: state.nextEntityId++,
          owner: 'ENEMY',
          weapon: 'BOSS_PLASMA',
          x: e.x,
          y: e.y + 14,
          vx: Math.cos(angle) * 3.8,
          vy: Math.sin(angle) * 3.8,
          radius: 5,
          damage: 1,
          pierce: false,
          ttl: 110,
        });
      }
    } else if (e.type === 'SNIPER' || e.type === 'TURRET') {
      if (target) {
        e.facing = target.x < e.x ? -1 : 1;
      }
      e.fireTimer -= 1;
      if (e.fireTimer <= 0 && target && Math.abs(target.x - e.x) < 480) {
        e.fireTimer = e.type === 'TURRET' ? 58 : 74;
        const angle = Math.atan2(
          target.y + 10 - (e.y + 12),
          target.x + 8 - (e.x + 12)
        );
        state.bullets.push({
          id: state.nextEntityId++,
          owner: 'ENEMY',
          weapon: 'ENEMY_ORB',
          x: e.x + e.width / 2,
          y: e.y + e.height / 2,
          vx: Math.cos(angle) * 3.4,
          vy: Math.sin(angle) * 3.4,
          radius: 3.5,
          damage: 1,
          pierce: false,
          ttl: 120,
        });
      }
    } else if (e.type === 'BOSS_CORE') {
      // Multi-phase Boss Logic
      const hpRatio = e.hp / e.maxHp;
      e.phase = hpRatio > 0.65 ? 1 : hpRatio > 0.3 ? 2 : 3;
      e.y = e.baseY + Math.sin(e.stateTimer * (0.03 * e.phase)) * 28;
      e.fireTimer -= 1;

      if (e.fireTimer <= 0 && target) {
        e.fireTimer = e.phase === 1 ? 54 : e.phase === 2 ? 40 : 28;
        const baseAngle = Math.atan2(
          target.y + 12 - (e.y + 48),
          target.x - e.x
        );
        const fanCount = e.phase === 1 ? 2 : e.phase === 2 ? 3 : 5;
        for (let b = 0; b < fanCount; b++) {
          const offset = (b - (fanCount - 1) / 2) * 0.22;
          state.bullets.push({
            id: state.nextEntityId++,
            owner: 'ENEMY',
            weapon: 'BOSS_PLASMA',
            x: e.x + 8,
            y: e.y + 48,
            vx: Math.cos(baseAngle + offset) * (3.6 + e.phase * 0.4),
            vy: Math.sin(baseAngle + offset) * (3.6 + e.phase * 0.4),
            radius: 5.5,
            damage: 1,
            pierce: false,
            ttl: 140,
          });
        }
      }
    }

    // Contact Damage Against Players
    if (e.type !== 'CAPSULE') {
      for (const p of livingPlayers) {
        if (p.invulnTimer > 0) continue;
        const pTop = p.crouching && p.grounded ? p.y + (PLAYER_HEIGHT - PLAYER_CROUCH_HEIGHT) : p.y;
        const pHeight = p.crouching && p.grounded ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
        if (
          p.x + PLAYER_WIDTH - 3 > e.x &&
          p.x + 3 < e.x + e.width &&
          pTop + pHeight - 3 > e.y &&
          pTop + 3 < e.y + e.height
        ) {
          killPlayer(state, p);
        }
      }
    }
  }
}

function updateBullets(
  state: VortexVMState,
  cartridge: CartridgeDefinition,
  livingPlayers: PlayerEntity[]
): void {
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.ttl -= 1;

    if (
      b.ttl <= 0 ||
      b.x < state.cameraX - 40 ||
      b.x > state.cameraX + INTERNAL_WIDTH + 40 ||
      b.y < -40 ||
      b.y > INTERNAL_HEIGHT + 40
    ) {
      state.bullets.splice(i, 1);
      continue;
    }

    if (b.owner === 'ENEMY') {
      // Check hit against players
      let hitPlayer = false;
      for (const p of livingPlayers) {
        if (p.invulnTimer > 0) continue;
        const pTop =
          p.crouching && p.grounded
            ? p.y + (PLAYER_HEIGHT - PLAYER_CROUCH_HEIGHT)
            : p.y;
        const pHeight =
          p.crouching && p.grounded ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
        if (
          b.x + b.radius > p.x + 3 &&
          b.x - b.radius < p.x + PLAYER_WIDTH - 3 &&
          b.y + b.radius > pTop + 3 &&
          b.y - b.radius < pTop + pHeight - 3
        ) {
          killPlayer(state, p);
          hitPlayer = true;
          break;
        }
      }
      if (hitPlayer) {
        state.bullets.splice(i, 1);
      }
    } else {
      // Player bullet against enemies
      const shooterIdx = b.owner === 'P1' ? 0 : 1;
      let removeBullet = false;

      for (let j = state.enemies.length - 1; j >= 0; j--) {
        const e = state.enemies[j];
        if (
          b.x + b.radius > e.x &&
          b.x - b.radius < e.x + e.width &&
          b.y + b.radius > e.y &&
          b.y - b.radius < e.y + e.height
        ) {
          e.hp -= b.damage;
          spawnParticles(state, b.x, b.y, 4, '#FDE047', 2.0);

          if (!b.pierce) {
            removeBullet = true;
          }

          if (e.hp <= 0) {
            // Enemy Destroyed
            state.players[shooterIdx].score +=
              e.type === 'BOSS_CORE' ? 10000 : e.type === 'MECH_WALKER' ? 800 : 250;
            state.players[shooterIdx].kills += 1;

            if (e.type === 'CAPSULE' && e.dropWeapon) {
              state.pickups.push({
                id: state.nextEntityId++,
                x: e.x,
                y: e.y,
                vx: 1.2,
                vy: -3.2,
                weapon: e.dropWeapon,
                ttl: 600,
              });
            }

            if (e.type === 'BOSS_CORE') {
              state.bossActive = false;
              state.bossDefeated = true;
              state.status = 'VICTORY';
              state.screenShake = 22;
              state.soundEvents.push('EXPLODE_BOSS');
              state.soundEvents.push('VICTORY');
              spawnParticles(state, e.x + e.width / 2, e.y + e.height / 2, 48, '#F59E0B', 5.2);
            } else {
              state.screenShake = Math.max(state.screenShake, 4);
              state.soundEvents.push('EXPLODE_SMALL');
              spawnParticles(state, e.x + e.width / 2, e.y + e.height / 2, 16, '#FB923C', 3.4);
            }

            state.enemies.splice(j, 1);
          } else {
            state.soundEvents.push('HIT_ENEMY');
          }

          if (removeBullet) break;
        }
      }

      if (removeBullet) {
        state.bullets.splice(i, 1);
      }
    }
  }
}

function updateParticles(state: VortexVMState): void {
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const pt = state.particles[i];
    pt.x += pt.vx;
    pt.y += pt.vy;
    pt.vy += 0.12;
    pt.life -= 1;
    if (pt.life <= 0) {
      state.particles.splice(i, 1);
    }
  }
}
