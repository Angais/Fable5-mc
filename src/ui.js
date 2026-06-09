// ============================================================
// UI — DOM chrome: title screen with splash text, loading bar,
// hotbar + item toast, inventory picker, pause/options/controls
// menus and the F3 debug readout.
// ============================================================

import { BLOCKS, PALETTE } from './blocks.js';

const SPLASHES = [
  'Now in JavaScript!',
  'Three.js powered!',
  '100% procedural pixels!',
  'Punch the TNT!',
  'Double-tap SPACE to fly!',
  'Infinite-ish terrain!',
  'No assets were harmed!',
  'Caves included!',
  'Also try the real one!',
  'Made of canvas!',
  'Sneak near edges!',
  'Watch for falling sand!',
];

const TIPS = [
  'Tip: Double-tap SPACE to fly',
  'Tip: Hold CTRL (or double-tap W) to sprint',
  'Tip: Press E to choose any block',
  'Tip: TNT explodes when you break it…',
  'Tip: Torches light up caves',
  'Tip: Middle-click copies the block you aim at',
  'Tip: SHIFT-sneaking stops you falling off edges',
];

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.$ = (id) => document.getElementById(id);

    this.screens = {
      title: this.$('title-screen'),
      loading: this.$('loading-screen'),
      pause: this.$('pause-menu'),
      options: this.$('options-menu'),
      controls: this.$('controls-menu'),
      picker: this.$('picker'),
      hud: this.$('hud'),
    };

    this.iconUrls = new Map();
    this.controlsReturn = 'title';

    this.$('splash-text').textContent = SPLASHES[(Math.random() * SPLASHES.length) | 0];
    this.$('loading-tip').textContent = TIPS[(Math.random() * TIPS.length) | 0];

    this._wireMenus();
    this._buildHotbar();
  }

  // ----------------------------------------------------------
  // Screens
  // ----------------------------------------------------------

  show(name) { this.screens[name].classList.remove('hidden'); }
  hide(name) { this.screens[name].classList.add('hidden'); }
  hideAllMenus() {
    for (const k of ['title', 'loading', 'pause', 'options', 'controls', 'picker']) this.hide(k);
  }

  _wireMenus() {
    const click = (id, fn) => this.$(id).addEventListener('click', () => { this.h.onUiClick?.(); fn(); });

    click('btn-play', () => this.h.onPlay());
    click('btn-new-world', () => this.h.onNewWorld(this.$('seed-input').value.trim()));
    click('btn-title-controls', () => { this.controlsReturn = 'title'; this.hide('title'); this.show('controls'); });

    click('btn-resume', () => this.h.onResume());
    click('btn-quit', () => this.h.onQuit());
    click('btn-options', () => { this.hide('pause'); this.syncOptions(); this.show('options'); });
    click('btn-controls', () => { this.controlsReturn = 'pause'; this.hide('pause'); this.show('controls'); });
    click('btn-options-done', () => { this.hide('options'); this.show('pause'); });
    click('btn-controls-done', () => { this.hide('controls'); this.show(this.controlsReturn); });

    // option sliders
    const slider = (id, valId, key, fmt = (v) => v) => {
      this.$(id).addEventListener('input', (e) => {
        const v = Number(e.target.value);
        this.$(valId).textContent = fmt(v);
        this.h.onSetting(key, v);
      });
    };
    slider('opt-render', 'val-render', 'render');
    slider('opt-fov', 'val-fov', 'fov');
    slider('opt-sens', 'val-sens', 'sens');
    slider('opt-vol', 'val-vol', 'vol');

    const toggle = (id, key, label) => {
      this.$(id).addEventListener('click', () => {
        const s = this.h.getSettings();
        const v = !s[key];
        this.h.onSetting(key, v);
        this.$(id).textContent = `${label}: ${v ? 'ON' : 'OFF'}`;
        this.h.onUiClick?.();
      });
    };
    toggle('opt-bob', 'bob', 'View Bobbing');
    toggle('opt-clouds', 'clouds', 'Clouds');
    toggle('opt-music', 'music', 'Music');
    toggle('opt-smooth', 'smooth', 'Smooth Lighting');
  }

  syncOptions() {
    const s = this.h.getSettings();
    this.$('opt-render').value = s.render; this.$('val-render').textContent = s.render;
    this.$('opt-fov').value = s.fov; this.$('val-fov').textContent = s.fov;
    this.$('opt-sens').value = s.sens; this.$('val-sens').textContent = s.sens;
    this.$('opt-vol').value = s.vol; this.$('val-vol').textContent = s.vol;
    this.$('opt-bob').textContent = `View Bobbing: ${s.bob ? 'ON' : 'OFF'}`;
    this.$('opt-clouds').textContent = `Clouds: ${s.clouds ? 'ON' : 'OFF'}`;
    this.$('opt-music').textContent = `Music: ${s.music ? 'ON' : 'OFF'}`;
    this.$('opt-smooth').textContent = `Smooth Lighting: ${s.smooth ? 'ON' : 'OFF'}`;
  }

  setSeedPlaceholder(seed) {
    this.$('seed-input').placeholder = `Seed (current: ${seed})`;
  }

  setLoadingProgress(frac) {
    this.$('loading-fill').style.width = `${Math.round(frac * 100)}%`;
  }

  // ----------------------------------------------------------
  // Hotbar
  // ----------------------------------------------------------

  _buildHotbar() {
    const bar = this.$('hotbar');
    this.slotEls = [];
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      const num = document.createElement('span');
      num.className = 'slot-num';
      num.textContent = String(i + 1);
      const img = document.createElement('img');
      img.draggable = false;
      slot.appendChild(num);
      slot.appendChild(img);
      bar.appendChild(slot);
      this.slotEls.push(slot);
    }
  }

  setIcons(iconUrls) {
    this.iconUrls = iconUrls;
    this._buildPicker();
  }

  updateHotbar(hotbar, selected) {
    hotbar.forEach((id, i) => {
      const img = this.slotEls[i].querySelector('img');
      const url = this.iconUrls.get(id);
      if (url && img.src !== url) img.src = url;
      this.slotEls[i].classList.toggle('selected', i === selected);
    });
    if (this.pickerSlotEls) {
      hotbar.forEach((id, i) => {
        const img = this.pickerSlotEls[i].querySelector('img');
        const url = this.iconUrls.get(id);
        if (url && img.src !== url) img.src = url;
      });
    }
  }

  showToast(text) {
    const el = this.$('item-name');
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1400);
  }

  // ----------------------------------------------------------
  // Picker
  // ----------------------------------------------------------

  _buildPicker() {
    const grid = this.$('picker-grid');
    grid.innerHTML = '';
    for (const id of PALETTE) {
      const cell = document.createElement('div');
      cell.className = 'picker-cell';
      cell.dataset.name = BLOCKS[id].name;
      const img = document.createElement('img');
      img.draggable = false;
      const url = this.iconUrls.get(id);
      if (url) img.src = url;
      cell.appendChild(img);
      cell.addEventListener('click', () => this.h.onPickBlock(id));
      grid.appendChild(cell);
    }

    const bar = this.$('picker-hotbar');
    bar.innerHTML = '';
    this.pickerSlotEls = [];
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div');
      slot.className = 'hotbar-slot';
      const num = document.createElement('span');
      num.className = 'slot-num';
      num.textContent = String(i + 1);
      const img = document.createElement('img');
      img.draggable = false;
      slot.appendChild(num);
      slot.appendChild(img);
      slot.addEventListener('click', () => this.h.onHotbarSelect(i));
      bar.appendChild(slot);
      this.pickerSlotEls.push(slot);
    }
  }

  setPickerSelected(selected) {
    this.pickerSlotEls?.forEach((el, i) => el.classList.toggle('selected', i === selected));
  }

  // ----------------------------------------------------------
  // Misc HUD
  // ----------------------------------------------------------

  setUnderwater(on) {
    this.$('underwater-overlay').style.opacity = on ? '1' : '0';
  }

  flashDamage() {
    const el = this.$('damage-vignette');
    el.style.opacity = '1';
    clearTimeout(this._dmgTimer);
    this._dmgTimer = setTimeout(() => { el.style.opacity = '0'; }, 220);
  }

  setDebug(visible, text = '') {
    const el = this.$('debug');
    el.classList.toggle('hidden', !visible);
    if (visible) el.textContent = text;
  }

  showWebglError() {
    this.$('webgl-error').classList.remove('hidden');
  }
}
