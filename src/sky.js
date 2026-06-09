// ============================================================
// Sky — full day/night cycle (20 minutes like Minecraft):
// square sun & moon orbiting the player, fading star dome,
// drifting blocky cloud layer, sky/fog colors with sunrise &
// sunset tinting, and the global "uDayLight" uniform that
// dims every baked skylight vertex at night.
// ============================================================

import * as THREE from 'three';
import { buildSunCanvas, buildMoonCanvas, buildCloudCanvas } from './textures.js';
import { CHUNK } from './worldgen.js';

const DAY_LENGTH = 1200; // seconds for a full cycle (20 min, like MC)

const DAY_SKY = new THREE.Color(0.47, 0.66, 1.0);
const NIGHT_SKY = new THREE.Color(0.015, 0.025, 0.07);
const SUNSET = new THREE.Color(1.0, 0.48, 0.2);

export class Sky {
  constructor(scene, uniforms) {
    this.scene = scene;
    this.uniforms = uniforms;
    this.timeOfDay = 0.04; // 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight
    this.dayLight = 1;
    this.viewDistance = 7 * CHUNK;
    this.underwater = false;

    this.skyColor = new THREE.Color();
    this.fogColor = new THREE.Color();
    scene.background = this.skyColor;
    scene.fog = new THREE.Fog(this.fogColor.getHex(), 60, 200);
    // re-link: THREE.Fog copies the color, keep a reference instead
    scene.fog.color = this.fogColor;

    // ---- celestial group (follows the camera) ----
    this.group = new THREE.Group();
    scene.add(this.group);

    const sunTex = new THREE.CanvasTexture(buildSunCanvas());
    sunTex.magFilter = sunTex.minFilter = THREE.NearestFilter;
    sunTex.colorSpace = THREE.SRGBColorSpace;
    this.sun = new THREE.Mesh(
      new THREE.PlaneGeometry(64, 64),
      new THREE.MeshBasicMaterial({ map: sunTex, fog: false, transparent: true, depthWrite: false }),
    );
    this.group.add(this.sun);

    const moonTex = new THREE.CanvasTexture(buildMoonCanvas());
    moonTex.magFilter = moonTex.minFilter = THREE.NearestFilter;
    moonTex.colorSpace = THREE.SRGBColorSpace;
    this.moon = new THREE.Mesh(
      new THREE.PlaneGeometry(38, 38),
      new THREE.MeshBasicMaterial({ map: moonTex, fog: false, transparent: true, depthWrite: false }),
    );
    this.group.add(this.moon);

    // ---- stars ----
    const starCount = 900;
    const starPos = new Float32Array(starCount * 3);
    const rng = (() => { let s = 1337; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    for (let i = 0; i < starCount; i++) {
      // random direction on the sphere
      const t = rng() * Math.PI * 2;
      const p = Math.acos(2 * rng() - 1);
      const r = 460;
      starPos[i * 3] = r * Math.sin(p) * Math.cos(t);
      starPos[i * 3 + 1] = r * Math.cos(p);
      starPos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.7, sizeAttenuation: false,
      transparent: true, opacity: 0, fog: false, depthWrite: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.group.add(this.stars);

    // ---- clouds ----
    const cloudTex = new THREE.CanvasTexture(buildCloudCanvas());
    cloudTex.magFilter = cloudTex.minFilter = THREE.NearestFilter;
    cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
    this.cloudTex = cloudTex;
    this.cloudMat = new THREE.MeshBasicMaterial({
      map: cloudTex, transparent: true, opacity: 0.55, fog: false,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(2048, 2048), this.cloudMat);
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = 148;
    this.cloudTex.repeat.set(2, 2);
    scene.add(this.clouds);
    this.cloudDrift = 0;
  }

  setTimeOfDay(t) { this.timeOfDay = ((t % 1) + 1) % 1; }
  setViewDistance(chunks) { this.viewDistance = chunks * CHUNK; }
  setCloudsVisible(v) { this.clouds.visible = v; }
  setUnderwater(u) { this.underwater = u; }

  /** "HH:MM" — 0.0 timeOfDay corresponds to 06:00. */
  clockString() {
    const t = (this.timeOfDay * 24 + 6) % 24;
    const hh = String(Math.floor(t)).padStart(2, '0');
    const mm = String(Math.floor((t % 1) * 60)).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  update(dt, camPos) {
    this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH) % 1;
    const a = this.timeOfDay * Math.PI * 2;
    const sunH = Math.sin(a); // -1..1, height of the sun

    // ---- celestial positions ----
    this.group.position.copy(camPos);
    this.sun.position.set(Math.cos(a) * 420, Math.sin(a) * 420, 0);
    this.sun.lookAt(camPos);
    this.moon.position.set(-Math.cos(a) * 420, -Math.sin(a) * 420, 0);
    this.moon.lookAt(camPos);
    this.stars.rotation.z = a;

    // ---- light level ----
    const k = THREE.MathUtils.clamp((sunH + 0.16) / 0.32, 0, 1); // 0 night .. 1 day
    const smooth = k * k * (3 - 2 * k);
    this.dayLight = 0.14 + 0.86 * smooth;
    this.uniforms.uDayLight.value = this.dayLight;

    // ---- sky / fog colors ----
    this.skyColor.copy(NIGHT_SKY).lerp(DAY_SKY, smooth);
    const sunsetF = THREE.MathUtils.clamp(1 - Math.abs(sunH) * 4.5, 0, 1);
    this.skyColor.lerp(SUNSET, sunsetF * 0.35);

    this.fogColor.copy(this.skyColor).multiplyScalar(1.12);
    this.fogColor.lerp(SUNSET, sunsetF * 0.18);

    const fog = this.scene.fog;
    if (this.underwater) {
      this.fogColor.setRGB(0.05, 0.18, 0.45).multiplyScalar(Math.max(0.25, this.dayLight));
      fog.near = 2;
      fog.far = 18;
    } else {
      fog.near = this.viewDistance * 0.55;
      fog.far = this.viewDistance * 0.98;
    }

    // ---- stars / sun fade ----
    this.starMat.opacity = THREE.MathUtils.clamp(1 - smooth * 1.6, 0, 1) * 0.9;
    this.sun.material.opacity = THREE.MathUtils.clamp(sunH * 6 + 0.7, 0, 1);
    this.moon.material.opacity = THREE.MathUtils.clamp(-sunH * 6 + 0.7, 0, 1);

    // ---- clouds drift along +x, world-anchored, dim at night ----
    this.cloudDrift += dt * 0.6;
    this.clouds.position.x = camPos.x;
    this.clouds.position.z = camPos.z;
    const cw = 2048 / this.cloudTex.repeat.x; // world units per texture repeat
    this.cloudTex.offset.set((camPos.x + this.cloudDrift) / cw, -camPos.z / cw);
    const cl = 0.25 + 0.75 * smooth;
    this.cloudMat.color.setRGB(cl, cl, cl);
  }
}
