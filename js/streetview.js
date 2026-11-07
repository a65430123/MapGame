// 街景模式：把角色與寶物「放進」Google 街景中
import * as geo from './geo.js';

const CAMERA_HEIGHT = 2.5; // 街景相機離地高度（公尺）
const ITEM_HEIGHT = 0.9;   // 寶物離地高度（公尺）
const SV_VIEW_RANGE = 180; // 街景中顯示寶物的距離上限（公尺）
export const SV_PICK_RANGE = 60; // 街景中可點擊收集的距離（公尺）
export const SV_AUTO_RANGE = 25; // 街景中自動收集的距離（公尺）

export class StreetViewMode {
  constructor(game) {
    this.game = game;
    this.pano = game.map.getStreetView();
    this.service = new google.maps.StreetViewService();
    this.layer = document.getElementById('sv-layer');
    this.itemsEl = document.getElementById('sv-items');
    this.playerEl = document.getElementById('sv-player');
    this.itemEls = new Map();
    this.active = false;
    this.walkTimer = 0;

    this.pano.setOptions({
      addressControl: true,
      addressControlOptions: { position: google.maps.ControlPosition.TOP_CENTER },
      linksControl: true,
      panControl: false,
      zoomControl: true,
      enableCloseButton: true,
      fullscreenControl: false,
      motionTracking: false,
      motionTrackingControl: false,
      showRoadLabels: true,
    });

    this.pano.addListener('visible_changed', () => (this.pano.getVisible() ? this.onShow() : this.onHide()));
    this.pano.addListener('position_changed', () => this.onPosition());
    this.pano.addListener('pov_changed', () => this.render());
    this.pano.addListener('zoom_changed', () => this.render());
    window.addEventListener('resize', () => this.render());
  }

  /** 在角色目前位置附近尋找街景並進入 */
  async enter(pos, heading = 0) {
    const req = {
      location: pos,
      radius: 150,
      preference: google.maps.StreetViewPreference?.NEAREST,
    };
    if (google.maps.StreetViewSource?.OUTDOOR) req.sources = [google.maps.StreetViewSource.OUTDOOR];
    try {
      const { data } = await this.service.getPanorama(req);
      const panoPos = geo.plain(data.location.latLng);
      // 讓鏡頭朝著角色面對的方向（若街景點在旁邊，則看向角色原本的位置）
      const h = geo.distance(panoPos, pos) > 15 ? geo.bearing(panoPos, pos) : heading;
      this.pano.setPano(data.location.pano);
      this.pano.setPov({ heading: h, pitch: -5 });
      this.pano.setZoom(1);
      this.pano.setVisible(true);
      return true;
    } catch (err) {
      this.game.toast('🚫 這附近 150 公尺內沒有街景，換個地方試試！');
      return false;
    }
  }

  exit() {
    this.pano.setVisible(false);
  }

  onShow() {
    this.active = true;
    this.layer.hidden = false;
    this.game.setMode('sv');
    // 拖曳小黃人進入街景時，position_changed 可能比 visible_changed 早觸發
    this.onPosition(true);
    this.render();
  }

  onHide() {
    if (!this.active) return;
    this.active = false;
    this.layer.hidden = true;
    this.game.setMode('map');
  }

  onPosition(force = false) {
    if (!this.active) return;
    const p = geo.plain(this.pano.getPosition());
    if (!p) return;
    const d = geo.distance(this.game.pos, p);
    if (d > 400) {
      // 遠距離跳躍（例如在地圖上把小黃人拖到別處），視為傳送
      this.game.relocate(p, { fromStreetView: true });
    } else if (d > 0.5 || force) {
      this.game.walkTo(p, geo.bearing(this.game.pos, p));
      this.walkAnim();
    }
    this.game.checkCollect(SV_AUTO_RANGE);
    this.render();
  }

  walkAnim() {
    this.playerEl.classList.add('walking');
    clearTimeout(this.walkTimer);
    this.walkTimer = setTimeout(() => this.playerEl.classList.remove('walking'), 700);
  }

  /** 沿街景連結前進（dir = 0）或後退（dir = 180） */
  step(dir = 0) {
    const links = this.pano.getLinks() || [];
    const pov = this.pano.getPov();
    const want = pov.heading + dir;
    let best = null, bestDiff = 999;
    for (const l of links) {
      if (!l || l.heading == null) continue;
      const diff = Math.abs(geo.normAngle(l.heading - want));
      if (diff < bestDiff) { bestDiff = diff; best = l; }
    }
    if (!best || bestDiff > 80) {
      this.game.toast(dir === 0 ? '🧱 前方沒有路了，轉個方向吧' : '🧱 後方沒有路');
      return false;
    }
    this.pano.setPano(best.pano);
    // 前進時讓視角順著道路方向
    if (dir === 0) this.pano.setPov({ heading: best.heading, pitch: pov.pitch });
    return true;
  }

  turn(deg) {
    const pov = this.pano.getPov();
    this.pano.setPov({ heading: (pov.heading + deg + 360) % 360, pitch: pov.pitch });
  }

  get heading() {
    return this.pano.getPov().heading;
  }

  /** 把寶物投影到街景畫面上 */
  render() {
    if (!this.active) return;
    const W = this.layer.clientWidth, H = this.layer.clientHeight;
    if (!W || !H) return;
    const cam = geo.plain(this.pano.getPosition()) || this.game.pos;
    const pov = this.pano.getPov();
    const zoom = this.pano.getZoom() ?? pov.zoom ?? 1;
    const hfov = Math.min(170, 180 / 2 ** zoom); // 水平視角
    const tanH = Math.tan(geo.toRad(hfov / 2));
    const tanV = tanH * (H / W);

    const seen = new Set();
    for (const item of this.game.items) {
      const d = geo.distance(cam, item.pos);
      if (d > SV_VIEW_RANGE) continue;
      const rel = geo.normAngle(geo.bearing(cam, item.pos) - pov.heading);
      if (Math.abs(rel) > hfov / 2 + 5 || Math.abs(rel) >= 89) continue;

      const elev = geo.toDeg(Math.atan((ITEM_HEIGHT - CAMERA_HEIGHT) / Math.max(d, 2)));
      const dy = elev - pov.pitch;
      if (Math.abs(dy) >= 89) continue;
      const x = W / 2 + (Math.tan(geo.toRad(rel)) / tanH) * (W / 2);
      const y = H / 2 - (Math.tan(geo.toRad(dy)) / tanV) * (H / 2);
      const scale = Math.max(0.25, Math.min(2.6, 18 / Math.max(d, 4))) * 2 ** (zoom - 1);

      let el = this.itemEls.get(item.id);
      if (!el) {
        el = document.createElement('div');
        el.className = `sv-item rarity-${item.type.rarity}`;
        el.innerHTML = `<div class="sv-item-glow"></div><div class="sv-item-emoji">${item.type.emoji}</div><div class="sv-item-label"></div>`;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const dist = geo.distance(this.game.pos, item.pos);
          if (dist <= SV_PICK_RANGE) this.game.collect(item);
          else this.game.toast(`${item.type.emoji} 太遠了（${Math.round(dist)} m），再靠近一點！`);
        });
        this.itemsEl.appendChild(el);
        this.itemEls.set(item.id, el);
      }
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${scale})`;
      el.style.zIndex = String(10000 - Math.round(d));
      el.style.opacity = d > SV_VIEW_RANGE - 30 ? String((SV_VIEW_RANGE - d) / 30) : '1';
      el.classList.toggle('in-reach', d <= SV_PICK_RANGE);
      el.querySelector('.sv-item-label').textContent = `${item.type.name} · ${Math.round(d)}m`;
      seen.add(item.id);
    }
    for (const [id, el] of this.itemEls) {
      if (!seen.has(id)) { el.remove(); this.itemEls.delete(id); }
    }
  }

  removeItem(id) {
    const el = this.itemEls.get(id);
    if (el) { el.remove(); this.itemEls.delete(id); }
  }
}
