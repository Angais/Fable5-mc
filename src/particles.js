// ============================================================
// Particles — pooled billboard quads in a single dynamic
// BufferGeometry (one draw call). Each particle samples a
// random 4x4-pixel patch of the broken block's texture, just
// like Minecraft's digging particles. Rendered with the chunk
// material so they obey day/night lighting.
// ============================================================

import * as THREE from 'three';
import { BLOCKS } from './blocks.js';
import { atlasUV } from './textures.js';

const MAX = 320;
const GRAVITY = 15;

export class Particles {
  constructor(scene, material) {
    this.list = [];
    this.pos = new Float32Array(MAX * 4 * 3);
    this.uv = new Float32Array(MAX * 4 * 2);
    this.col = new Float32Array(MAX * 4 * 3);

    const index = new Uint16Array(MAX * 6);
    for (let i = 0; i < MAX; i++) {
      const b = i * 4;
      index.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // never culled

    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);

    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
  }

  spawn(x, y, z, id, count, speed = 2.6) {
    const def = BLOCKS[id];
    if (!def || !def.tex) return;
    const rect = atlasUV(def.tex.px || def.tex.py);
    const uw = rect.u1 - rect.u0, vw = rect.v1 - rect.v0;
    for (let i = 0; i < count; i++) {
      if (this.list.length >= MAX) this.list.shift();
      const u0 = rect.u0 + Math.random() * 0.75 * uw;
      const v0 = rect.v0 + Math.random() * 0.75 * vw;
      const ang = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.35;
      this.list.push({
        x: x + 0.5 + Math.cos(ang) * r,
        y: y + 0.4 + Math.random() * 0.4,
        z: z + 0.5 + Math.sin(ang) * r,
        vx: Math.cos(ang) * speed * (0.3 + Math.random() * 0.7),
        vy: speed * (0.5 + Math.random() * 0.8),
        vz: Math.sin(ang) * speed * (0.3 + Math.random() * 0.7),
        life: 0.35 + Math.random() * 0.5,
        size: 0.055 + Math.random() * 0.05,
        u0, v0,
        u1: u0 + uw * 0.25,
        v1: v0 + vw * 0.25,
        shade: 0.65 + Math.random() * 0.35,
      });
    }
  }

  spawnBlockBreak(x, y, z, id) { this.spawn(x, y, z, id, 18); }

  spawnExplosion(x, y, z, ids) {
    for (let i = 0; i < 5; i++) {
      const id = ids[(Math.random() * ids.length) | 0];
      this.spawn(
        x + (Math.random() - 0.5) * 3,
        y + (Math.random() - 0.5) * 3,
        z + (Math.random() - 0.5) * 3,
        id, 8, 6,
      );
    }
  }

  update(dt, camera) {
    const list = this.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= dt;
      if (p.life <= 0) { list.splice(i, 1); continue; }
      p.vy -= GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vx *= 1 - 1.5 * dt;
      p.vz *= 1 - 1.5 * dt;
    }

    // billboard quads
    this._right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const R = this._right, U = this._up;
    const pos = this.pos, uv = this.uv, col = this.col;

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const s = p.size;
      const b3 = i * 12, b2 = i * 8;
      // 4 corners: (-R-U, +R-U, +R+U, -R+U)
      pos[b3] = p.x - R.x * s - U.x * s; pos[b3 + 1] = p.y - R.y * s - U.y * s; pos[b3 + 2] = p.z - R.z * s - U.z * s;
      pos[b3 + 3] = p.x + R.x * s - U.x * s; pos[b3 + 4] = p.y + R.y * s - U.y * s; pos[b3 + 5] = p.z + R.z * s - U.z * s;
      pos[b3 + 6] = p.x + R.x * s + U.x * s; pos[b3 + 7] = p.y + R.y * s + U.y * s; pos[b3 + 8] = p.z + R.z * s + U.z * s;
      pos[b3 + 9] = p.x - R.x * s + U.x * s; pos[b3 + 10] = p.y - R.y * s + U.y * s; pos[b3 + 11] = p.z - R.z * s + U.z * s;
      uv[b2] = p.u0; uv[b2 + 1] = p.v0;
      uv[b2 + 2] = p.u1; uv[b2 + 3] = p.v0;
      uv[b2 + 4] = p.u1; uv[b2 + 5] = p.v1;
      uv[b2 + 6] = p.u0; uv[b2 + 7] = p.v1;
      for (let c = 0; c < 4; c++) {
        col[b3 + c * 3] = p.shade; // skylight channel
        col[b3 + c * 3 + 1] = 0.15; // tiny torch-ish fill so they read at night
        col[b3 + c * 3 + 2] = 0;
      }
    }

    this.geo.setDrawRange(0, list.length * 6);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}
