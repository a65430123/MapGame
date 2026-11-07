// 地理計算工具（球面近似）
const R = 6371000; // 地球半徑（公尺）

export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;

/** 轉成 {lat, lng} 純物件（支援 google.maps.LatLng） */
export function plain(p) {
  if (!p) return null;
  return typeof p.lat === 'function' ? { lat: p.lat(), lng: p.lng() } : { lat: p.lat, lng: p.lng };
}

/** 兩點距離（公尺） */
export function distance(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const dφ = toRad(b.lat - a.lat), dλ = toRad(b.lng - a.lng);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** a 到 b 的方位角（0 = 北，順時針，0~360） */
export function bearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), dλ = toRad(b.lng - a.lng);
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** 從 p 往方位角 brng 移動 dist 公尺後的位置 */
export function offset(p, dist, brng) {
  const δ = dist / R, θ = toRad(brng);
  const φ1 = toRad(p.lat), λ1 = toRad(p.lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 };
}

/** 角度正規化到 -180 ~ 180 */
export function normAngle(a) {
  return ((((a + 180) % 360) + 360) % 360) - 180;
}

/** 某緯度、縮放等級下每像素幾公尺 */
export function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos(toRad(lat))) / 2 ** zoom;
}

const DIRS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
export function compassName(b) {
  return DIRS[Math.round(((b % 360) + 360) % 360 / 45) % 8];
}

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 100000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}
