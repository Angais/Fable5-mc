// ============================================================
// Player — Minecraft-tuned first person physics:
// AABB vs voxel collision (per-axis sweep, fixed substeps),
// walking / sprinting (with FOV kick handled by main) /
// sneaking with edge-guard / jumping / swimming / creative
// flight, plus footstep & landing events for the audio system.
// Also: Amanatides-Woo voxel raycast for targeting blocks.
// ============================================================

import * as THREE from 'three';
import { B, BLOCKS } from './blocks.js';
import { WORLD_H } from './worldgen.js';

const HALF = 0.3;            // half width of the player AABB
const HEIGHT = 1.8;          // standing height
const EYE_STAND = 1.62;
const EYE_SNEAK = 1.32;
const GRAVITY = 32;
const JUMP_V = 8.94;         // ~1.25 block jump
const TERMINAL = 72;
const EPS = 0.001;

const SPEED_WALK = 4.317;
const SPEED_SPRINT = 5.612;
const SPEED_SNEAK = 1.31;
const SPEED_FLY = 10.9;
const SPEED_FLY_SPRINT = 19;
const FLY_VERT = 9;
const SPEED_WATER = 2.6;

const SUBSTEP = 1 / 120;

const isSolidId = (id) => BLOCKS[id] ? BLOCKS[id].solid : false;

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = new THREE.Vector3(0.5, 80, 0.5); // feet center
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.onGround = false;
    this.flying = false;
    this.sprinting = false;
    this.sneaking = false;
    this.inWater = false;
    this.headInWater = false;
    this.hitWall = false;
    this.eyeHeight = EYE_STAND;

    this.walkCycle = 0;     // accumulates with horizontal travel (view bob)
    this.bobStrength = 0;   // 0..1, eases in/out with movement
    this.stepAccum = 0;
    this.events = [];       // {type, id?, impact?} drained by main
  }

  teleport(x, y, z) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
  }

  eyePosition(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
  }

  /** Forward look vector from yaw/pitch. */
  lookDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp).normalize();
  }

  // ----------------------------------------------------------
  // Per-frame update (fixed substeps inside)
  // ----------------------------------------------------------

  update(dt, input) {
    dt = Math.min(dt, 0.1);
    while (dt > 1e-6) {
      const h = Math.min(dt, SUBSTEP);
      this.step(h, input);
      dt -= h;
    }
    // eye height eases between stand/sneak
    const targetEye = this.sneaking && !this.flying ? EYE_SNEAK : EYE_STAND;
    this.eyeHeight += (targetEye - this.eyeHeight) * 0.35;
  }

  step(h, input) {
    const wasOnGround = this.onGround;
    const wasInWater = this.inWater;
    const prevVy = this.vel.y;

    // ---- water state ----
    const feetId = this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.2), Math.floor(this.pos.z));
    const midId = this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 1.0), Math.floor(this.pos.z));
    const eyeId = this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + this.eyeHeight), Math.floor(this.pos.z));
    this.inWater = feetId === B.WATER || midId === B.WATER;
    this.headInWater = eyeId === B.WATER;

    this.sneaking = input.sneak && !this.flying;

    // ---- wish direction (camera-relative, horizontal) ----
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let fx = 0, fz = 0;
    if (input.forward) { fx -= sin; fz -= cos; }
    if (input.back) { fx += sin; fz += cos; }
    if (input.left) { fx -= cos; fz += sin; }
    if (input.right) { fx += cos; fz -= sin; }
    const wl = Math.hypot(fx, fz);
    if (wl > 0) { fx /= wl; fz /= wl; }

    // ---- target speed ----
    let speed;
    if (this.flying) speed = this.sprinting ? SPEED_FLY_SPRINT : SPEED_FLY;
    else if (this.inWater) speed = this.sprinting ? SPEED_WATER * 1.45 : SPEED_WATER;
    else if (this.sneaking) speed = SPEED_SNEAK;
    else if (this.sprinting) speed = SPEED_SPRINT;
    else speed = SPEED_WALK;

    // ---- horizontal acceleration ----
    const accel = this.flying ? 9 : this.inWater ? 7 : this.onGround ? 16 : 3.2;
    const k = Math.min(1, accel * h);
    this.vel.x += (fx * speed - this.vel.x) * k;
    this.vel.z += (fz * speed - this.vel.z) * k;

    // ---- vertical movement ----
    if (this.flying) {
      const targetY = input.jump ? FLY_VERT : input.sneak ? -FLY_VERT : 0;
      this.vel.y += (targetY - this.vel.y) * Math.min(1, 11 * h);
    } else if (this.inWater) {
      this.vel.y -= 10 * h;                       // weak gravity
      this.vel.y *= Math.max(0, 1 - 2.4 * h);     // water drag
      if (input.jump) this.vel.y = Math.min(this.vel.y + 42 * h, 3.6);
      // hop out of the water when pushing against an edge
      if (input.jump && this.hitWall && !this.headInWater) {
        this.vel.y = Math.max(this.vel.y, 5.4);
      }
    } else {
      this.vel.y -= GRAVITY * h;
      if (this.vel.y < -TERMINAL) this.vel.y = -TERMINAL;
      if (input.jump && this.onGround) {
        this.vel.y = JUMP_V;
        if (this.sprinting && wl > 0) { // sprint-jump boost
          this.vel.x += fx * 1.4;
          this.vel.z += fz * 1.4;
        }
        this.events.push({ type: 'jump' });
      }
    }

    // ---- integrate + collide (Y first, then X/Z) ----
    this.onGround = false;
    this.hitWall = false;
    this.moveAxis(1, this.vel.y * h);
    // sticky ground: tiny drift around the collision epsilon must not
    // flicker the grounded state (jumping, footsteps, sneak guard rely on it)
    if (!this.onGround && this.vel.y <= 0 && !this.flying && this.hasSupportBelow()) {
      this.onGround = true;
    }

    const guard = this.sneaking && wasOnGround && !this.flying && !this.inWater;
    this.moveAxisGuarded(0, this.vel.x * h, guard);
    this.moveAxisGuarded(2, this.vel.z * h, guard);

    // ---- events ----
    if (!wasOnGround && this.onGround && prevVy < -9) {
      this.events.push({ type: 'land', impact: -prevVy, id: this.blockBelow() });
    }
    if (!wasInWater && this.inWater && prevVy < -4) {
      this.events.push({ type: 'splash' });
    }

    // footsteps + view-bob bookkeeping
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hSpeed > 0.6) {
      this.walkCycle += hSpeed * h * 1.6;
      this.bobStrength = Math.min(1, this.bobStrength + 6 * h);
      this.stepAccum += hSpeed * h;
      const stride = this.sprinting ? 2.6 : 2.1;
      if (this.stepAccum > stride) {
        this.stepAccum = 0;
        const below = this.blockBelow();
        if (below !== B.AIR) this.events.push({ type: 'step', id: below });
      }
    } else {
      this.bobStrength = Math.max(0, this.bobStrength - 6 * h);
    }
  }

  blockBelow() {
    return this.world.getBlock(
      Math.floor(this.pos.x),
      Math.floor(this.pos.y - 0.05),
      Math.floor(this.pos.z),
    );
  }

  // ----------------------------------------------------------
  // Collision
  // ----------------------------------------------------------

  moveAxisGuarded(axis, amount, guard) {
    if (guard) {
      const before = axis === 0 ? this.pos.x : this.pos.z;
      this.moveAxis(axis, amount);
      if (!this.hasSupportBelow()) {
        // sneaking: don't walk off edges
        if (axis === 0) { this.pos.x = before; this.vel.x = 0; }
        else { this.pos.z = before; this.vel.z = 0; }
      }
    } else {
      this.moveAxis(axis, amount);
    }
  }

  moveAxis(axis, amount) {
    if (amount === 0) return;
    if (axis === 0) this.pos.x += amount;
    else if (axis === 1) this.pos.y += amount;
    else this.pos.z += amount;

    const minX = this.pos.x - HALF, maxX = this.pos.x + HALF;
    const minY = this.pos.y, maxY = this.pos.y + HEIGHT;
    const minZ = this.pos.z - HALF, maxZ = this.pos.z + HALF;

    const x0 = Math.floor(minX), x1 = Math.floor(maxX - 1e-9);
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(WORLD_H - 1, Math.floor(maxY - 1e-9));
    const z0 = Math.floor(minZ), z1 = Math.floor(maxZ - 1e-9);

    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (let bx = x0; bx <= x1; bx++) {
          if (!isSolidId(this.world.getBlock(bx, by, bz))) continue;
          if (axis === 1) {
            if (amount < 0) {
              this.pos.y = Math.max(this.pos.y, by + 1 + EPS);
              this.vel.y = 0;
              this.onGround = true;
            } else {
              this.pos.y = Math.min(this.pos.y, by - HEIGHT - EPS);
              this.vel.y = 0;
            }
          } else if (axis === 0) {
            if (amount > 0) this.pos.x = Math.min(this.pos.x, bx - HALF - EPS);
            else this.pos.x = Math.max(this.pos.x, bx + 1 + HALF + EPS);
            this.vel.x = 0;
            this.hitWall = true;
          } else {
            if (amount > 0) this.pos.z = Math.min(this.pos.z, bz - HALF - EPS);
            else this.pos.z = Math.max(this.pos.z, bz + 1 + HALF + EPS);
            this.vel.z = 0;
            this.hitWall = true;
          }
        }
      }
    }
  }

  hasSupportBelow() {
    const y = Math.floor(this.pos.y - 0.06);
    if (y < 0) return false;
    const x0 = Math.floor(this.pos.x - HALF), x1 = Math.floor(this.pos.x + HALF - 1e-9);
    const z0 = Math.floor(this.pos.z - HALF), z1 = Math.floor(this.pos.z + HALF - 1e-9);
    for (let bz = z0; bz <= z1; bz++)
      for (let bx = x0; bx <= x1; bx++)
        if (isSolidId(this.world.getBlock(bx, y, bz))) return true;
    return false;
  }

  /** Would a solid block placed at this cell overlap the player? */
  intersectsCell(bx, by, bz) {
    return (
      bx + 1 > this.pos.x - HALF && bx < this.pos.x + HALF &&
      bz + 1 > this.pos.z - HALF && bz < this.pos.z + HALF &&
      by + 1 > this.pos.y && by < this.pos.y + HEIGHT
    );
  }
}

// ------------------------------------------------------------
// Voxel raycast (Amanatides & Woo DDA)
// ------------------------------------------------------------

/**
 * Walks the voxel grid along a ray. Returns the first block that is
 * targetable (anything but air and water), with the face normal that
 * was entered, or null.
 */
export function raycastVoxel(world, origin, dir, maxDist) {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);

  const stepX = dir.x > 0 ? 1 : dir.x < 0 ? -1 : 0;
  const stepY = dir.y > 0 ? 1 : dir.y < 0 ? -1 : 0;
  const stepZ = dir.z > 0 ? 1 : dir.z < 0 ? -1 : 0;

  const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;

  let tMaxX = stepX > 0 ? (x + 1 - origin.x) * tDeltaX : stepX < 0 ? (origin.x - x) * tDeltaX : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - origin.y) * tDeltaY : stepY < 0 ? (origin.y - y) * tDeltaY : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - origin.z) * tDeltaZ : stepZ < 0 ? (origin.z - z) * tDeltaZ : Infinity;

  let nx = 0, ny = 0, nz = 0;
  let t = 0;

  for (let i = 0; i < 256; i++) {
    const id = world.getBlock(x, y, z);
    if (id !== B.AIR && id !== B.WATER) {
      return { x, y, z, nx, ny, nz, id, dist: t };
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      t = tMaxX; tMaxX += tDeltaX; x += stepX; nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      t = tMaxY; tMaxY += tDeltaY; y += stepY; ny = -stepY; nx = 0; nz = 0;
    } else {
      t = tMaxZ; tMaxZ += tDeltaZ; z += stepZ; nz = -stepZ; nx = 0; ny = 0;
    }
    if (t > maxDist) return null;
  }
  return null;
}
