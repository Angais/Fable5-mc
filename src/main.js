// ============================================================
// Main — bootstraps the renderer, owns the game state machine
// (title → loading → playing ⇄ paused), wires input, mining /
// placing with crack overlay & block outline, the first-person
// held block, support/gravity checks, saving to localStorage,
// the F3 debug screen and the render loop.
// ============================================================

import * as THREE from 'three';
import {
  buildAtlasCanvas, buildCrackCanvases, buildWaterCanvas, tileIconCanvas,
} from './textures.js';
import { B, BLOCKS, PALETTE, DEFAULT_HOTBAR } from './blocks.js';
import { CHUNK, WORLD_H, BIOME_NAMES } from './worldgen.js';
import { World } from './world.js';
import { Player, raycastVoxel } from './player.js';
import { buildBlockGeometry } from './mesher.js';
import { Sky } from './sky.js';
import { Particles } from './particles.js';
import { AudioFX } from './audio.js';
import { Entities } from './entities.js';
import { UI } from './ui.js';
import { hashString } from './noise.js';

const SETTINGS_KEY = 'mcjs:settings';
const WORLD_KEY = 'mcjs:world';
const REACH = 5;

const DEFAULT_SETTINGS = {
  render: 7, fov: 70, sens: 100, vol: 70,
  bob: true, clouds: true, music: true, smooth: true,
};

const loadJSON = (k) => {
  try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
};
const saveJSON = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ }
};

class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.settings = { ...DEFAULT_SETTINGS, ...(loadJSON(SETTINGS_KEY) || {}) };
    this.saveData = loadJSON(WORLD_KEY);

    // ---------- UI ----------
    this.ui = new UI({
      onPlay: () => this.play(),
      onNewWorld: (seedStr) => this.newWorld(seedStr),
      onResume: () => this.resume(),
      onQuit: () => this.quitToTitle(),
      onSetting: (k, v) => this.applySetting(k, v),
      getSettings: () => this.settings,
      onPickBlock: (id) => this.assignBlock(id),
      onHotbarSelect: (i) => { this.selectSlot(i); },
      onUiClick: () => { this.audio.ensure(); this.audio.click(); },
    });

    // ---------- renderer ----------
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, antialias: false, powerPreference: 'high-performance',
      });
    } catch (e) {
      this.ui.showWebglError();
      throw e;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.autoClear = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.1, 1500);
    this.camera.rotation.order = 'YXZ';
    this.fovCurrent = this.settings.fov;

    // global light uniforms shared by every world material
    this.uniforms = { uDayLight: { value: 1 }, uMinLight: { value: 0.05 } };

    // ---------- textures & materials ----------
    const atlasTex = new THREE.CanvasTexture(buildAtlasCanvas());
    atlasTex.magFilter = THREE.NearestFilter;
    atlasTex.minFilter = THREE.NearestFilter;
    atlasTex.generateMipmaps = false;
    atlasTex.colorSpace = THREE.SRGBColorSpace;
    this.atlasTex = atlasTex;

    const waterTex = new THREE.CanvasTexture(buildWaterCanvas());
    waterTex.magFilter = THREE.NearestFilter;
    waterTex.minFilter = THREE.NearestFilter;
    waterTex.generateMipmaps = false;
    waterTex.wrapS = waterTex.wrapT = THREE.RepeatWrapping;
    waterTex.colorSpace = THREE.SRGBColorSpace;
    this.waterTex = waterTex;

    this.materials = {
      solid: this.makeWorldMaterial({ map: atlasTex, alphaTest: 0.5 }),
      water: this.makeWorldMaterial({
        map: waterTex, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide,
      }),
    };

    // ---------- target outline + crack overlay ----------
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.75 }),
    );
    this.outline.visible = false;
    this.scene.add(this.outline);

    this.crackTextures = buildCrackCanvases().map((c) => {
      const t = new THREE.CanvasTexture(c);
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      return t;
    });
    this.crackMat = new THREE.MeshBasicMaterial({
      map: this.crackTextures[0], transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.crack = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), this.crackMat);
    this.crack.visible = false;
    this.scene.add(this.crack);

    // ---------- subsystems ----------
    this.audio = new AudioFX();
    this.audio.setVolume(this.settings.vol / 100);
    this.audio.setMusicOn(this.settings.music);

    this.sky = new Sky(this.scene, this.uniforms);
    this.sky.setViewDistance(this.settings.render);
    this.sky.setCloudsVisible(this.settings.clouds);

    this.particles = new Particles(this.scene, this.materials.solid);
    this.entities = new Entities({
      scene: this.scene, world: null, particles: this.particles,
      audio: this.audio, material: this.materials.solid,
    });
    this.entities.getPlayer = () => this.player;
    this.entities.onExplosion = (x, y, z) => {
      this.shakeT = Math.max(this.shakeT, 0.45);
      const d = this.player.pos.distanceTo(new THREE.Vector3(x, y, z));
      if (d < 7) this.ui.flashDamage();
    };

    // ---------- held block (separate pass over the world) ----------
    this.handScene = new THREE.Scene();
    this.handCamera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.01, 10);
    this.handGroup = new THREE.Group();
    this.handScene.add(this.handGroup);
    this.heldMesh = null;
    this.heldGeoCache = new Map();
    this.swingT = 1;  // 1 = idle
    this.dipT = 1;

    // ---------- inventory state ----------
    this.hotbar = [...DEFAULT_HOTBAR];
    this.selected = 0;
    if (this.saveData?.hotbar?.length === 9) this.hotbar = this.saveData.hotbar.slice();
    if (Number.isInteger(this.saveData?.slot)) this.selected = this.saveData.slot;

    // ---------- icons ----------
    this.icons = this.makeIcons();
    this.ui.setIcons(this.icons);
    this.ui.updateHotbar(this.hotbar, this.selected);

    // ---------- game state ----------
    this.state = 'title';
    this.pickerOpen = false;
    this.locked = false;
    this.keys = new Set();
    this.sprintLatch = false;
    this.lastW = 0;
    this.lastSpace = 0;
    this.mining = false;
    this.miningCell = null;
    this.miningProgress = 0;
    this.placeTimer = 0;
    this.rmbHeld = false;
    this.shakeT = 0;
    this.debugVisible = false;
    this.debugTimer = 0;
    this.autosaveTimer = 0;
    this.titleAngle = Math.random() * Math.PI * 2;
    this.fps = 0;
    this.fpsAccum = 0;
    this.fpsFrames = 0;
    this.lastDrawInfo = { calls: 0, triangles: 0 };

    const seed = this.saveData?.seed ?? ((Math.random() * 0xffffffff) >>> 0);
    this.createWorld(seed, this.saveData?.edits, this.saveData?.player);
    this.ui.setSeedPlaceholder(this.worldSeed);

    this.bindInput();
    this.lastT = performance.now();
    this._rafPending = false;
    this.scheduleFrame();
    // RAF is suspended in hidden/occluded tabs; this watchdog keeps the
    // simulation (loading, autosave, time of day) ticking at ~10 Hz there.
    setInterval(() => {
      if (performance.now() - this.lastT > 350) this.frame(performance.now());
    }, 100);
  }

  scheduleFrame() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame((t) => { this._rafPending = false; this.frame(t); });
  }

  // ============================================================
  // Materials (day/night + torch light shader injection)
  // ============================================================

  makeWorldMaterial(params) {
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, ...params });
    const uniforms = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uDayLight = uniforms.uDayLight;
      shader.uniforms.uMinLight = uniforms.uMinLight;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          'uniform float uDayLight;\nuniform float uMinLight;\n#include <common>',
        )
        .replace(
          '#include <color_fragment>',
          `#if defined( USE_COLOR )
            vec3 mcLight = max(vec3(vColor.r * uDayLight), vec3(1.0, 0.82, 0.55) * vColor.g);
            mcLight = max(mcLight, vec3(uMinLight));
            diffuseColor.rgb *= mcLight;
          #endif`,
        );
    };
    mat.customProgramCacheKey = () => 'mc-world-light';
    return mat;
  }

  // ============================================================
  // World / player lifecycle
  // ============================================================

  createWorld(seed, edits, savedPlayer) {
    if (this.world) {
      this.world.dispose();
      this.entities.clear();
    }
    this.worldSeed = seed >>> 0;
    this.world = new World({
      seed: this.worldSeed,
      scene: this.scene,
      materials: this.materials,
      viewRadius: this.settings.render,
      smoothLighting: this.settings.smooth,
    });
    if (edits) this.world.loadEdits(edits);
    this.entities.setWorld(this.world);

    this.player = new Player(this.world);
    this.spawn = this.world.gen.findSpawn();
    this.usedSavedPos = false;
    if (savedPlayer) {
      this.player.teleport(savedPlayer.x, savedPlayer.y, savedPlayer.z);
      this.player.yaw = savedPlayer.yaw || 0;
      this.player.pitch = savedPlayer.pitch || 0;
      this.player.flying = !!savedPlayer.flying;
      this.usedSavedPos = true;
    } else {
      this.player.teleport(this.spawn.x, this.spawn.y + 1, this.spawn.z);
    }
    this.sky.setTimeOfDay(this.saveData?.time ?? 0.1); // fresh worlds start mid-morning
  }

  parseSeed(str) {
    if (!str) return (Math.random() * 0xffffffff) >>> 0;
    if (/^-?\d+$/.test(str)) return Number(str) >>> 0;
    return hashString(str);
  }

  // ============================================================
  // State machine
  // ============================================================

  play() {
    this.audio.ensure();
    this.ui.hideAllMenus();
    this.ui.show('loading');
    this.state = 'loading';
    this.lockPointer();
  }

  newWorld(seedStr) {
    const seed = this.parseSeed(seedStr);
    localStorage.removeItem(WORLD_KEY);
    this.saveData = null;
    this.hotbar = [...DEFAULT_HOTBAR];
    this.selected = 0;
    this.ui.updateHotbar(this.hotbar, this.selected);
    this.createWorld(seed, null, null);
    this.ui.setSeedPlaceholder(this.worldSeed);
    this.play();
  }

  finishLoading() {
    if (!this.usedSavedPos) {
      // snap to the real surface (caves may have carved under the estimate)
      const bx = Math.floor(this.player.pos.x), bz = Math.floor(this.player.pos.z);
      let y = WORLD_H - 2;
      while (y > 1 && !BLOCKS[this.world.getBlock(bx, y, bz)].solid) y--;
      this.player.teleport(bx + 0.5, y + 1, bz + 0.5);
    }
    this.state = 'playing';
    this.ui.hideAllMenus();
    this.ui.show('hud');
    this.ui.updateHotbar(this.hotbar, this.selected);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.mining = false;
    this.rmbHeld = false;
    this.ui.show('pause');
  }

  resume() {
    this.ui.hideAllMenus();
    if (this.pickerOpen) this.closePicker(false);
    this.state = 'playing';
    this.lockPointer();
  }

  quitToTitle() {
    this.saveWorld();
    this.state = 'title';
    this.pickerOpen = false;
    this.ui.hideAllMenus();
    this.ui.hide('hud');
    this.ui.show('title');
    document.exitPointerLock?.();
  }

  // ============================================================
  // Persistence
  // ============================================================

  saveWorld() {
    if (!this.world || !this.player) return;
    this.saveData = {
      seed: this.worldSeed,
      edits: this.world.serializeEdits(),
      player: {
        x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z,
        yaw: this.player.yaw, pitch: this.player.pitch, flying: this.player.flying,
      },
      hotbar: this.hotbar,
      slot: this.selected,
      time: this.sky.timeOfDay,
    };
    saveJSON(WORLD_KEY, this.saveData);
  }

  applySetting(key, value) {
    this.settings[key] = value;
    saveJSON(SETTINGS_KEY, this.settings);
    switch (key) {
      case 'render':
        this.world.viewRadius = value;
        this.sky.setViewDistance(value);
        break;
      case 'fov': break; // applied smoothly each frame
      case 'vol': this.audio.setVolume(value / 100); break;
      case 'music': this.audio.setMusicOn(value); break;
      case 'clouds': this.sky.setCloudsVisible(value); break;
      case 'smooth':
        this.world.smoothLighting = value;
        this.world.remeshAll();
        break;
    }
  }

  // ============================================================
  // Input
  // ============================================================

  lockPointer() {
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.canvas.requestPointerLock());
    } catch {
      this.canvas.requestPointerLock();
    }
  }

  bindInput() {
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.mining = false;
        this.rmbHeld = false;
        if (this.state === 'playing' && !this.pickerOpen) this.pause();
      }
    });

    window.addEventListener('resize', () => {
      this.renderer.setSize(innerWidth, innerHeight);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.handCamera.aspect = innerWidth / innerHeight;
      this.handCamera.updateProjectionMatrix();
    });

    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerdown', () => this.audio.ensure(), { capture: true });

    document.addEventListener('keydown', (e) => {
      if (e.repeat) {
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
        return;
      }
      this.keys.add(e.code);

      if (this.state === 'playing' && this.pickerOpen && (e.code === 'KeyE' || e.code === 'Escape')) {
        e.preventDefault();
        this.closePicker(true);
        return;
      }
      if (this.state !== 'playing' || this.pickerOpen) return;

      switch (e.code) {
        case 'F3':
          e.preventDefault();
          this.debugVisible = !this.debugVisible;
          if (!this.debugVisible) this.ui.setDebug(false);
          break;
        case 'KeyE':
          e.preventDefault();
          this.openPicker();
          break;
        case 'KeyF':
          this.player.flying = !this.player.flying;
          this.ui.showToast(this.player.flying ? 'Flying enabled' : 'Flying disabled');
          break;
        case 'Space': {
          e.preventDefault();
          const now = performance.now();
          if (now - this.lastSpace < 320) {
            this.player.flying = !this.player.flying;
            if (this.player.flying) this.player.vel.y = 0;
            this.ui.showToast(this.player.flying ? 'Flying enabled' : 'Flying disabled');
          }
          this.lastSpace = now;
          break;
        }
        case 'KeyW': {
          const now = performance.now();
          if (now - this.lastW < 300) this.sprintLatch = true;
          this.lastW = now;
          break;
        }
        default:
          if (/^Digit[1-9]$/.test(e.code)) {
            this.selectSlot(Number(e.code.slice(5)) - 1);
          }
      }
    });

    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyW') this.sprintLatch = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || this.state !== 'playing') return;
      const sens = (this.settings.sens / 100) * 0.0023;
      this.player.yaw -= e.movementX * sens;
      this.player.pitch -= e.movementY * sens;
      const lim = Math.PI / 2 - 0.001;
      this.player.pitch = Math.max(-lim, Math.min(lim, this.player.pitch));
    });

    document.addEventListener('mousedown', (e) => {
      if (this.state !== 'playing' || this.pickerOpen) return;
      if (!this.locked) { this.lockPointer(); return; }
      if (e.button === 0) {
        this.mining = true;
        this.miningProgress = 0;
        this.miningCell = null;
        this.swing();
      } else if (e.button === 1) {
        e.preventDefault();
        this.pickTargetBlock();
      } else if (e.button === 2) {
        this.rmbHeld = true;
        this.placeTimer = 0.24;
        this.placeBlock();
      }
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) { this.mining = false; this.miningProgress = 0; this.miningCell = null; }
      if (e.button === 2) this.rmbHeld = false;
    });

    document.addEventListener('wheel', (e) => {
      if (this.state !== 'playing' || !this.locked) return;
      const dir = e.deltaY > 0 ? 1 : -1;
      this.selectSlot((this.selected + dir + 9) % 9);
    }, { passive: true });

    window.addEventListener('beforeunload', () => {
      if (this.state === 'playing' || this.state === 'paused') this.saveWorld();
    });
  }

  // ============================================================
  // Hotbar / picker
  // ============================================================

  selectSlot(i) {
    this.selected = i;
    this.ui.updateHotbar(this.hotbar, i);
    this.ui.setPickerSelected(i);
    this.ui.showToast(BLOCKS[this.hotbar[i]].name);
    this.dipT = 0;
    this.audio.pop();
  }

  assignBlock(id) {
    this.hotbar[this.selected] = id;
    this.ui.updateHotbar(this.hotbar, this.selected);
    this.ui.showToast(BLOCKS[id].name);
    this.audio.click();
    this.dipT = 0;
  }

  openPicker() {
    this.pickerOpen = true;
    this.mining = false;
    this.rmbHeld = false;
    this.ui.show('picker');
    this.ui.setPickerSelected(this.selected);
    document.exitPointerLock?.();
  }

  closePicker(relock) {
    this.pickerOpen = false;
    this.ui.hide('picker');
    if (relock) this.lockPointer();
  }

  // ============================================================
  // Interaction: mining / placing / picking
  // ============================================================

  currentTarget() {
    const eye = this.player.eyePosition(new THREE.Vector3());
    const dir = this.player.lookDir(new THREE.Vector3());
    return raycastVoxel(this.world, eye, dir, REACH);
  }

  swing() { this.swingT = 0; }

  updateInteraction(dt) {
    const target = this.currentTarget();

    // ---- outline ----
    if (target) {
      this.outline.visible = true;
      this.outline.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
    } else {
      this.outline.visible = false;
    }

    // ---- mining ----
    if (this.mining && target) {
      const key = `${target.x},${target.y},${target.z}`;
      if (this.miningCell !== key) {
        this.miningCell = key;
        this.miningProgress = 0;
      }
      const def = BLOCKS[target.id];
      if (def.hardness !== Infinity) {
        const speed = this.player.headInWater ? 0.35 : 1;
        this.miningProgress += dt * speed;
        if (this.swingT > 0.7) this.swing(); // keep punching
        const frac = Math.min(1, this.miningProgress / def.hardness);
        const stage = Math.min(7, Math.floor(frac * 8));
        if (frac > 0.02 && def.hardness > 0.12) {
          this.crack.visible = true;
          this.crack.position.copy(this.outline.position);
          this.crackMat.map = this.crackTextures[stage];
          this.crackMat.needsUpdate = true;
        } else {
          this.crack.visible = false;
        }
        if (this.miningProgress >= def.hardness) {
          this.breakBlock(target);
          this.miningCell = null;
          this.miningProgress = -0.08; // tiny grace before next block
          this.crack.visible = false;
        }
      } else {
        this.crack.visible = false;
      }
    } else {
      this.crack.visible = false;
      if (!this.mining) { this.miningProgress = 0; this.miningCell = null; }
    }

    // ---- place repeat ----
    if (this.rmbHeld) {
      this.placeTimer -= dt;
      if (this.placeTimer <= 0) {
        this.placeTimer = 0.24;
        this.placeBlock();
      }
    }
  }

  breakBlock(target) {
    const id = target.id;
    if (id === B.TNT) {
      this.entities.igniteTNT(target.x, target.y, target.z);
      return;
    }
    this.world.setBlock(target.x, target.y, target.z, B.AIR);
    this.particles.spawnBlockBreak(target.x, target.y, target.z, id);
    this.audio.blockBreak(id);
  }

  placeBlock() {
    const target = this.currentTarget();
    if (!target) return;
    const id = this.hotbar[this.selected];
    const def = BLOCKS[id];
    const targetDef = BLOCKS[target.id];

    let cx, cy, cz;
    if (targetDef.replaceable) {
      cx = target.x; cy = target.y; cz = target.z;
    } else {
      if (target.nx === 0 && target.ny === 0 && target.nz === 0) return;
      cx = target.x + target.nx; cy = target.y + target.ny; cz = target.z + target.nz;
    }
    if (cy < 1 || cy >= WORLD_H) return;

    const cellId = this.world.getBlock(cx, cy, cz);
    const cellDef = BLOCKS[cellId];
    if (cellId !== B.AIR && !cellDef.replaceable) return;
    if (def.solid && this.player.intersectsCell(cx, cy, cz)) return;

    // support rules
    const below = this.world.getBlock(cx, cy - 1, cz);
    if (def.support === 'floor') {
      if (id === B.TORCH) {
        if (!BLOCKS[below].solid) return;
      } else if (below !== B.GRASS && below !== B.DIRT && below !== B.SNOW_GRASS && below !== B.SAND) {
        return; // plants need soil
      }
    }
    if (def.support === 'sand' && below !== B.SAND && below !== B.CACTUS) return;

    this.world.setBlock(cx, cy, cz, id);
    this.audio.blockPlace(id);
    this.swing();
  }

  pickTargetBlock() {
    const target = this.currentTarget();
    if (!target) return;
    if (PALETTE.includes(target.id)) {
      this.assignBlock(target.id);
    }
  }

  // ============================================================
  // Support / gravity checks (queued by world.setBlock)
  // ============================================================

  processSupportChecks() {
    const list = this.world.supportChecks;
    if (!list.length) return;
    const batch = list.splice(0, 128);
    for (const [x, y, z] of batch) {
      const id = this.world.getBlock(x, y, z);
      if (id === B.AIR) continue;
      const def = BLOCKS[id];
      const below = this.world.getBlock(x, y - 1, z);
      const belowSolid = BLOCKS[below].solid;

      if (def.gravity && !belowSolid) {
        this.entities.spawnFallingBlock(x, y, z, id);
      } else if (def.support === 'floor' && !belowSolid) {
        this.world.setBlock(x, y, z, B.AIR);
        this.particles.spawnBlockBreak(x, y, z, id);
        this.audio.blockBreak(id);
      } else if (def.support === 'sand' && below !== B.SAND && below !== B.CACTUS) {
        this.world.setBlock(x, y, z, B.AIR);
        this.particles.spawnBlockBreak(x, y, z, id);
        this.audio.blockBreak(id);
      }
    }
  }

  // ============================================================
  // Held block (first-person view model)
  // ============================================================

  heldGeometry(id) {
    let g = this.heldGeoCache.get(id);
    if (!g) { g = buildBlockGeometry(id); this.heldGeoCache.set(id, g); }
    return g;
  }

  updateHand(dt) {
    const id = this.hotbar[this.selected];
    if (!this.heldMesh || this.heldId !== id) {
      if (this.heldMesh) this.handGroup.remove(this.heldMesh);
      this.heldMesh = new THREE.Mesh(this.heldGeometry(id), this.materials.solid);
      this.heldMesh.scale.setScalar(0.4);
      this.handGroup.add(this.heldMesh);
      this.heldId = id;
    }

    this.swingT = Math.min(1, this.swingT + dt / 0.26);
    this.dipT = Math.min(1, this.dipT + dt / 0.22);

    const p = this.player;
    const bobX = Math.sin(p.walkCycle * 1.0) * 0.022 * p.bobStrength;
    const bobY = -Math.abs(Math.sin(p.walkCycle * 1.0)) * 0.018 * p.bobStrength;
    const swing = Math.sin(Math.min(1, this.swingT) * Math.PI);
    const dip = Math.sin(Math.min(1, this.dipT) * Math.PI);

    this.handGroup.position.set(
      0.42 + bobX,
      -0.42 + bobY - dip * 0.3 - swing * 0.08,
      -0.72 - swing * 0.18,
    );
    this.handGroup.rotation.set(
      -swing * 0.9,
      Math.PI * 0.13 - swing * 0.45,
      0,
    );
  }

  // ============================================================
  // Icons (rendered with the real block geometry + atlas)
  // ============================================================

  makeIcons() {
    const icons = new Map();
    const SIZE = 64;
    const rt = new THREE.WebGLRenderTarget(SIZE, SIZE);
    const iconScene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-0.82, 0.82, 0.82, -0.82, 0.1, 10);
    cam.position.set(1.84, 1.5, 1.84);
    cam.lookAt(0, 0, 0);

    const buf = new Uint8Array(SIZE * SIZE * 4);
    const cnv = document.createElement('canvas');
    cnv.width = cnv.height = SIZE;
    const ctx = cnv.getContext('2d');

    for (const id of PALETTE) {
      const def = BLOCKS[id];
      if (def.shape === 'cross' || def.shape === 'torch' || def.shape === 'liquid') {
        icons.set(id, tileIconCanvas(def.tex.py, SIZE).toDataURL());
        continue;
      }
      const mesh = new THREE.Mesh(this.heldGeometry(id), this.materials.solid);
      iconScene.add(mesh);
      this.renderer.setRenderTarget(rt);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear();
      this.renderer.render(iconScene, cam);
      this.renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, buf);
      this.renderer.setRenderTarget(null);
      iconScene.remove(mesh);

      // flip vertically + linear -> sRGB-ish gamma
      const img = ctx.createImageData(SIZE, SIZE);
      for (let y = 0; y < SIZE; y++) {
        const src = (SIZE - 1 - y) * SIZE * 4;
        const dst = y * SIZE * 4;
        for (let x = 0; x < SIZE * 4; x += 4) {
          img.data[dst + x] = Math.round(255 * Math.pow(buf[src + x] / 255, 1 / 2.2));
          img.data[dst + x + 1] = Math.round(255 * Math.pow(buf[src + x + 1] / 255, 1 / 2.2));
          img.data[dst + x + 2] = Math.round(255 * Math.pow(buf[src + x + 2] / 255, 1 / 2.2));
          img.data[dst + x + 3] = buf[src + x + 3];
        }
      }
      ctx.putImageData(img, 0, 0);
      icons.set(id, cnv.toDataURL());
    }
    rt.dispose();
    return icons;
  }

  // ============================================================
  // Frame loop
  // ============================================================

  frame(t) {
    // never let a single bad frame kill the whole game loop
    try {
      this.frameInner(t);
    } catch (err) {
      console.error('[frame]', err);
      window.__lastFrameError = (err && err.stack) || String(err);
    }
    this.scheduleFrame();
  }

  frameInner(t) {
    const dt = Math.min(0.1, (t - this.lastT) / 1000);
    this.lastT = t;

    // fps tracking
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    switch (this.state) {
      case 'title': this.frameTitle(dt); break;
      case 'loading': this.frameLoading(dt); break;
      case 'playing': this.framePlaying(dt); break;
      case 'paused': break; // fully frozen, like MC singleplayer
    }

    this.renderer.render(this.scene, this.camera);
    this.lastDrawInfo.calls = this.renderer.info.render.calls;
    this.lastDrawInfo.triangles = this.renderer.info.render.triangles;

    if (this.state === 'playing') {
      // overlay pass: keep the world pixels, only reset depth
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.handScene, this.handCamera);
      this.renderer.autoClear = true;
    }
  }

  frameTitle(dt) {
    this.titleAngle += dt * 0.05;
    this.world.update(this.spawn.x, this.spawn.z, 10);
    const r = 42;
    this.camera.position.set(
      this.spawn.x + Math.cos(this.titleAngle) * r,
      this.spawn.y + 22,
      this.spawn.z + Math.sin(this.titleAngle) * r,
    );
    this.camera.lookAt(this.spawn.x, this.spawn.y + 2, this.spawn.z);
    this.sky.update(dt, this.camera.position);
  }

  frameLoading(dt) {
    this.world.update(this.player.pos.x, this.player.pos.z, 14);
    const radius = Math.min(4, this.settings.render);
    const { ready, total } = this.world.readiness(this.player.pos.x, this.player.pos.z, radius);
    this.ui.setLoadingProgress(total ? ready / total : 0);
    this.sky.update(dt, this.camera.position);
    if (ready >= total) this.finishLoading();
  }

  framePlaying(dt) {
    const p = this.player;

    // ---- input snapshot ----
    const inputActive = !this.pickerOpen;
    const input = {
      forward: inputActive && this.keys.has('KeyW'),
      back: inputActive && this.keys.has('KeyS'),
      left: inputActive && this.keys.has('KeyA'),
      right: inputActive && this.keys.has('KeyD'),
      jump: inputActive && this.keys.has('Space'),
      sneak: inputActive && (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')),
    };
    const wantSprint = inputActive &&
      (this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.sprintLatch);
    p.sprinting = wantSprint && input.forward && !input.sneak;

    // ---- simulate ----
    p.update(dt, input);

    // void rescue
    if (p.pos.y < -14) {
      p.teleport(this.spawn.x, Math.max(this.spawn.y + 2, 70), this.spawn.z);
      p.vel.set(0, 0, 0);
    }

    // ---- player audio events ----
    for (const ev of p.events) {
      if (ev.type === 'step') this.audio.step(ev.id);
      else if (ev.type === 'land') { this.audio.land(ev.impact); if (ev.impact > 22) this.ui.flashDamage(); }
      else if (ev.type === 'splash') this.audio.splash();
    }
    p.events.length = 0;

    // ---- interaction & world streaming ----
    if (this.locked && !this.pickerOpen) this.updateInteraction(dt);
    else { this.outline.visible = false; this.crack.visible = false; }

    this.world.update(p.pos.x, p.pos.z, 5);
    this.processSupportChecks();
    this.entities.update(dt);

    // ---- camera ----
    const eye = p.eyePosition(new THREE.Vector3());
    let bobY = 0, bobRoll = 0;
    if (this.settings.bob && !p.flying) {
      bobY = Math.abs(Math.sin(p.walkCycle)) * 0.052 * p.bobStrength;
      bobRoll = Math.sin(p.walkCycle) * 0.004 * p.bobStrength;
    }
    this.shakeT = Math.max(0, this.shakeT - dt);
    const sh = this.shakeT * this.shakeT * 0.35;
    this.camera.position.set(
      eye.x + (Math.random() - 0.5) * sh,
      eye.y + bobY + (Math.random() - 0.5) * sh,
      eye.z + (Math.random() - 0.5) * sh,
    );
    this.camera.rotation.set(p.pitch, p.yaw, bobRoll);

    // smooth FOV (sprint kick)
    const targetFov = this.settings.fov * (p.sprinting ? (p.flying ? 1.18 : 1.12) : 1);
    this.fovCurrent += (targetFov - this.fovCurrent) * Math.min(1, 10 * dt);
    if (Math.abs(this.fovCurrent - this.camera.fov) > 0.05) {
      this.camera.fov = this.fovCurrent;
      this.camera.updateProjectionMatrix();
    }

    // ---- environment ----
    this.sky.setUnderwater(p.headInWater);
    this.ui.setUnderwater(p.headInWater);
    this.sky.update(dt, this.camera.position);
    this.waterTex.offset.x = (t_now() * 0.018) % 1;
    this.waterTex.offset.y = (t_now() * 0.011) % 1;

    this.updateHand(dt);

    // ---- autosave ----
    this.autosaveTimer += dt;
    if (this.autosaveTimer > 6) {
      this.autosaveTimer = 0;
      this.saveWorld();
    }

    // ---- debug ----
    if (this.debugVisible) {
      this.debugTimer -= dt;
      if (this.debugTimer <= 0) {
        this.debugTimer = 0.2;
        this.ui.setDebug(true, this.debugText());
      }
    }
  }

  debugText() {
    const p = this.player;
    const bx = Math.floor(p.pos.x), by = Math.floor(p.pos.y), bz = Math.floor(p.pos.z);
    const cx = Math.floor(bx / CHUNK), cz = Math.floor(bz / CHUNK);
    const yawDeg = ((THREE.MathUtils.radToDeg(p.yaw) % 360) + 360) % 360;
    const dirs = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];
    const facing = dirs[Math.round(yawDeg / 45) % 8];
    const target = this.currentTarget();
    const biome = BIOME_NAMES[this.world.biomeAt(bx, bz)] ?? '?';
    return [
      `Minecraft JS (Three.js) — ${this.fps} fps`,
      `XYZ: ${p.pos.x.toFixed(2)} / ${p.pos.y.toFixed(2)} / ${p.pos.z.toFixed(2)}`,
      `Block: ${bx} ${by} ${bz}   Chunk: ${cx} ${cz} [${bx & 15} ${bz & 15}]`,
      `Facing: ${facing} (yaw ${yawDeg.toFixed(1)}°, pitch ${THREE.MathUtils.radToDeg(p.pitch).toFixed(1)}°)`,
      `Biome: ${biome}   Time: ${this.sky.clockString()}`,
      `Seed: ${this.worldSeed}`,
      `Chunks: ${this.world.countLoaded()} ready / ${this.world.chunks.size} loaded   Edits: ${this.world.editCount}`,
      `Entities: ${this.entities.list.length}   Particles: ${this.particles.list.length}`,
      `Draw calls: ${this.lastDrawInfo.calls}   Tris: ${(this.lastDrawInfo.triangles / 1000).toFixed(1)}k`,
      `Flags: ${p.onGround ? 'ground ' : ''}${p.flying ? 'flying ' : ''}${p.inWater ? 'water ' : ''}${p.sprinting ? 'sprint ' : ''}${p.sneaking ? 'sneak' : ''}`,
      target ? `Target: ${BLOCKS[target.id].name} @ ${target.x} ${target.y} ${target.z}` : 'Target: —',
    ].join('\n');
  }
}

const t_now = () => performance.now() / 1000;

// ------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  try {
    window.game = new Game(); // exposed for debugging / tinkering
  } catch (err) {
    console.error('Failed to start:', err);
    document.getElementById('webgl-error')?.classList.remove('hidden');
    throw err;
  }
});
