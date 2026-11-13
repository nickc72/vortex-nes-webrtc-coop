import { CartridgeDefinition, PlayerEntity, VortexVMState } from './types';
import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from './vm';

/**
 * VORTEX-16 Picture Processing Unit (PPU) Canvas Renderer
 * Renders multi-layer parallax backgrounds, tilemaps, 8-directional commando sprites,
 * weapon capsules, multi-phase boss cores, and optional hitbox debug overlays at 60fps.
 */
export function renderVortexFrame(
  ctx: CanvasRenderingContext2D,
  state: VortexVMState,
  cartridge: CartridgeDefinition,
  options: { showHitboxes: boolean }
): void {
  ctx.save();

  // Apply screen shake on explosions
  if (state.screenShake > 0) {
    const dx = ((state.frame * 7) % 5) - 2;
    const dy = ((state.frame * 13) % 5) - 2;
    ctx.translate(dx, dy);
  }

  // 1. Sky Gradient Background
  const skyGrad = ctx.createLinearGradient(0, 0, 0, INTERNAL_HEIGHT);
  skyGrad.addColorStop(0, cartridge.palette.skyTop);
  skyGrad.addColorStop(1, cartridge.palette.skyBottom);
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);

  // 2. Parallax Distant Starfield / Industrial Grid
  ctx.fillStyle = 'rgba(241, 245, 249, 0.25)';
  for (let i = 0; i < 36; i++) {
    const sx = ((i * 97 - Math.floor(state.cameraX * 0.15)) % INTERNAL_WIDTH + INTERNAL_WIDTH) % INTERNAL_WIDTH;
    const sy = (i * 43) % 190;
    ctx.fillRect(sx, sy, i % 3 === 0 ? 2 : 1, i % 3 === 0 ? 2 : 1);
  }

  // 3. Parallax Distant Mountain Ridges & Garrison Silhouettes
  ctx.fillStyle = cartridge.palette.distantMountains;
  const mountainScroll = Math.floor(state.cameraX * 0.35);
  for (let m = -1; m < 7; m++) {
    const baseX = m * 160 - (mountainScroll % 160);
    ctx.beginPath();
    ctx.moveTo(baseX, INTERNAL_HEIGHT);
    ctx.lineTo(baseX + 80, 145 + ((m * 29) % 35));
    ctx.lineTo(baseX + 160, INTERNAL_HEIGHT);
    ctx.closePath();
    ctx.fill();
  }

  // Translate World Space by Camera Scroll
  ctx.save();
  ctx.translate(-Math.floor(state.cameraX), 0);

  // 4. Render Platforms & Bridges
  for (const plat of cartridge.platforms) {
    if (plat.x + plat.width < state.cameraX - 20 || plat.x > state.cameraX + INTERNAL_WIDTH + 20) {
      continue;
    }

    if (plat.style === 'WATER_HAZARD') {
      ctx.fillStyle = '#0284C7';
      ctx.fillRect(plat.x, plat.y, plat.width, plat.height);
      ctx.fillStyle = '#38BDF8';
      for (let wx = plat.x; wx < plat.x + plat.width; wx += 16) {
        const waveY = plat.y + Math.sin((wx + state.frame * 2) * 0.08) * 2;
        ctx.fillRect(wx, waveY, 10, 3);
      }
    } else if (plat.style === 'JUNGLE_GRASS') {
      // Deep soil / rock body
      ctx.fillStyle = '#3F2E21';
      ctx.fillRect(plat.x, plat.y + 6, plat.width, plat.height - 6);
      // Brick/rock texture lines
      ctx.fillStyle = '#291D15';
      for (let rx = plat.x; rx < plat.x + plat.width; rx += 24) {
        ctx.fillRect(rx, plat.y + 10, 2, plat.height - 10);
      }
      // Lush pixel jungle turf top
      ctx.fillStyle = '#16A34A';
      ctx.fillRect(plat.x, plat.y, plat.width, 6);
      ctx.fillStyle = '#4ADE80';
      ctx.fillRect(plat.x, plat.y, plat.width, 2);
    } else if (plat.style === 'STEEL_BRIDGE') {
      ctx.fillStyle = '#475569';
      ctx.fillRect(plat.x, plat.y, plat.width, plat.height);
      ctx.fillStyle = '#F59E0B';
      for (let bx = plat.x; bx < plat.x + plat.width; bx += 20) {
        ctx.fillRect(bx, plat.y + 2, 10, 3);
      }
    } else {
      // BUNKER_METAL
      ctx.fillStyle = '#1E293B';
      ctx.fillRect(plat.x, plat.y, plat.width, plat.height);
      ctx.fillStyle = '#64748B';
      ctx.fillRect(plat.x, plat.y, plat.width, 4);
      for (let rx = plat.x + 8; rx < plat.x + plat.width - 8; rx += 32) {
        ctx.fillStyle = '#38BDF8';
        ctx.fillRect(rx, plat.y + 8, 4, 4);
      }
    }
  }

  // 5. Render Power-Up Pickups (Classic Falcon Badge Style)
  for (const pk of state.pickups) {
    ctx.fillStyle = '#DC2626';
    ctx.fillRect(pk.x, pk.y, 18, 14);
    ctx.strokeStyle = '#FDE047';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pk.x, pk.y, 18, 14);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.fillText(pk.weapon.charAt(0), pk.x + 5, pk.y + 11);
  }

  // 6. Render Enemies & Multi-Phase Boss Core
  for (const e of state.enemies) {
    if (e.type === 'CAPSULE') {
      ctx.fillStyle = '#94A3B8';
      ctx.fillRect(e.x, e.y, e.width, e.height);
      ctx.fillStyle = '#EF4444';
      ctx.fillRect(e.x + 4, e.y + 3, e.width - 8, e.height - 6);
      ctx.fillStyle = '#FDE047';
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.fillText(e.dropWeapon ? e.dropWeapon.charAt(0) : 'S', e.x + 8, e.y + 11);
    } else if (e.type === 'TURRET') {
      ctx.fillStyle = '#475569';
      ctx.fillRect(e.x, e.y, e.width, e.height);
      ctx.fillStyle = '#CBD5E1';
      ctx.fillRect(e.x + 4, e.y + 4, e.width - 8, e.height - 8);
      ctx.fillStyle = '#EF4444';
      ctx.fillRect(e.x + 9, e.y + 9, 8, 8);
    } else if (e.type === 'MECH_WALKER') {
      ctx.fillStyle = '#334155';
      ctx.fillRect(e.x, e.y, e.width, e.height);
      ctx.fillStyle = '#F59E0B';
      ctx.fillRect(e.x + 4, e.y + 6, 12, 8);
      // HP Bar
      ctx.fillStyle = '#0F172A';
      ctx.fillRect(e.x, e.y - 7, e.width, 4);
      ctx.fillStyle = '#EF4444';
      ctx.fillRect(e.x, e.y - 7, (e.hp / e.maxHp) * e.width, 4);
    } else if (e.type === 'BOSS_CORE') {
      // Armored Garrison Wall + Glowing Pulsing Core
      ctx.fillStyle = '#1E293B';
      ctx.fillRect(e.x, e.y, e.width, e.height);
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 2;
      ctx.strokeRect(e.x, e.y, e.width, e.height);

      const coreColor =
        e.phase === 1 ? '#38BDF8' : e.phase === 2 ? '#F59E0B' : '#F43F5E';
      ctx.fillStyle = coreColor;
      ctx.fillRect(e.x + 12, e.y + 32, 32, 36);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(e.x + 20, e.y + 42, 16, 16);
    } else {
      // RUNNER or SNIPER
      ctx.fillStyle = e.type === 'SNIPER' ? '#A855F7' : '#22C55E';
      ctx.fillRect(e.x, e.y + 6, e.width, e.height - 6);
      ctx.fillStyle = '#FDBA74';
      ctx.fillRect(e.x + 3, e.y, 12, 8);
      ctx.fillStyle = '#EF4444';
      ctx.fillRect(e.x + 2, e.y, 14, 3);
    }

    if (options.showHitboxes) {
      ctx.strokeStyle = '#F43F5E';
      ctx.lineWidth = 1;
      ctx.strokeRect(e.x, e.y, e.width, e.height);
    }
  }

  // 7. Render Players (P1 Cobalt Commando, P2 Crimson Commando)
  for (const p of state.players) {
    if (!p.active || p.lives <= 0 || p.respawnTimer > 0) continue;
    if (p.invulnTimer > 0 && Math.floor(p.invulnTimer / 3) % 2 === 0) continue;
    drawCommandoSprite(ctx, p, options.showHitboxes);
  }

  // 8. Render Projectiles
  for (const b of state.bullets) {
    if (b.owner === 'ENEMY') {
      ctx.fillStyle = b.weapon === 'BOSS_PLASMA' ? '#F43F5E' : '#FB923C';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FEF08A';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius * 0.45, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle =
        b.weapon === 'LASER'
          ? '#38BDF8'
          : b.weapon === 'SPREAD'
          ? '#F43F5E'
          : b.weapon === 'CRUSH'
          ? '#A855F7'
          : '#FDE047';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 9. Render Particles
  for (const pt of state.particles) {
    ctx.fillStyle = pt.color;
    ctx.globalAlpha = Math.max(0, pt.life / pt.maxLife);
    ctx.fillRect(pt.x, pt.y, pt.size, pt.size);
  }
  ctx.globalAlpha = 1;

  ctx.restore(); // End Camera World Space

  // 10. Render In-Canvas Arcade Top HUD (1P / 2P Lives, Active Weapon, Score, Boss Bar)
  drawInCanvasHUD(ctx, state, cartridge);

  ctx.restore();
}

function drawCommandoSprite(
  ctx: CanvasRenderingContext2D,
  p: PlayerEntity,
  showHitbox: boolean
): void {
  const isP1 = p.index === 0;
  const primaryColor = isP1 ? '#38BDF8' : '#F43F5E';
  const bandanaColor = isP1 ? '#EF4444' : '#FACC15';

  const drawY = p.crouching && p.grounded ? p.y + 14 : p.y;
  const drawH = p.crouching && p.grounded ? 18 : 32;

  // Boots & Legs
  ctx.fillStyle = '#1E293B';
  if (!p.crouching) {
    const legOffset = Math.sin(p.animTick * 0.35) * 3;
    ctx.fillRect(p.x + 2, p.y + 22, 6, 10 + (p.vx !== 0 ? legOffset : 0));
    ctx.fillRect(p.x + 10, p.y + 22, 6, 10 - (p.vx !== 0 ? legOffset : 0));
  }

  // Torso Armor / Vest
  ctx.fillStyle = primaryColor;
  ctx.fillRect(p.x + 2, drawY + 8, 14, drawH - 12);

  // Head & Bandana
  ctx.fillStyle = '#FDBA74';
  ctx.fillRect(p.x + 4, drawY, 10, 8);
  ctx.fillStyle = bandanaColor;
  ctx.fillRect(p.x + 3, drawY + 1, 12, 3);

  // Rifle Barrel Pointing in 8-Direction Aim
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 3;
  ctx.beginPath();
  const cx = p.x + 9;
  const cy = drawY + 11;
  ctx.moveTo(cx, cy);
  const barrelLen = 14;
  const diag = 0.707;
  let tx = cx + p.facing * barrelLen;
  let ty = cy;

  switch (p.aimDir) {
    case 'UP':
      tx = cx;
      ty = cy - barrelLen;
      break;
    case 'DOWN':
      tx = cx;
      ty = cy + barrelLen;
      break;
    case 'UP_RIGHT':
      tx = cx + barrelLen * diag;
      ty = cy - barrelLen * diag;
      break;
    case 'UP_LEFT':
      tx = cx - barrelLen * diag;
      ty = cy - barrelLen * diag;
      break;
    case 'DOWN_RIGHT':
      tx = cx + barrelLen * diag;
      ty = cy + barrelLen * diag;
      break;
    case 'DOWN_LEFT':
      tx = cx - barrelLen * diag;
      ty = cy + barrelLen * diag;
      break;
    case 'LEFT':
      tx = cx - barrelLen;
      ty = cy;
      break;
    case 'RIGHT':
      tx = cx + barrelLen;
      ty = cy;
      break;
  }
  ctx.lineTo(tx, ty);
  ctx.stroke();

  if (showHitbox) {
    ctx.strokeStyle = '#10B981';
    ctx.lineWidth = 1;
    ctx.strokeRect(p.x, drawY, 18, drawH);
  }
}

function drawInCanvasHUD(
  ctx: CanvasRenderingContext2D,
  state: VortexVMState,
  cartridge: CartridgeDefinition
): void {
  // Subtle top bar scrim inside the game canvas
  ctx.fillStyle = 'rgba(11, 15, 23, 0.72)';
  ctx.fillRect(0, 0, INTERNAL_WIDTH, 28);

  ctx.font = 'bold 11px "JetBrains Mono", monospace';

  // Player 1 HUD
  const p1 = state.players[0];
  ctx.fillStyle = '#38BDF8';
  ctx.fillText(
    `1P SCORE ${String(p1.score).padStart(6, '0')} · LIVES ${Math.max(0, p1.lives)} · WPN [${p1.weapon}]`,
    12,
    18
  );

  // Player 2 HUD
  const p2 = state.players[1];
  if (p2.active) {
    ctx.fillStyle = '#F43F5E';
    ctx.fillText(
      `2P SCORE ${String(p2.score).padStart(6, '0')} · LIVES ${Math.max(0, p2.lives)} · WPN [${p2.weapon}]`,
      336,
      18
    );
  } else {
    ctx.fillStyle = '#94A3B8';
    ctx.fillText('2P STANDBY (JOIN CO-OP OR ENABLE 2P)', 375, 18);
  }

  // Boss Health Bar if Boss Active
  const boss = state.enemies.find((e) => e.type === 'BOSS_CORE');
  if (boss) {
    const barW = 260;
    const barX = (INTERNAL_WIDTH - barW) / 2;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(barX - 4, 34, barW + 8, 18);
    ctx.fillStyle = '#F43F5E';
    ctx.fillRect(barX, 38, Math.max(0, (boss.hp / boss.maxHp) * barW), 10);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.fillText(`${cartridge.bossConfig.name} (PHASE ${boss.phase})`, barX + 8, 46);
  }

  // Victory / Game Over Banner
  if (state.status !== 'PLAYING') {
    ctx.fillStyle = 'rgba(11, 15, 23, 0.82)';
    ctx.fillRect(140, 125, 360, 100);
    ctx.strokeStyle = state.status === 'VICTORY' ? '#10B981' : '#F43F5E';
    ctx.lineWidth = 2;
    ctx.strokeRect(140, 125, 360, 100);

    ctx.fillStyle = state.status === 'VICTORY' ? '#10B981' : '#F43F5E';
    ctx.font = 'bold 24px "Barlow Condensed", sans-serif';
    ctx.fillText(
      state.status === 'VICTORY'
        ? 'SECTOR CLEARED · MISSION ACCOMPLISHED'
        : 'SQUAD WIPED · MISSION FAILED',
      175,
      165
    );

    ctx.fillStyle = '#E2E8F0';
    ctx.font = '12px "JetBrains Mono", monospace';
    ctx.fillText('Click "Reset Cartridge" below to redeploy immediately.', 168, 198);
  }
}
