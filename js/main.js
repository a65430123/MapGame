// 地圖探險家 — 以 Google Maps 為基底的探索遊戲
import * as geo from './geo.js';
import { StreetViewMode } from './streetview.js';

const SAVE_KEY = 'mapgame.save.v1';
const API_KEY_STORAGE = 'mapgame.apiKey';

const AVATARS = ['🧙', '🧑‍🚀', '🥷', '🧝', '🧛', '🤠', '🐱', '🐶', '🦊', '🐼', '🐧', '🦖', '🤖', '👻'];

const ITEM_TYPES = [
  { emoji: '🪙', name: '金幣', xp: 10, weight: 46, rarity: 'common' },
  { emoji: '🍎', name: '蘋果', xp: 15, weight: 24, rarity: 'common' },
  { emoji: '🍄', name: '蘑菇', xp: 20, weight: 12, rarity: 'common' },
  { emoji: '💎', name: '鑽石', xp: 40, weight: 9, rarity: 'rare' },
  { emoji: '⭐', name: '星星', xp: 60, weight: 5, rarity: 'rare' },
  { emoji: '🗝️', name: '古老鑰匙', xp: 100, weight: 2.5, rarity: 'epic' },
  { emoji: '👑', name: '王冠', xp: 150, weight: 1.5, rarity: 'epic' },
];

const PRESETS = [
  { name: '台北 101', lat: 25.033611, lng: 121.565 },
  { name: '九份老街', lat: 25.109722, lng: 121.845 },
  { name: '東京 澀谷', lat: 35.659556, lng: 139.700472 },
  { name: '京都 清水寺', lat: 34.994856, lng: 135.785046 },
  { name: '首爾 景福宮', lat: 37.575, lng: 126.976944 },
  { name: '巴黎 艾菲爾鐵塔', lat: 48.857, lng: 2.2945 },
  { name: '倫敦 西敏寺', lat: 51.4993, lng: -0.1273 },
  { name: '羅馬 競技場', lat: 41.8902, lng: 12.4922 },
  { name: '紐約 時代廣場', lat: 40.758, lng: -73.9855 },
  { name: '雪梨 歌劇院', lat: -33.8568, lng: 151.2153 },
];

const MAX_ITEMS = 14;
const SPAWN_MIN = 60, SPAWN_MAX = 550;      // 寶物生成距離（公尺）
const DESPAWN_DIST = 1500;                   // 距離太遠的寶物會消失
const DISCOVER_EVERY = 350;                  // 每移動多少公尺查詢一次所在地區
const WALK_PX_PER_SEC = 90;                  // 地圖上的步行速度（螢幕像素 / 秒）
const RUN_MULT = 2.6;

const $ = (id) => document.getElementById(id);

function defaultSave() {
  return {
    name: '旅人',
    avatar: AVATARS[0],
    pos: { lat: PRESETS[0].lat, lng: PRESETS[0].lng },
    heading: 0,
    xp: 0,
    distance: 0,
    totalCollected: 0,
    collection: {},       // emoji -> 數量
    discoveries: [],      // { key, name, country, lat, lng, t }
    countries: [],
    created: Date.now(),
  };
}

function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (s && s.pos) return { ...defaultSave(), ...s };
  } catch { /* ignore */ }
  return null;
}

function levelOf(xp) { return Math.floor(Math.sqrt(xp / 50)) + 1; }
function xpForLevel(lv) { return 50 * (lv - 1) ** 2; }

function pickItemType() {
  const total = ITEM_TYPES.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of ITEM_TYPES) { if ((r -= t.weight) <= 0) return t; }
  return ITEM_TYPES[0];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Google Maps 載入
// ---------------------------------------------------------------------------
function getApiKey() {
  const fromUrl = new URLSearchParams(location.search).get('key');
  if (fromUrl) return fromUrl;
  if (window.MAPGAME_CONFIG?.apiKey) return window.MAPGAME_CONFIG.apiKey;
  try { return localStorage.getItem(API_KEY_STORAGE) || ''; } catch { return ''; }
}

function loadGoogleMaps(key) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps?.importLibrary) return resolve();
    window.__mapgameReady = () => resolve();
    window.gm_authFailure = () => {
      try { localStorage.removeItem(API_KEY_STORAGE); } catch { /* ignore */ }
      showFatal('Google Maps 金鑰驗證失敗。請確認金鑰正確、已啟用 Maps JavaScript API，且網域在允許清單中。重新整理頁面後可重新輸入金鑰。');
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=zh-TW&callback=__mapgameReady&loading=async`;
    s.async = true;
    s.onerror = () => reject(new Error('無法載入 Google Maps，請檢查網路連線。'));
    document.head.appendChild(s);
  });
}

function showFatal(msg) {
  const el = $('start-error');
  el.textContent = msg;
  el.hidden = false;
  $('start-screen').hidden = false;
  $('key-field').hidden = false;
  $('btn-start').disabled = false;
  $('btn-start').textContent = '開始冒險 ▶';
}

// ---------------------------------------------------------------------------
// 地圖上的 HTML 標記（以 OverlayView 實作，可自由做動畫）
// ---------------------------------------------------------------------------
function makeHtmlMarkerClass() {
  return class HtmlMarker extends google.maps.OverlayView {
    constructor(position, el, { pane = 'overlayMouseTarget', blockMap = false } = {}) {
      super();
      this.position = position;
      this.el = el;
      this.paneName = pane;
      el.style.position = 'absolute';
      if (blockMap) google.maps.OverlayView.preventMapHitsAndGesturesFrom(el);
    }
    onAdd() { this.getPanes()[this.paneName].appendChild(this.el); }
    draw() {
      const proj = this.getProjection();
      if (!proj) return;
      const p = proj.fromLatLngToDivPixel(this.position);
      if (!p) return;
      this.el.style.left = `${p.x}px`;
      this.el.style.top = `${p.y}px`;
    }
    onRemove() { this.el.remove(); }
    setPosition(pos) { this.position = pos; this.draw(); }
  };
}

// ---------------------------------------------------------------------------
// 遊戲本體
// ---------------------------------------------------------------------------
class Game {
  constructor(save) {
    this.save = save;
    this.pos = { ...save.pos };
    this.heading = save.heading || 0;
    this.mode = 'map';
    this.keys = new Set();
    this.target = null;
    this.follow = true;
    this.items = [];
    this.itemSeq = 0;
    this.sinceDiscover = DISCOVER_EVERY; // 一開始就查詢一次
    this.lastFrame = performance.now();
    this.lastSvStep = 0;
    this.trails = [];
    this.lastTrailPos = null;
    this.saveDirty = false;
    this.geocodeBusy = false;
  }

  async start() {
    const { Map } = await google.maps.importLibrary('maps');
    await google.maps.importLibrary('streetView');
    try {
      const { Geocoder } = await google.maps.importLibrary('geocoding');
      this.geocoder = new Geocoder();
    } catch { this.geocoder = null; }

    this.HtmlMarker = makeHtmlMarkerClass();

    this.map = new Map($('map'), {
      center: this.pos,
      zoom: 17,
      keyboardShortcuts: false,
      clickableIcons: false,
      gestureHandling: 'greedy',
      streetViewControl: true,
      streetViewControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
      mapTypeControl: true,
      mapTypeControlOptions: {
        position: google.maps.ControlPosition.TOP_RIGHT,
        style: google.maps.MapTypeControlStyle.DROPDOWN_MENU,
      },
      fullscreenControl: false,
      zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
    });

    this.createPlayer();
    this.newTrail();
    this.sv = new StreetViewMode(this);

    this.map.addListener('click', (e) => this.onMapClick(e));
    this.map.addListener('dragstart', () => { this.follow = false; $('btn-center').classList.add('attention'); });
    this.map.addListener('zoom_changed', () => this.updatePlayerScale());

    this.bindInput();
    this.bindUi();
    this.refreshHud();
    this.spawnItems();
    this.updatePlayerScale();

    $('hud').hidden = false;
    $('start-screen').hidden = true;
    document.body.classList.add('playing');

    this.toast(`👋 歡迎，${this.save.name}！用方向鍵或點擊地圖開始探索吧。`);
    requestAnimationFrame((t) => this.tick(t));
    setInterval(() => this.persist(), 4000);
    setInterval(() => this.updateTracker(), 250);
    window.addEventListener('beforeunload', () => this.persist(true));
  }

  // ---------------- 角色 ----------------
  createPlayer() {
    const el = document.createElement('div');
    el.className = 'player';
    el.innerHTML = `
      <div class="player-name"></div>
      <div class="player-sprite"><div class="player-body"></div></div>
      <div class="player-shadow"></div>`;
    this.playerEl = el;
    this.player = new this.HtmlMarker(this.pos, el, { pane: 'floatPane' });
    this.player.setMap(this.map);

    this.targetEl = document.createElement('div');
    this.targetEl.className = 'target-ping';
    this.targetMarker = new this.HtmlMarker(this.pos, this.targetEl, { pane: 'overlayLayer' });
    this.applyAvatar();
  }

  applyAvatar() {
    this.playerEl.querySelector('.player-name').textContent = this.save.name;
    this.playerEl.querySelector('.player-body').textContent = this.save.avatar;
    $('sv-player-body').textContent = this.save.avatar;
    $('sv-player-name').textContent = this.save.name;
    $('hud-avatar').textContent = this.save.avatar;
    $('hud-name').textContent = this.save.name;
  }

  updatePlayerScale() {
    const z = this.map.getZoom() ?? 17;
    const s = Math.max(0.55, Math.min(1.15, 0.55 + (z - 12) * 0.1));
    this.playerEl.style.setProperty('--s', s.toFixed(2));
  }

  setFacing(heading) {
    this.heading = heading;
    const h = ((heading % 360) + 360) % 360;
    // 角色往東走時面向右邊，往西走時面向左邊
    if (h > 10 && h < 170) this.playerEl.classList.add('face-right');
    else if (h > 190 && h < 350) this.playerEl.classList.remove('face-right');
  }

  /** 角色移動到新位置（會累積距離、留下足跡、檢查寶物） */
  walkTo(p, heading) {
    const d = geo.distance(this.pos, p);
    this.pos = { lat: p.lat, lng: p.lng };
    if (heading != null && d > 0.01) this.setFacing(heading);
    this.save.distance += d;
    this.sinceDiscover += d;
    this.player.setPosition(this.pos);
    this.addTrailPoint();
    this.saveDirty = true;
    if (this.sinceDiscover >= DISCOVER_EVERY) this.discover();
  }

  /** 瞬間移動（傳送） */
  relocate(p, { name, fromStreetView = false } = {}) {
    this.pos = { lat: p.lat, lng: p.lng };
    this.target = null;
    this.targetMarker.setMap(null);
    this.player.setPosition(this.pos);
    this.newTrail();
    for (const it of this.items) it.marker.setMap(null);
    this.items = [];
    this.sv?.render();
    this.spawnItems();
    this.sinceDiscover = DISCOVER_EVERY;
    this.discover();
    this.follow = true;
    if (!fromStreetView) {
      this.map.setCenter(this.pos);
      this.map.setZoom(17);
    }
    if (name) this.toast(`🌀 傳送到「${name}」！`);
    this.saveDirty = true;
    this.persist(true);
  }

  // ---------------- 足跡 ----------------
  newTrail() {
    const line = new google.maps.Polyline({
      map: this.map,
      path: [this.pos],
      strokeColor: '#ff7a45',
      strokeOpacity: 0,
      icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, strokeWeight: 3, scale: 2 }, offset: '0', repeat: '12px' }],
      clickable: false,
    });
    this.trails.push(line);
    if (this.trails.length > 8) this.trails.shift().setMap(null);
    this.lastTrailPos = { ...this.pos };
  }

  addTrailPoint() {
    if (this.lastTrailPos && geo.distance(this.lastTrailPos, this.pos) < 8) return;
    const path = this.trails[this.trails.length - 1].getPath();
    path.push(new google.maps.LatLng(this.pos));
    if (path.getLength() > 1500) path.removeAt(0);
    this.lastTrailPos = { ...this.pos };
  }

  // ---------------- 寶物 ----------------
  spawnItems() {
    // 移除太遠的寶物
    this.items = this.items.filter((it) => {
      if (geo.distance(this.pos, it.pos) > DESPAWN_DIST) { it.marker.setMap(null); return false; }
      return true;
    });
    while (this.items.length < MAX_ITEMS) {
      const dist = SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
      const p = geo.offset(this.pos, dist, Math.random() * 360);
      this.addItem(p, pickItemType());
    }
    this.sv?.render();
  }

  addItem(pos, type) {
    const el = document.createElement('div');
    el.className = `item rarity-${type.rarity}`;
    el.innerHTML = `<div class="item-glow"></div><div class="item-emoji">${type.emoji}</div><div class="item-shadow"></div>`;
    el.title = `${type.name}（+${type.xp} XP）`;
    const item = { id: ++this.itemSeq, pos, type, el };
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setTarget(item.pos);
    });
    item.marker = new this.HtmlMarker(pos, el, { blockMap: true });
    item.marker.setMap(this.map);
    this.items.push(item);
    return item;
  }

  checkCollect(radius) {
    for (const it of [...this.items]) {
      if (geo.distance(this.pos, it.pos) <= radius) this.collect(it);
    }
  }

  collect(item) {
    const idx = this.items.indexOf(item);
    if (idx < 0) return;
    this.items.splice(idx, 1);
    item.el.classList.add('collected');
    setTimeout(() => item.marker.setMap(null), 450);
    this.sv?.removeItem(item.id);

    const before = levelOf(this.save.xp);
    this.save.xp += item.type.xp;
    this.save.totalCollected += 1;
    this.save.collection[item.type.emoji] = (this.save.collection[item.type.emoji] || 0) + 1;
    this.saveDirty = true;

    this.floatText(`${item.type.emoji} +${item.type.xp} XP`, item.type.rarity);
    if (item.type.rarity !== 'common') this.toast(`✨ 找到稀有寶物：${item.type.emoji} ${item.type.name}！`);
    const after = levelOf(this.save.xp);
    if (after > before) this.toast(`🎉 升級了！現在是 Lv.${after}`, 'big');
    this.refreshHud();
    // 補充新的寶物
    setTimeout(() => this.spawnItems(), 600);
  }

  floatText(text, rarity = 'common') {
    const el = document.createElement('div');
    el.className = `float-text rarity-${rarity}`;
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

  // ---------------- 地區發現（反向地理編碼） ----------------
  async discover() {
    if (!this.geocoder || this.geocodeBusy) return;
    this.geocodeBusy = true;
    this.sinceDiscover = 0;
    const at = { ...this.pos };
    try {
      const { results } = await this.geocoder.geocode({ location: at });
      const info = parseArea(results);
      if (!info) { $('hud-location').textContent = '📍 未知的荒野'; return; }
      $('hud-location').textContent = `📍 ${info.label}`;
      if (!this.save.discoveries.some((d) => d.key === info.key)) {
        this.save.discoveries.unshift({ key: info.key, name: info.label, country: info.country, lat: at.lat, lng: at.lng, t: Date.now() });
        let xp = 30;
        let msg = `🗺️ 發現新地區：${info.label}（+30 XP）`;
        if (info.country && !this.save.countries.includes(info.country)) {
          this.save.countries.push(info.country);
          xp += 120;
          msg = `🏳️ 首次踏上「${info.country}」！發現 ${info.label}（+150 XP）`;
        }
        const before = levelOf(this.save.xp);
        this.save.xp += xp;
        this.toast(msg, 'big');
        if (levelOf(this.save.xp) > before) this.toast(`🎉 升級了！現在是 Lv.${levelOf(this.save.xp)}`, 'big');
        this.saveDirty = true;
        this.refreshHud();
      }
    } catch (err) {
      console.warn('Geocoding 失敗（可能未啟用 Geocoding API）', err);
      $('hud-location').textContent = '📍 探索中…';
      if (String(err?.code || err).includes('REQUEST_DENIED')) this.geocoder = null;
    } finally {
      this.geocodeBusy = false;
    }
  }

  // ---------------- 輸入 ----------------
  bindInput() {
    const handled = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, textarea') || !$('panel').hidden) {
        if (e.code === 'Escape' && !$('panel').hidden) this.closePanel();
        return;
      }
      if (handled.has(e.code)) {
        // 在捕獲階段攔截，避免街景本身也處理方向鍵
        e.preventDefault();
        e.stopPropagation();
        if (!this.keys.has(e.code) && this.mode === 'sv') {
          if (e.code === 'KeyW' || e.code === 'ArrowUp') { this.sv.step(0); this.lastSvStep = performance.now(); }
          if (e.code === 'KeyS' || e.code === 'ArrowDown') { this.sv.step(180); this.lastSvStep = performance.now(); }
        }
      }
      this.keys.add(e.code);
      if (e.repeat) return;
      switch (e.code) {
        case 'KeyV': this.toggleStreetView(); break;
        case 'KeyC': this.centerOnPlayer(); break;
        case 'KeyT': this.openTeleport(); break;
        case 'KeyJ': this.openJournal(); break;
        case 'Escape': if (this.mode === 'sv') this.sv.exit(); break;
      }
    }, true);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code), true);
    window.addEventListener('blur', () => this.keys.clear());

    // 觸控方向鍵
    for (const btn of $('dpad').querySelectorAll('button')) {
      const code = btn.dataset.key;
      const down = (e) => {
        e.preventDefault();
        if (code === 'ShiftLeft') { btn.classList.toggle('on'); if (btn.classList.contains('on')) this.keys.add(code); else this.keys.delete(code); return; }
        this.keys.add(code);
        btn.classList.add('pressed');
        if (this.mode === 'sv' && (code === 'ArrowUp' || code === 'ArrowDown')) { this.sv.step(code === 'ArrowUp' ? 0 : 180); this.lastSvStep = performance.now(); }
      };
      const up = (e) => { if (code === 'ShiftLeft') return; e.preventDefault(); this.keys.delete(code); btn.classList.remove('pressed'); };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointerleave', up);
      btn.addEventListener('pointercancel', up);
    }
  }

  onMapClick(e) {
    if (this.mode !== 'map' || !e.latLng) return;
    this.setTarget(geo.plain(e.latLng));
  }

  setTarget(p) {
    this.target = p;
    this.follow = true;
    $('btn-center').classList.remove('attention');
    this.targetMarker.setPosition(p);
    this.targetMarker.setMap(this.map);
    this.targetEl.classList.remove('pop');
    void this.targetEl.offsetWidth;
    this.targetEl.classList.add('pop');
  }

  tick(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.mode === 'map') this.updateMapMovement(dt);
    else this.updateSvMovement(dt, now);
    requestAnimationFrame((t) => this.tick(t));
  }

  updateMapMovement(dt) {
    const k = this.keys;
    let dx = 0, dy = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) dy += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) dy -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) dx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) dx -= 1;

    const zoom = this.map.getZoom() ?? 17;
    const mpp = geo.metersPerPixel(this.pos.lat, zoom);
    const running = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = WALK_PX_PER_SEC * mpp * (running ? RUN_MULT : 1);

    let moving = false;
    if (dx || dy) {
      this.target = null;
      this.targetMarker.setMap(null);
      const heading = (geo.toDeg(Math.atan2(dx, dy)) + 360) % 360;
      this.walkTo(geo.offset(this.pos, speed * dt, heading), heading);
      moving = true;
    } else if (this.target) {
      const dist = geo.distance(this.pos, this.target);
      if (dist < 0.5) {
        this.target = null;
        this.targetMarker.setMap(null);
      } else {
        const heading = geo.bearing(this.pos, this.target);
        const step = Math.min(dist, speed * dt * (dist > 3000 ? 4 : 1));
        this.walkTo(geo.offset(this.pos, step, heading), heading);
        moving = true;
      }
    }

    this.playerEl.classList.toggle('walking', moving);
    this.playerEl.classList.toggle('running', moving && running);
    if (moving) {
      if (this.follow) this.map.setCenter(this.pos);
      this.checkCollect(Math.max(18, 22 * mpp));
      this.maybeRespawn();
    }
  }

  updateSvMovement(dt, now) {
    const k = this.keys;
    let turn = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) turn -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) turn += 1;
    if (turn) this.sv.turn(turn * 90 * dt);
    // 按住前進/後退會持續移動
    if (now - this.lastSvStep > 550) {
      if (k.has('KeyW') || k.has('ArrowUp')) { this.sv.step(0); this.lastSvStep = now; }
      else if (k.has('KeyS') || k.has('ArrowDown')) { this.sv.step(180); this.lastSvStep = now; }
    }
  }

  maybeRespawn() {
    const now = performance.now();
    if (now - (this.lastSpawnCheck || 0) < 1500) return;
    this.lastSpawnCheck = now;
    if (this.items.some((it) => geo.distance(this.pos, it.pos) > DESPAWN_DIST) || this.items.length < MAX_ITEMS) this.spawnItems();
  }

  // ---------------- 模式切換 ----------------
  setMode(mode) {
    this.mode = mode;
    this.keys.clear();
    document.body.classList.toggle('mode-sv', mode === 'sv');
    $('btn-sv').querySelector('small').textContent = mode === 'sv' ? '地圖' : '街景';
    $('btn-sv').querySelector('span').textContent = mode === 'sv' ? '🗺️' : '👁️';
    if (mode === 'map') {
      this.follow = true;
      this.map.setCenter(this.pos);
      this.spawnItems();
    } else {
      this.target = null;
      this.targetMarker.setMap(null);
      this.toast('👁️ 進入街景！用 W/↑ 前進、A/D 轉向，靠近寶物就能收集。');
    }
  }

  async toggleStreetView() {
    if (this.mode === 'sv') { this.sv.exit(); return; }
    const btn = $('btn-sv');
    btn.disabled = true;
    try { await this.sv.enter(this.pos, this.heading); } finally { btn.disabled = false; }
  }

  centerOnPlayer() {
    if (this.mode === 'sv') return;
    this.follow = true;
    $('btn-center').classList.remove('attention');
    this.map.panTo(this.pos);
    if ((this.map.getZoom() ?? 17) < 15) this.map.setZoom(17);
  }

  // ---------------- HUD ----------------
  refreshHud() {
    const s = this.save;
    const lv = levelOf(s.xp);
    const cur = xpForLevel(lv), next = xpForLevel(lv + 1);
    $('hud-level').textContent = lv;
    $('hud-xp-fill').style.width = `${(((s.xp - cur) / (next - cur)) * 100).toFixed(1)}%`;
    $('hud-items').textContent = s.totalCollected;
    $('hud-areas').textContent = s.discoveries.length;
    $('hud-dist').textContent = geo.formatDistance(s.distance);
  }

  updateTracker() {
    $('hud-dist').textContent = geo.formatDistance(this.save.distance);
    let best = null, bestD = Infinity;
    for (const it of this.items) {
      const d = geo.distance(this.pos, it.pos);
      if (d < bestD) { bestD = d; best = it; }
    }
    const tracker = $('hud-tracker');
    if (!best) { tracker.hidden = true; return; }
    tracker.hidden = false;
    const b = geo.bearing(this.pos, best.pos);
    const ref = this.mode === 'sv' ? this.sv.heading : 0;
    $('tracker-arrow').style.transform = `rotate(${b - ref - 90}deg)`;
    $('tracker-emoji').textContent = best.type.emoji;
    $('tracker-dist').textContent = `${geo.formatDistance(bestD)} ${geo.compassName(b)}方`;
    tracker.onclick = () => { if (this.mode === 'map') this.setTarget(best.pos); };
  }

  toast(msg, kind = '') {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => el.classList.add('out'), kind === 'big' ? 3600 : 2600);
    setTimeout(() => el.remove(), kind === 'big' ? 4000 : 3000);
  }

  persist(force = false) {
    if (!this.saveDirty && !force) return;
    this.save.pos = this.pos;
    this.save.heading = this.heading;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.save)); } catch { /* ignore */ }
    this.saveDirty = false;
  }

  // ---------------- 面板 ----------------
  bindUi() {
    $('btn-sv').onclick = () => this.toggleStreetView();
    $('btn-center').onclick = () => this.centerOnPlayer();
    $('btn-teleport').onclick = () => this.openTeleport();
    $('btn-journal').onclick = () => this.openJournal();
    $('btn-settings').onclick = () => this.openSettings();
    $('panel-close').onclick = () => this.closePanel();
    $('panel').addEventListener('click', (e) => { if (e.target === $('panel')) this.closePanel(); });
  }

  openPanel(title, html) {
    $('panel-title').textContent = title;
    $('panel-body').innerHTML = html;
    $('panel').hidden = false;
    this.keys.clear();
  }

  closePanel() { $('panel').hidden = true; }

  openTeleport() {
    this.openPanel('🌀 傳送門', `
      <form class="search-row" id="tp-form">
        <input id="tp-input" placeholder="輸入地名或地址，例如：淡水老街" autocomplete="off" />
        <button class="btn-primary small" type="submit">傳送</button>
      </form>
      <div class="tp-status" id="tp-status"></div>
      <h3>熱門景點</h3>
      <div class="preset-grid">
        ${PRESETS.map((p, i) => `<button class="preset" data-i="${i}">${escapeHtml(p.name)}</button>`).join('')}
        <button class="preset" id="tp-random">🎲 隨機城市</button>
        <button class="preset" id="tp-here">📡 我的實際位置</button>
      </div>
      <p class="muted">傳送不會累積移動距離。附近的寶物會重新生成。</p>`);
    const input = $('tp-input');
    setTimeout(() => input.focus(), 50);
    $('tp-form').onsubmit = async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      if (!this.geocoder) { $('tp-status').textContent = '⚠️ 搜尋需要啟用 Geocoding API。'; return; }
      $('tp-status').textContent = '🔎 搜尋中…';
      try {
        const { results } = await this.geocoder.geocode({ address: q });
        if (!results.length) throw new Error('ZERO_RESULTS');
        const r = results[0];
        this.closePanel();
        this.relocate(geo.plain(r.geometry.location), { name: r.formatted_address || q });
      } catch {
        $('tp-status').textContent = '❌ 找不到這個地點，換個關鍵字試試。';
      }
    };
    for (const b of $('panel-body').querySelectorAll('.preset[data-i]')) {
      b.onclick = () => { const p = PRESETS[+b.dataset.i]; this.closePanel(); this.relocate(p, { name: p.name }); };
    }
    $('tp-random').onclick = () => {
      const p = RANDOM_CITIES[Math.floor(Math.random() * RANDOM_CITIES.length)];
      this.closePanel();
      this.relocate({ lat: p[1], lng: p[2] }, { name: p[0] });
    };
    $('tp-here').onclick = () => {
      if (!navigator.geolocation) { $('tp-status').textContent = '⚠️ 瀏覽器不支援定位。'; return; }
      $('tp-status').textContent = '📡 定位中…';
      navigator.geolocation.getCurrentPosition(
        (pos) => { this.closePanel(); this.relocate({ lat: pos.coords.latitude, lng: pos.coords.longitude }, { name: '你的位置' }); },
        () => { $('tp-status').textContent = '❌ 無法取得位置（可能被拒絕存取）。'; },
        { enableHighAccuracy: true, timeout: 10000 },
      );
    };
  }

  openJournal() {
    const s = this.save;
    const lv = levelOf(s.xp);
    const coll = ITEM_TYPES.map((t) => {
      const n = s.collection[t.emoji] || 0;
      return `<div class="coll ${n ? '' : 'locked'} rarity-${t.rarity}"><div class="coll-emoji">${n ? t.emoji : '❔'}</div><div class="coll-name">${n ? t.name : '???'}</div><div class="coll-n">× ${n}</div></div>`;
    }).join('');
    const disc = s.discoveries.length
      ? s.discoveries.slice(0, 80).map((d, i) => `<li><button class="link" data-i="${i}">${escapeHtml(d.name)}</button><span class="muted">${new Date(d.t).toLocaleDateString('zh-TW')}</span></li>`).join('')
      : '<li class="muted">還沒有發現任何地區，四處走走吧！</li>';
    this.openPanel('📖 冒險日誌', `
      <div class="stat-grid">
        <div class="stat"><b>Lv.${lv}</b><span>${s.xp} XP</span></div>
        <div class="stat"><b>${s.totalCollected}</b><span>收集寶物</span></div>
        <div class="stat"><b>${geo.formatDistance(s.distance)}</b><span>移動距離</span></div>
        <div class="stat"><b>${s.countries.length}</b><span>造訪國家</span></div>
      </div>
      <h3>寶物圖鑑</h3>
      <div class="coll-grid">${coll}</div>
      <h3>發現的地區（${s.discoveries.length}）</h3>
      <p class="muted">點擊地名可以傳送回去。</p>
      <ul class="disc-list">${disc}</ul>`);
    for (const b of $('panel-body').querySelectorAll('.disc-list .link')) {
      b.onclick = () => { const d = s.discoveries[+b.dataset.i]; this.closePanel(); this.relocate(d, { name: d.name }); };
    }
  }

  openSettings() {
    this.openPanel('⚙️ 設定', `
      <label class="field"><span>角色名稱</span><input id="set-name" maxlength="12" value="${escapeHtml(this.save.name)}" /></label>
      <div class="field"><span>角色外觀</span><div class="avatar-grid" id="set-avatars"></div></div>
      <button class="btn-primary" id="set-save">儲存</button>
      <hr />
      <div class="danger-zone">
        <button class="btn-ghost" id="set-key">更換 API 金鑰</button>
        <button class="btn-danger" id="set-reset">重置冒險進度</button>
      </div>`);
    let chosen = this.save.avatar;
    renderAvatarGrid($('set-avatars'), chosen, (a) => { chosen = a; });
    $('set-save').onclick = () => {
      this.save.name = $('set-name').value.trim() || '旅人';
      this.save.avatar = chosen;
      this.applyAvatar();
      this.persist(true);
      this.closePanel();
      this.toast('✅ 已更新角色');
    };
    $('set-key').onclick = () => {
      try { localStorage.removeItem(API_KEY_STORAGE); } catch { /* ignore */ }
      const url = new URL(location.href);
      url.searchParams.delete('key');
      location.href = url.toString();
    };
    $('set-reset').onclick = () => {
      if (!confirm('確定要重置所有進度嗎？這個動作無法復原。')) return;
      const fresh = defaultSave();
      fresh.name = this.save.name;
      fresh.avatar = this.save.avatar;
      fresh.pos = this.pos;
      this.save = fresh;
      this.persist(true);
      location.reload();
    };
  }
}

const RANDOM_CITIES = [
  ['台南 赤崁樓', 22.9975, 120.2025], ['高雄 駁二', 22.6195, 120.2817], ['花蓮 市區', 23.9769, 121.6044],
  ['大阪 道頓堀', 34.6687, 135.5013], ['香港 尖沙咀', 22.2955, 114.1722], ['新加坡 濱海灣', 1.2834, 103.8607],
  ['曼谷 考山路', 13.7589, 100.4974], ['舊金山 漁人碼頭', 37.808, -122.4177], ['洛杉磯 好萊塢', 34.1016, -118.3267],
  ['溫哥華 煤氣鎮', 49.2844, -123.1089], ['巴塞隆納 蘭布拉大道', 41.3809, 2.1735], ['阿姆斯特丹 水壩廣場', 52.3731, 4.8926],
  ['柏林 布蘭登堡門', 52.5163, 13.3777], ['布拉格 舊城廣場', 50.0875, 14.4213], ['威尼斯 聖馬可廣場', 45.4341, 12.3388],
  ['伊斯坦堡 蘇丹艾哈邁德', 41.0055, 28.9769], ['開普敦 V&A 碼頭', -33.9036, 18.4205], ['里約 科帕卡巴納', -22.9711, -43.1822],
  ['布宜諾斯艾利斯 五月廣場', -34.6083, -58.3712], ['墨爾本 弗林德斯街', -37.8183, 144.9671], ['雷克雅維克 市中心', 64.1466, -21.9426],
];

/** 從地理編碼結果取出「區域 + 國家」 */
function parseArea(results) {
  if (!results?.length) return null;
  const pick = (types) => {
    for (const r of results) {
      for (const c of r.address_components || []) {
        if (types.some((t) => c.types.includes(t))) return c.long_name;
      }
    }
    return null;
  };
  const country = pick(['country']);
  const city = pick(['locality', 'administrative_area_level_2', 'administrative_area_level_1']);
  const district = pick(['sublocality_level_1', 'administrative_area_level_3', 'sublocality', 'neighborhood']);
  const parts = [city, district].filter(Boolean);
  if (district && city && district === city) parts.pop();
  if (!parts.length && !country) return null;
  const label = parts.length ? `${parts.join(' ')}${country ? ` · ${country}` : ''}` : country;
  return { key: `${country}|${city}|${district}`, label, country };
}

function renderAvatarGrid(container, selected, onPick) {
  container.innerHTML = AVATARS.map((a) => `<button type="button" class="avatar-opt ${a === selected ? 'sel' : ''}" data-a="${a}">${a}</button>`).join('');
  for (const b of container.querySelectorAll('.avatar-opt')) {
    b.onclick = () => {
      container.querySelectorAll('.avatar-opt').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      onPick(b.dataset.a);
    };
  }
}

// ---------------------------------------------------------------------------
// 開始畫面
// ---------------------------------------------------------------------------
function initStartScreen() {
  const existing = loadSave();
  const save = existing || defaultSave();
  let avatar = save.avatar;

  $('in-name').value = existing ? save.name : '';
  renderAvatarGrid($('avatar-grid'), avatar, (a) => { avatar = a; });

  const key = getApiKey();
  if (key) { $('key-field').hidden = true; $('in-key').value = key; }
  if (existing) $('btn-start').textContent = `繼續冒險（Lv.${levelOf(save.xp)}）▶`;

  $('btn-start').onclick = async () => {
    const k = $('in-key').value.trim();
    if (!k) {
      $('start-error').textContent = '請輸入 Google Maps API 金鑰。';
      $('start-error').hidden = false;
      $('key-field').hidden = false;
      return;
    }
    $('start-error').hidden = true;
    save.name = $('in-name').value.trim() || save.name || '旅人';
    save.avatar = avatar;
    $('btn-start').disabled = true;
    $('btn-start').textContent = '載入地圖中…';
    try {
      if (!window.MAPGAME_CONFIG?.apiKey) { try { localStorage.setItem(API_KEY_STORAGE, k); } catch { /* ignore */ } }
      await loadGoogleMaps(k);
      const game = new Game(save);
      window.game = game; // 方便除錯
      await game.start();
      game.persist(true);
    } catch (err) {
      console.error(err);
      showFatal(err.message || '載入失敗');
    }
  };
}

initStartScreen();
