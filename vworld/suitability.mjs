#!/usr/bin/env node
// ⑤ 대상지 적합도 판정 — 주거·상업·공업 중 어느 용도지역이 더 적합한가
//
// 사용: node --env-file=.env suitability.mjs <자료폴더> [--criteria criteria.json] [--indicators indicators.json]
//                                             [--target-pnu PNU --target-label "검색 주소"] [--out 폴더]
//   예: node --env-file=.env suitability.mjs out/anseo
//
// 입력(자료폴더, vworld.mjs·dem.mjs·climate.mjs로 받은 파일 중 날짜가 가장 늦은 것):
//   LT_C_ADRI_INFO 또는 LT_C_ADEMD_INFO(대상지 경계) · LP_PA_CBND_BUBUN(필지) · LT_C_UQ111~114(용도지역)
//   LT_C_UQ12x·13x(용도지구) · LT_L_MOCTLINK(도로) · LT_C_SPBD(건물) · DEM_*.json(90m 격자) · CLIMATE_*.json(선택)
// 절차(강의 6주차):
//   1) 기존 시설 제외, 녹지 선확정(44번)  2) 개발가능 필지를 용도별 4축(지형·접근성·주변환경·기반시설) 5점 채점
//   3) 가중 합산 → 대상지 면적가중 평균으로 용도 순위  4) 가중치 역전점  5) 강의 순서 배분
//   6) 지표 대시보드 ①~⑥ (38번) + ③×⑥ 중첩

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------- 인자·입력
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const dir = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!dir) { console.error('사용: node --env-file=.env suitability.mjs <자료폴더> [--criteria criteria.json] [--out 폴더]'); process.exit(1); }
const C = JSON.parse(await readFile(opt('--criteria', 'criteria.json'), 'utf8'));
const outDir = opt('--out', join(dir, 'suitability'));
const USES = Object.keys(C.uses);       // res, com, ind
const AXES = Object.keys(C.axes);       // terrain, access, env, infra

const files = (await readdir(dir)).sort();
const latest = (prefix, ext = '.geojson') => files.filter((f) => f.startsWith(prefix) && f.endsWith(ext)).at(-1);
async function load(prefix, { required = true, ext = '.geojson' } = {}) {
  const f = latest(prefix, ext);
  if (!f) { if (required) throw new Error(`${dir}에 ${prefix}*${ext} 파일이 없습니다.`); return null; }
  const meta = f.endsWith('.geojson') ? await readFile(join(dir, f.replace(/\.geojson$/, '.meta.json')), 'utf8').then(JSON.parse, () => null) : null;
  return { file: f, json: JSON.parse(await readFile(join(dir, f), 'utf8')), meta };
}
const src = {
  // 읍·면 지역은 리 경계가 대상지(analyze.mjs가 리 경계를 받음)
  site: latest('LT_C_ADRI_INFO_') ? await load('LT_C_ADRI_INFO_') : await load('LT_C_ADEMD_INFO_'),
  parcels: await load('LP_PA_CBND_BUBUN_'),
  roads: await load('LT_L_MOCTLINK_'),
  buildings: await load('LT_C_SPBD_'),
  dem: await load('DEM_', { ext: '.json' }),
  zones: (await Promise.all(['LT_C_UQ111_', 'LT_C_UQ112_', 'LT_C_UQ113_', 'LT_C_UQ114_'].map((p) => load(p, { required: false })))).filter(Boolean),
  districts: (await Promise.all(files.filter((f) => /^LT_C_UQ1[23]\d_.*\.geojson$/.test(f)).map((f) => f.slice(0, 11))
    .filter((p, i, a) => a.indexOf(p) === i).map((p) => load(p)))).filter(Boolean),
  climate: await load('CLIMATE_', { ext: '.json', required: false }),
};
const target = { pnu: opt('--target-pnu', null), label: opt('--target-label', null) };
const manualAll = JSON.parse(await readFile(opt('--indicators', 'indicators.json'), 'utf8').catch(() => '{}'));

// ---------------------------------------------------------------- 좌표: 대상지 중심 기준 평면(m)
let bb = [Infinity, Infinity, -Infinity, -Infinity];
const eachCoord = (c, fn) => (typeof c[0] === 'number' ? fn(c) : c.forEach((x) => eachCoord(x, fn)));
src.site.json.features.forEach((f) => eachCoord(f.geometry.coordinates, ([x, y]) => {
  bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)];
}));
const LON0 = (bb[0] + bb[2]) / 2, LAT0 = (bb[1] + bb[3]) / 2;
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110574;
const P = ([lon, lat]) => [(lon - LON0) * KX, (lat - LAT0) * KY];
const unP = ([x, y]) => [x / KX + LON0, y / KY + LAT0];

// 폴리곤: [[ring(외곽), ring(구멍)...], ...] (m)
const polys = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []).map((p) => p.map((r) => r.map(P)));
const lines = (g) => (g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []).map((l) => l.map(P));
const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return s / 2; };
const area = (ps) => ps.reduce((s, p) => s + Math.abs(ringArea(p[0])) - p.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0);
function inside([x, y], ps) {
  for (const p of ps) {
    let c = false;
    for (const r of p) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
    }
    if (c) return true;
  }
  return false;
}
function bboxOf(ps) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  ps.forEach((p) => p[0].forEach(([x, y]) => { b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; }));
  return b;
}
// 필지 안에 반드시 들어가는 대표점: 무게중심이 밖이면 그 높이의 가장 긴 수평 구간 중점
function pointOnSurface(ps) {
  let A = 0, cx = 0, cy = 0;
  for (const p of ps) {
    const r = p[0];
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
      A += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f;
    }
  }
  const c = A ? [cx / (3 * A), cy / (3 * A)] : ps[0][0][0];
  if (inside(c, ps)) return c;
  const y = c[1], xs = [];
  for (const p of ps) for (const r of p) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > y) !== (r[j][1] > y)) xs.push(r[i][0] + ((y - r[i][1]) * (r[j][0] - r[i][0])) / (r[j][1] - r[i][1]));
  }
  xs.sort((a, b) => a - b);
  let best = null;
  for (let k = 0; k + 1 < xs.length; k += 2) if (!best || xs[k + 1] - xs[k] > best[1] - best[0]) best = [xs[k], xs[k + 1]];
  return best ? [(best[0] + best[1]) / 2, y] : ps[0][0][0];
}
function segDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
// 대상 집합(선분 묶음 + bbox)까지 최단거리. 폴리곤 안이면 0
function makeTargets(items) { return items.map((it) => ({ ...it, segs: it.segs, b: it.b })); }
function nearest(pt, targets) {
  let best = Infinity;
  for (const t of targets) {
    const dxb = Math.max(t.b[0] - pt[0], 0, pt[0] - t.b[2]), dyb = Math.max(t.b[1] - pt[1], 0, pt[1] - t.b[3]);
    if (Math.hypot(dxb, dyb) >= best) continue;
    if (t.polys && inside(pt, t.polys)) return 0;
    for (const [a, b] of t.segs) { const d = segDist(pt, a, b); if (d < best) best = d; }
  }
  return best;
}
const polySegs = (ps) => ps.flatMap((p) => p.flatMap((r) => r.slice(1).map((v, i) => [r[i], v])));
const lineSegs = (ls) => ls.flatMap((l) => l.slice(1).map((v, i) => [l[i], v]));
const lineBbox = (ls) => { let b = [Infinity, Infinity, -Infinity, -Infinity]; ls.forEach((l) => l.forEach(([x, y]) => { b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; })); return b; };

// 점수 척도: le = 값이 작을수록 좋음(거리·경사), ge = 클수록 좋음(건축물 수 등). 못 미치면 1점
const le = (v, steps) => { for (const [lim, s] of steps) if (v <= lim) return s; return 1; };
const ge = (v, steps) => { for (const [lim, s] of steps) if (v >= lim) return s; return 1; };
const clamp = (v) => Math.max(1, Math.min(5, v));
const r2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- 대상지·필지
const sitePolys = src.site.json.features.flatMap((f) => polys(f.geometry));
const siteName = src.site.json.features[0]?.properties?.full_nm ?? C.site;
const jimokOf = (jibun = '') => { const m = String(jibun).match(/([가-힣]+)\s*$/); const k = m ? m[1] : '?'; return k.startsWith('도') ? '도' : k; };

const parcels = src.parcels.json.features.map((f) => {
  const ps = polys(f.geometry);
  return { f, ps, b: bboxOf(ps), area: area(ps), pt: pointOnSurface(ps), jimok: jimokOf(f.properties.jibun), jiga: Number(f.properties.jiga) || null };
});

// 용도지역·지구 (대표점 포함 여부)
// 고시연도(dyear)·고시번호(dnum)는 지표 ④ 고시 이력에 씀
const shape = (kind) => (f) => ({ kind, name: f.properties.uname, dyear: f.properties.dyear ?? '', dnum: f.properties.dnum ?? '', ps: polys(f.geometry) });
const zoneShapes = src.zones.flatMap((z) => z.json.features.map(shape('용도지역')));
const districtShapes = src.districts.flatMap((z) => z.json.features.map(shape('용도지구')));
zoneShapes.forEach((z) => (z.b = bboxOf(z.ps)));
districtShapes.forEach((z) => (z.b = bboxOf(z.ps)));
const within = (pt, b) => pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3];
for (const p of parcels) {
  p.zoneShape = zoneShapes.find((z) => within(p.pt, z.b) && inside(p.pt, z.ps)) ?? null;
  p.zone = p.zoneShape?.name ?? '미확인';
  p.districtShapes = districtShapes.filter((z) => within(p.pt, z.b) && inside(p.pt, z.ps));
  p.districts = p.districtShapes.map((z) => z.name);
}

// ---------------------------------------------------------------- 도로·IC·교차점
const roadFeats = src.roads.json.features.map((f) => {
  const ls = lines(f.geometry);
  return { rank: f.properties.rd_rank_h, name: f.properties.road_name, ls, segs: lineSegs(ls), b: lineBbox(ls) };
});
const isHwy = (r) => C.roads.highwayRanks.includes(r.rank);
const isArt = (r) => C.roads.arterialRanks.includes(r.rank);
const tLocal = makeTargets(roadFeats.filter((r) => !isHwy(r)));
const tArterial = makeTargets(roadFeats.filter(isArt));
const tHighway = makeTargets(roadFeats.filter(isHwy));

// 간선 교차점: 간선 링크 끝점에 서로 다른 도로 링크가 3개 이상 모이는 점
const ends = new Map();
const keyOf = ([x, y]) => `${Math.round(x)}:${Math.round(y)}`;
roadFeats.filter((r) => !isHwy(r)).forEach((r, idx) => r.ls.forEach((l) => [l[0], l.at(-1)].forEach((pt) => {
  const k = keyOf(pt);
  if (!ends.has(k)) ends.set(k, { pt, links: new Set(), art: false });
  const e = ends.get(k); e.links.add(idx); e.art ||= isArt(r);
})));
const nodes = [...ends.values()].filter((e) => e.art && e.links.size >= 3).map((e) => e.pt);

// 대상지 주변 searchKm 안의 IC(나들목)를 검색해 가장 가까운 IC까지 거리를 씀. 좌표는 저장하지 않음
async function findICs() {
  const key = process.env.VWORLD_KEY?.trim();
  if (!key) return { pts: [], why: 'VWORLD_KEY 없음' };
  const k = C.roads.ic.searchKm;
  const box = [bb[0] - (k * 1000) / KX, bb[1] - (k * 1000) / KY, bb[2] + (k * 1000) / KX, bb[3] + (k * 1000) / KY].map((v) => v.toFixed(5)).join(',');
  const titleRe = new RegExp(C.roads.ic.titlePattern), catRe = new RegExp(C.roads.ic.categoryPattern);
  const found = new Map();
  try {
    for (let page = 1; page <= 3; page++) {
      const p = new URLSearchParams({ service: 'search', request: 'search', version: '2.0', crs: 'EPSG:4326', size: '100', page: String(page),
        query: C.roads.ic.query, type: 'place', bbox: box, format: 'json', errorformat: 'json', key });
      if (process.env.VWORLD_DOMAIN) p.set('domain', process.env.VWORLD_DOMAIN.trim());
      const r = JSON.parse(await (await fetch('https://api.vworld.kr/req/search?' + p, { signal: AbortSignal.timeout(20_000) })).text()).response;
      if (r.status !== 'OK') break;
      for (const i of r.result?.items ?? []) if (titleRe.test(i.title) && catRe.test(i.category) && !found.has(i.title)) found.set(i.title, P([Number(i.point.x), Number(i.point.y)]));
      if (page >= Number(r.page?.total ?? 1)) break;
    }
  } catch (e) { return { pts: [], why: `검색 실패: ${e.message}` }; }
  return found.size ? { pts: [...found.values()], names: [...found.keys()], why: `${found.size}곳` } : { pts: [], why: '반경 안 IC 없음' };
}
const ic = await findICs();
if (!ic.pts.length) console.warn(`! IC를 못 찾아 공업 접근성은 간선도로만 봅니다 — ${ic.why}`);
const nearestIC = (pt) => {
  let best = Infinity, name = null;
  ic.pts.forEach((q, i) => { const d = Math.hypot(q[0] - pt[0], q[1] - pt[1]); if (d < best) { best = d; name = ic.names[i]; } });
  return { d: best, name };
};

// ---------------------------------------------------------------- 건물·주변 필지 범주
const bldPts = src.buildings.json.features.map((f) => pointOnSurface(polys(f.geometry)));
const countWithin = (pt, pts, R) => { let n = 0; for (const q of pts) if (Math.abs(q[0] - pt[0]) <= R && Math.abs(q[1] - pt[1]) <= R && Math.hypot(q[0] - pt[0], q[1] - pt[1]) <= R) n++; return n; };
const targetsByJimok = (list) => makeTargets(parcels.filter((p) => list.includes(p.jimok)).map((p) => ({ polys: p.ps, segs: polySegs(p.ps), b: p.b })));
const tGreen = targetsByJimok(C.classes.greenJimok);
const tFactory = targetsByJimok(C.classes.factoryJimok);
const tSchool = targetsByJimok(C.classes.schoolJimok);

// ---------------------------------------------------------------- DEM: 경사(%)·향(°)·표고
const D = src.dem.json;
const [nx, ny] = D.size, [dLon, dLat] = D.step, [x0, y0] = D.origin;
const dx = dLon * KX, dy = dLat * KY;
const Z = (i, j) => D.elevation[Math.max(0, Math.min(ny - 1, j)) * nx + Math.max(0, Math.min(nx - 1, i))];
const cells = [];
for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
  // Horn 3×3. 행 j는 남→북
  const a = Z(i - 1, j + 1), b = Z(i, j + 1), c = Z(i + 1, j + 1), d = Z(i - 1, j), f = Z(i + 1, j), g = Z(i - 1, j - 1), h = Z(i, j - 1), k = Z(i + 1, j - 1);
  const gx = ((c + 2 * f + k) - (a + 2 * d + g)) / (8 * dx);   // 동쪽으로 오를 때 +
  const gy = ((a + 2 * b + c) - (g + 2 * h + k)) / (8 * dy);   // 북쪽으로 오를 때 +
  const slope = 100 * Math.hypot(gx, gy);
  const aspect = (Math.atan2(-gx, -gy) * 180 / Math.PI + 360) % 360; // 내리막 방향, 북 0° 시계방향
  cells.push({ pt: P([x0 + i * dLon, y0 + j * dLat]), z: Z(i, j), gx, gy, slope, aspect });
}
const cellIn = (pt, ps, b) => within(pt, b) && inside(pt, ps);
const siteB = bboxOf(sitePolys);
const siteCells = cells.filter((c) => cellIn(c.pt, sitePolys, siteB));
const zAt = ([x, y]) => { // 양선형 보간
  const [lon, lat] = unP([x, y]); const fi = (lon - x0) / dLon, fj = (lat - y0) / dLat;
  const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
  return Z(i, j) * (1 - u) * (1 - v) + Z(i + 1, j) * u * (1 - v) + Z(i, j + 1) * (1 - u) * v + Z(i + 1, j + 1) * u * v;
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN; };
const roadZ = roadFeats.filter((r) => !isHwy(r)).flatMap((r) => r.ls.flat()).filter((pt) => inside(pt, sitePolys)).map(zAt);
const baseZ = median(roadZ);
const zLimit = baseZ + C.terrain.elevAboveBaseM;
const isSouth = (asp) => asp >= C.terrain.aspectSouth[0] && asp <= C.terrain.aspectSouth[1];

for (const p of parcels) {
  let cs = cells.filter((c) => cellIn(c.pt, p.ps, p.b));
  if (!cs.length) { let best = null, bd = Infinity; for (const c of cells) { const d = Math.hypot(c.pt[0] - p.pt[0], c.pt[1] - p.pt[1]); if (d < bd) { bd = d; best = c; } } cs = [best]; }
  const mean = (fn) => cs.reduce((s, c) => s + fn(c), 0) / cs.length;
  p.slope = mean((c) => c.slope);
  const gx = mean((c) => c.gx), gy = mean((c) => c.gy);
  p.aspect = (Math.atan2(-gx, -gy) * 180 / Math.PI + 360) % 360;
  p.elev = zAt(p.pt);
  p.demCells = cs.length;
}

// ---------------------------------------------------------------- 분류: 기존 시설 → 녹지 선확정 → 개발가능
const G = C.classes.green;
for (const p of parcels) {
  if (C.classes.facilityJimok.includes(p.jimok)) { p.status = 'facility'; p.reason = `기존 시설(지목 ${p.jimok})`; continue; }
  const why = [];
  if (G.zones.includes(p.zone)) why.push(p.zone);
  p.districts.filter((d) => G.districts.includes(d)).forEach((d) => why.push(d));
  if (p.slope > G.maxSlopePct) why.push(`경사 ${p.slope.toFixed(1)}% > ${G.maxSlopePct}%`);
  p.status = why.length ? 'green' : 'dev';
  p.reason = why.length ? `녹지 선확정: ${why.join(', ')}` : '개발가능';
}

// ---------------------------------------------------------------- 4축 채점 (개발가능 필지)
const dev = parcels.filter((p) => p.status === 'dev');
const devPts = parcels.map((p) => ({ pt: p.pt, area: p.area, undev: C.classes.undevJimok.includes(p.jimok) }));
const T = C.terrain, A = C.access, E = C.env, I = C.infra;

for (const p of dev) {
  const m = {
    road: nearest(p.pt, tLocal),
    arterial: nearest(p.pt, tArterial),
    highway: tHighway.length ? nearest(p.pt, tHighway) : Infinity,
    node: nodes.length ? Math.min(...nodes.map((n) => Math.hypot(n[0] - p.pt[0], n[1] - p.pt[1]))) : Infinity,
    ic: ic.pts.length ? nearestIC(p.pt).d : null,
    icName: ic.pts.length ? nearestIC(p.pt).name : null,
    green: nearest(p.pt, tGreen),
    factory: tFactory.length ? nearest(p.pt, tFactory) : Infinity,
    school: tSchool.length ? nearest(p.pt, tSchool) : Infinity,
    bld300: countWithin(p.pt, bldPts, 300),
    bld500: countWithin(p.pt, bldPts, 500),
  };
  // 반경 200m 미개발지(전·답·과·목·임·잡) 면적 비율 — 공업 확장 여지
  let tot = 0, und = 0;
  for (const q of devPts) if (Math.abs(q.pt[0] - p.pt[0]) <= 200 && Math.abs(q.pt[1] - p.pt[1]) <= 200 && Math.hypot(q.pt[0] - p.pt[0], q.pt[1] - p.pt[1]) <= 200) { tot += q.area; if (q.undev) und += q.area; }
  m.undev200 = tot ? und / tot : 0;
  p.m = m;

  const steep = p.slope > T.aspectAppliesAbovePct && !isSouth(p.aspect);
  const high = p.elev > zLimit;
  const s = {
    res: {
      terrain: Math.min(high ? 2 : 5, clamp(le(p.slope, T.slope.res) - (steep ? 1 : 0))),
      access: (le(m.road, A.res.road) + le(m.arterial, A.res.arterial)) / 2,
      env: clamp(E.res.base + (m.green <= E.res.greenM ? 1 : 0)
        + (m.factory < E.res.polluted.factoryM || m.highway < E.res.polluted.highwayM ? -2
          : m.factory >= E.res.clean.factoryM && m.highway >= E.res.clean.highwayM ? 1 : 0)),
      infra: ge(m.bld300, I.res.bld300),
    },
    com: {
      terrain: Math.min(high ? 2 : 5, le(p.slope, T.slope.com)),
      // 일반상업(간선 교차점)과 근린상업(주거지 인접 + 생활도로 접면) 중 높은 값
      access: Math.min(m.road > A.com.roadFrontMaxM ? A.com.capIfNoFront : 5,
        Math.max(le(m.node, A.com.node), m.bld300 >= A.com.neighborhood.minBld300 ? le(m.road, A.com.neighborhood.road) : 1)),
      env: clamp(E.com.base + (m.green <= E.com.greenM ? 1 : 0) - (m.factory < E.com.factoryM ? 1 : 0)),
      infra: clamp(ge(m.bld500, I.com.bld500) + (m.school <= I.com.schoolM ? 1 : 0)),
    },
    ind: {
      terrain: Math.min(high ? 2 : 5, le(p.slope, T.slope.ind)),
      access: m.ic == null ? le(m.arterial, A.ind.arterial) : (le(m.arterial, A.ind.arterial) + le(m.ic, A.ind.ic)) / 2,
      env: clamp((le(m.bld300, E.ind.bld300) + ge(m.undev200, E.ind.undev200)) / 2 - (m.school < E.ind.schoolM ? 1 : 0)),
      infra: ge(m.bld300, I.ind.bld300),
    },
  };
  p.axis = s;
  p.score = Object.fromEntries(USES.map((u) => [u, AXES.reduce((t, a) => t + C.weights[a] * s[u][a], 0)]));
}

// ---------------------------------------------------------------- 대상지 판정·매트릭스
const wsum = AXES.reduce((t, a) => t + C.weights[a], 0);
if (Math.abs(wsum - 1) > 1e-6) throw new Error(`가중치 합이 1.00이 아닙니다: ${wsum}`);
const devArea = dev.reduce((t, p) => t + p.area, 0);
const totalArea = parcels.reduce((t, p) => t + p.area, 0);
const awMean = (fn) => dev.reduce((t, p) => t + fn(p) * p.area, 0) / devArea;
const matrix = Object.fromEntries(USES.map((u) => [u, Object.fromEntries(AXES.map((a) => [a, awMean((p) => p.axis[u][a])]))]));
const totals = Object.fromEntries(USES.map((u) => [u, AXES.reduce((t, a) => t + C.weights[a] * matrix[u][a], 0)]));
const suitableShare = Object.fromEntries(USES.map((u) => [u, dev.filter((p) => p.score[u] >= C.suitableScore).reduce((t, p) => t + p.area, 0) / devArea]));
const ranking = [...USES].sort((a, b) => totals[b] - totals[a]);

// 가중치 역전점: 축 a의 가중치를 x로 바꾸고 나머지 축은 원래 비율대로 1−x를 나눔
function reversal(u1, u2) {
  return AXES.map((a) => {
    const w = C.weights[a];
    const rest = (u) => AXES.filter((b) => b !== a).reduce((t, b) => t + C.weights[b] * matrix[u][b], 0) / (1 - w);
    const dA = matrix[u1][a] - matrix[u2][a], dR = rest(u1) - rest(u2);
    const den = dR - dA;
    const x = den !== 0 ? dR / den : null;
    const valid = x != null && x >= 0 && x <= 1;
    return { axis: a, current: w, reversalAt: valid ? x : null, direction: valid ? (dA < dR ? '올리면' : '내리면') : null };
  });
}
const rev = [[ranking[0], ranking[1]], [ranking[0], ranking[2]]].map(([a, b]) => ({ first: a, other: b, rows: reversal(a, b) }));

// ---------------------------------------------------------------- 배분 대안 2개
// 대안 1 강의 순서(녹지→공업→상업→주거, 44번)  대안 2 필지별 최고점
for (const p of parcels) {
  if (p.status !== 'dev') { p.allocOrder = p.allocBest = p.status; continue; }
  p.allocOrder = ['ind', 'com', 'res'].find((u) => p.score[u] >= C.allocationPass[u]) ?? 'hold';
  const top = [...USES].sort((a, b) => p.score[b] - p.score[a])[0];
  p.best = top;
  p.allocBest = p.score[top] >= C.allocationPass[top] ? top : 'hold';
}
const composition = (key) => {
  const out = {};
  for (const p of parcels) out[p[key]] = (out[p[key]] ?? 0) + p.area;
  return out;
};
const allocOrder = composition('allocOrder'), allocBest = composition('allocBest');

// ---------------------------------------------------------------- 지표 ⑥ 경사·향 적합면적 비율
const cellHa = (D.cellM * D.cellM) / 10000;
const ind6 = T.indicator6Thresholds.map((th) => {
  const slopeOnly = siteCells.filter((c) => c.slope <= th).length;
  const full = siteCells.filter((c) => c.slope <= th && (c.slope < T.flatPct || isSouth(c.aspect)) && c.z <= zLimit).length;
  return { threshold: th, cells: siteCells.length, slopeOnlyPct: (100 * slopeOnly) / siteCells.length, fullPct: (100 * full) / siteCells.length, fullHa: full * cellHa };
});

// ---------------------------------------------------------------- 저장
await mkdir(outDir, { recursive: true });
const runAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00';
const nm = (u) => C.uses[u]?.name ?? { facility: '기존 시설', green: '녹지 선확정', hold: '유보', dev: '개발가능' }[u] ?? u;
const ha = (m2) => m2 / 10000;
// 받침에 맞는 조사: josa('상업', '이', '가') → '상업이'
const josa = (w, withB, noB) => { const c = w.charCodeAt(w.length - 1) - 0xac00; return w + (c >= 0 && c <= 11171 && c % 28 ? withB : noB); };
const csv = (rows) => '﻿' + rows.map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n') + '\r\n';
const sumArea = (list) => list.reduce((t, p) => t + p.area, 0);

// ---------------------------------------------------------------- 지표 대시보드 ①~⑥ (38번)
// 법정동·리 코드 = 필지 PNU 앞 10자리(가장 많은 값). indicators.json의 팀 기입 값은 이 코드로 찾음
const siteCode = (() => { const c = {}; parcels.forEach((p) => { const k = String(p.f.properties.pnu).slice(0, 10); c[k] = (c[k] ?? 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''; })();
const manual = manualAll[siteCode] ?? {};
const IND = C.indicators;
const day = (s) => (s ?? '').slice(0, 10);
const zoneDate = day(src.zones[0]?.meta?.queriedAt);

// ③ 용도지역 구성비 (필지 대표점이 속한 용도지역 기준)
const zoneArea = {};
parcels.forEach((p) => (zoneArea[p.zone] = (zoneArea[p.zone] ?? 0) + p.area));
const ind3 = Object.entries(zoneArea).sort((a, b) => b[1] - a[1]).map(([zone, a]) => ({ zone, ha: r2(ha(a)), pct: r2((100 * a) / totalArea) }));

// ③×⑥ 중첩: 용도지역별 경사·향·표고 충족 셀 비율 → 현행 지정과 지형 적합의 불일치
const ovTh = IND.overlayThresholdPct;
const okCell = (c) => c.slope <= ovTh && (c.slope < T.flatPct || isSouth(c.aspect)) && c.z <= zLimit;
// 불일치 판정은 경사만 본다 — 남향·표고 조건은 주거 요건이라 상업·공업·보전 지정 판정에 쓰면 평지 시가지도 '불리'가 됨
const ov = {};
for (const c of siteCells) {
  const z = zoneShapes.find((s) => within(c.pt, s.b) && inside(c.pt, s.ps))?.name ?? '미확인';
  const e = (ov[z] ??= { cells: 0, ok: 0, slopeOk: 0 });
  e.cells++; if (okCell(c)) e.ok++; if (c.slope <= ovTh) e.slopeOk++;
}
const MM = IND.mismatch;
const overlay = Object.entries(ov).sort((a, b) => b[1].cells - a[1].cells).map(([zone, e]) => {
  const pct = (100 * e.ok) / e.cells, slopePct = (100 * e.slopeOk) / e.cells;
  const urban = MM.urbanZones.some((k) => zone.includes(k));
  const flag = urban && slopePct < MM.urbanLowPct ? '지정 대비 경사 불리'
    : MM.conserveZones.includes(zone) && slopePct >= MM.conserveHighPct ? '경사상 개발 가능 · 보전 지정' : '';
  return { zone, cells: e.cells, ha: r2(e.cells * cellHa), okPct: r2(pct), slopeOkPct: r2(slopePct), flag };
});

// ④ 고시 이력: 대상지 필지에 걸린 용도지역·지구의 고시연도·번호
const hist = new Map();
for (const p of parcels) for (const s of [p.zoneShape, ...p.districtShapes].filter(Boolean)) {
  const k = [s.kind, s.name, s.dyear, s.dnum].join('|');
  const e = hist.get(k) ?? { kind: s.kind, name: s.name, dyear: s.dyear, dnum: s.dnum, area: 0, parcels: 0 };
  e.area += p.area; e.parcels++; hist.set(k, e);
}
const ind4 = [...hist.values()].sort((a, b) => String(b.dyear).localeCompare(String(a.dyear)) || b.area - a.area)
  .map((e) => ({ ...e, ha: r2(ha(e.area)), area: undefined }));

// ⑤ 용도별 소요면적: 교과서 기준과 실측 병기
const tb = IND.textbookResidentialShare;
const pop = Number(manual.targetPopulation) || null;
const ind5 = {
  devHa: r2(ha(devArea)),
  textbookRes: [r2(ha(devArea * tb[0])), r2(ha(devArea * tb[1]))],
  resZoneHa: r2(ha(sumArea(parcels.filter((p) => p.zone.includes('주거'))))),
  allocOrderResHa: r2(ha(allocOrder.res ?? 0)),
  allocBestResHa: r2(ha(allocBest.res ?? 0)),
  park: pop ? { population: pop, requiredHa: r2((pop * IND.parkPerCapitaM2) / 10000), currentHa: r2(ha(sumArea(parcels.filter((p) => p.jimok === '공')))) } : null,
};

const mc = manual.climate ?? {}, cl = src.climate?.json;
const i6 = Object.fromEntries(ind6.map((r) => [r.threshold, r2(r.fullPct)]));
const dashboard = [
  mc.meanTempC != null
    ? { no: '①', name: '기온·강수', status: '확보', value: `${mc.meanTempC}℃ · ${mc.meanPrecipMm}mm/년`, source: mc.source, date: mc.date, note: mc.period }
    : cl ? { no: '①', name: '기온·강수', status: '확보(참고값)', value: `${cl.meanTempC}℃ · ${cl.meanPrecipMm}mm/년`, source: cl.source, date: day(cl.queriedAt), note: `${cl.period} 평균 · 기상청 값으로 바꿀 것` }
      : { no: '①', name: '기온·강수', status: '조회 대기', value: '', source: 'climate.mjs 또는 indicators.json', date: '', note: '' },
  manual.popDensity?.value != null
    ? { no: '②', name: '격자 인구밀도', status: '확보', value: `${manual.popDensity.value} ${manual.popDensity.unit ?? ''}`, source: manual.popDensity.source, date: manual.popDensity.date, note: '' }
    : { no: '②', name: '격자 인구밀도', status: '팀 기입 대기', value: '', source: 'SGIS 격자 통계 등 → indicators.json', date: '', note: `코드 ${siteCode}` },
  { no: '③', name: '용도지역 구성비', status: '확보', value: ind3.slice(0, 2).map((z) => `${z.zone} ${z.pct}%`).join(' · '), source: '브이월드 LT_C_UQ111~114', date: zoneDate, note: `${ind3.length}종` },
  { no: '④', name: '고시 이력', status: '열람', value: ind4.length ? `${ind4.length}건 · 최근 ${ind4[0].dyear}년` : '없음', source: '브이월드 속성(dyear·dnum) — 토지이음 열람으로 확인', date: zoneDate, note: '' },
  { no: '⑤', name: '용도별 소요면적', status: '병기', value: `주거 교과서 ${ind5.textbookRes[0]}~${ind5.textbookRes[1]}ha · 실측 ${ind5.resZoneHa}ha`, source: '교과서(원본 18번)·실측(현행 지정·배분안)', date: day(runAt), note: pop ? `목표인구 ${pop}명` : '목표인구 미기입' },
  { no: '⑥', name: '경사·향 적합', status: '확보(임시 DEM)', value: T.indicator6Thresholds.map((t) => `${t}% ${i6[t]}%`).join(' · '), source: D.source, date: day(D.queriedAt), note: `${D.cellM}m 셀` },
];

// 검색한 주소의 필지
const tp = target.pnu ? parcels.find((p) => String(p.f.properties.pnu) === target.pnu) : null;
const pctRank = (u, v) => r2((100 * dev.filter((q) => q.score[u] > v).length) / dev.length); // 상위 몇 %
const targetInfo = !target.pnu ? null : !tp ? { label: target.label, pnu: target.pnu, missing: true } : {
  label: target.label, pnu: target.pnu, addr: tp.f.properties.addr, jimok: tp.jimok, zone: tp.zone, districts: tp.districts.join('·'),
  areaM2: Math.round(tp.area), jiga: tp.jiga, slope: r2(tp.slope), aspect: Math.round(tp.aspect), elev: Math.round(tp.elev),
  status: nm(tp.status), reason: tp.reason,
  scores: tp.score ? Object.fromEntries(USES.map((u) => [nm(u), r2(tp.score[u])])) : null,
  axis: tp.axis ? Object.fromEntries(USES.map((u) => [nm(u), Object.fromEntries(AXES.map((a) => [C.axes[a], r2(tp.axis[u][a])]))])) : null,
  topPct: tp.score ? Object.fromEntries(USES.map((u) => [nm(u), pctRank(u, tp.score[u])])) : null,
  best: tp.best ? nm(tp.best) : null, allocOrder: nm(tp.allocOrder), allocBest: nm(tp.allocBest),
  metrics: tp.m ? { 생활도로: Math.round(tp.m.road), 간선도로: Math.round(tp.m.arterial), 간선교차점: Math.round(tp.m.node), IC: tp.m.ic == null ? null : Math.round(tp.m.ic), IC이름: tp.m.icName, 건축물300m: tp.m.bld300, 건축물500m: tp.m.bld500, 녹지수변: Math.round(tp.m.green), 공장: Number.isFinite(tp.m.factory) ? Math.round(tp.m.factory) : null, 대학: Number.isFinite(tp.m.school) ? Math.round(tp.m.school) : null } : null,
};
if (target.pnu && !tp) console.warn(`! 검색한 필지 ${target.pnu}가 대상지 필지 목록에 없습니다.`);

const summary = {
  site: siteName, runAt, approval: C.approval, weights: C.weights,
  areaHa: { parcels: r2(ha(totalArea)), dev: r2(ha(devArea)),
    green: r2(ha(parcels.filter((p) => p.status === 'green').reduce((t, p) => t + p.area, 0))),
    facility: r2(ha(parcels.filter((p) => p.status === 'facility').reduce((t, p) => t + p.area, 0))) },
  counts: { parcels: parcels.length, dev: dev.length },
  ranking: ranking.map((u) => ({ use: nm(u), score: r2(totals[u]), suitableSharePct: r2(100 * suitableShare[u]) })),
  margin: r2(totals[ranking[0]] - totals[ranking[1]]),
  matrix: Object.fromEntries(USES.map((u) => [nm(u), Object.fromEntries(AXES.map((a) => [C.axes[a], r2(matrix[u][a])]))])),
  reversal: rev.map((r) => ({ first: nm(r.first), other: nm(r.other), rows: r.rows.map((x) => ({ axis: C.axes[x.axis], current: x.current, reversalAt: x.reversalAt == null ? null : r2(x.reversalAt), direction: x.direction })) })),
  allocation: { order: Object.fromEntries(Object.entries(allocOrder).map(([k, v]) => [nm(k), r2(ha(v))])), best: Object.fromEntries(Object.entries(allocBest).map(([k, v]) => [nm(k), r2(ha(v))])) },
  indicator6: { dem: D.source, demQueriedAt: D.queriedAt, cellM: D.cellM, baseElevM: r2(baseZ), elevLimitM: r2(zLimit), rows: ind6.map((r) => ({ ...r, slopeOnlyPct: r2(r.slopeOnlyPct), fullPct: r2(r.fullPct), fullHa: r2(r.fullHa) })) },
  ic: { query: C.roads.ic.query, searchKm: C.roads.ic.searchKm, found: ic.pts.length ? ic.names.join(', ') : null, why: ic.why },
  arterialNodes: nodes.length,
  siteCode, dashboard, ind3, overlay, overlayThresholdPct: ovTh, ind4, ind5, climate: cl ?? null, target: targetInfo,
  inputs: Object.fromEntries(Object.entries(src).filter(([, v]) => v).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => x.file) : v.file])),
};
await writeFile(join(outDir, 'indicators.csv'), csv([
  ['지표', '이름', '상태', '값', '출처', '조회일', '비고'],
  ...dashboard.map((d) => [d.no, d.name, d.status, d.value, d.source, d.date, d.note]),
  [],
  ['⑥ 카탈로그 한 행', '값(%) 10%', '값(%) 15%', '값(%) 25%', '임계값', 'DEM', '브이월드 레이어', '조회일'],
  ['⑥ 경사·향 적합', i6[10], i6[15], i6[25], T.indicator6Thresholds.join('·') + '%', `${D.source} · ${D.cellM}m`, src.site.file.replace(/_\d{4}-\d{2}-\d{2}\.geojson$/, ''), `DEM ${day(D.queriedAt)} · 경계 ${day(src.site.meta?.queriedAt)}`],
  [],
  [`③×⑥ 중첩`, '셀 수', '면적(ha)', `⑥ 경사 ${ovTh}%·향·표고 충족(%)`, `경사 ${ovTh}% 이하(%)`, '판정(경사 기준)'],
  ...overlay.map((o) => [o.zone, o.cells, o.ha, o.okPct, o.slopeOkPct, o.flag]),
  [],
  ['④ 고시 이력', '구분', '고시연도', '고시번호', '필지 수', '면적(ha)'],
  ...ind4.map((e) => [e.name, e.kind, e.dyear, e.dnum, e.parcels, e.ha]),
  [],
  ['⑤ 소요면적', '값(ha)', '근거'],
  ['개발가능지', ind5.devHa, '녹지 선확정·기존 시설 제외'],
  ['주거 소요(교과서)', `${ind5.textbookRes[0]}~${ind5.textbookRes[1]}`, IND.textbookNote],
  ['주거 현행 지정(실측)', ind5.resZoneHa, '용도지역 주거 계열'],
  ['주거 배분 대안 1·2', `${ind5.allocOrderResHa} · ${ind5.allocBestResHa}`, '강의 순서 · 최고점'],
  ...(ind5.park ? [['공원 소요 / 현황', `${ind5.park.requiredHa} / ${ind5.park.currentHa}`, `${IND.parkNote} · 목표인구 ${ind5.park.population}명`]] : []),
]));
await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(join(outDir, 'criteria_used.json'), JSON.stringify(C, null, 2));

await writeFile(join(outDir, 'matrix.csv'), csv([
  ['축', '가중치', ...USES.map(nm), '근거(요건 문장)'],
  ...AXES.map((a) => [C.axes[a], C.weights[a], ...USES.map((u) => r2(matrix[u][a])), USES.map((u) => `${nm(u)}: ${C.requirements[u][a].req}`).join(' / ')]),
  ['가중 합계(5점)', r2(wsum), ...USES.map((u) => r2(totals[u])), ''],
  ['순위', '', ...USES.map((u) => ranking.indexOf(u) + 1), ''],
  [`적합 면적 비율(%·${C.suitableScore}점 이상)`, '', ...USES.map((u) => r2(100 * suitableShare[u])), ''],
  [], ['대상지', siteName], ['개발가능 면적(ha)', r2(ha(devArea))], ['가중치 승인', C.approval.approved ? `승인 ${C.approval.by} ${C.approval.date}` : '승인 전 — 시험 계산'], ['계산 일시', runAt],
]));
await writeFile(join(outDir, 'reversal.csv'), csv([
  ['비교', '축', '현재 가중치', '역전 가중치', '해석'],
  ...rev.flatMap((r) => r.rows.map((x) => [`${nm(r.first)} vs ${nm(r.other)}`, C.axes[x.axis], x.current, x.reversalAt == null ? '' : r2(x.reversalAt),
    x.reversalAt == null ? '0~1 범위에서 역전 없음' : `${C.axes[x.axis]} 가중치를 ${r2(x.reversalAt)} ${x.direction === '올리면' ? '넘게 올리면' : '아래로 내리면'} ${josa(nm(r.other), '이', '가')} ${josa(nm(r.first), '을', '를')} 앞섬`])),
]));
await writeFile(join(outDir, 'indicator6.csv'), csv([
  ['지표', '경사 임계값(%)', '향 조건', '표고 조건', '경사만 충족(%)', '경사·향·표고 충족(%)', '충족 면적(ha)', '셀 수', 'DEM', '해상도', 'DEM 조회일'],
  ...ind6.map((r) => ['⑥ 경사·향 적합면적 비율', r.threshold, `${T.aspectSouth[0]}~${T.aspectSouth[1]}° (경사 ${T.flatPct}% 미만 평지는 향 무관)`, `≤ ${r2(zLimit)}m (기반시설 ${r2(baseZ)}m +${T.elevAboveBaseM}m)`,
    r2(r.slopeOnlyPct), r2(r.fullPct), r2(r.fullHa), r.cells, D.source, `${D.cellM}m`, D.queriedAt]),
]));

const axisCols = USES.flatMap((u) => AXES.map((a) => `${nm(u)}_${C.axes[a]}`));
await writeFile(join(outDir, 'parcels.csv'), csv([
  ['PNU', '주소', '지목', '용도지역', '용도지구', '면적(㎡)', '공시지가(원/㎡)', '경사(%)', '향(°)', '표고(m)', '분류', '사유', ...axisCols, ...USES.map((u) => `${nm(u)}_점수`), '최고점 용도', '강의 순서 배분', '최고점 배분'],
  ...parcels.map((p) => [p.f.properties.pnu, p.f.properties.addr, p.jimok, p.zone, p.districts.join('·'), Math.round(p.area), p.jiga, r2(p.slope), Math.round(p.aspect), Math.round(p.elev),
    nm(p.status), p.reason,
    ...USES.flatMap((u) => AXES.map((a) => (p.axis ? r2(p.axis[u][a]) : ''))), ...USES.map((u) => (p.score ? r2(p.score[u]) : '')),
    p.best ? nm(p.best) : '', nm(p.allocOrder), nm(p.allocBest)]),
]));

const round6 = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6] : c.map(round6));
const parcelsGeo = { type: 'FeatureCollection', features: parcels.map((p) => ({ type: 'Feature', geometry: { type: p.f.geometry.type, coordinates: round6(p.f.geometry.coordinates) },
  properties: { pnu: p.f.properties.pnu, addr: p.f.properties.addr, jimok: p.jimok, zone: p.zone, districts: p.districts.join('·'), area: Math.round(p.area), slope: r2(p.slope), aspect: Math.round(p.aspect), elev: Math.round(p.elev),
    status: p.status, reason: p.reason, best: p.best ?? null, allocOrder: p.allocOrder, allocBest: p.allocBest, target: p === tp || undefined,
    ...(p.score ? Object.fromEntries(USES.map((u) => [u, r2(p.score[u])])) : {}),
    ...(p.axis ? Object.fromEntries(USES.flatMap((u) => AXES.map((a) => [`${u}_${a}`, r2(p.axis[u][a])]))) : {}) } })) };
await writeFile(join(outDir, 'parcels.geojson'), JSON.stringify(parcelsGeo));

// 보고서
const tpl = await readFile(new URL('./report.template.html', import.meta.url), 'utf8');
const siteGeo = { type: 'FeatureCollection', features: src.site.json.features.map((f) => ({ type: 'Feature', properties: {}, geometry: { type: f.geometry.type, coordinates: round6(f.geometry.coordinates) } })) };
await writeFile(join(outDir, 'report.html'), tpl
  .replace('/*__DATA__*/', `const SUMMARY = ${JSON.stringify(summary)};\nconst CRITERIA = ${JSON.stringify(C)};\nconst PARCELS = ${JSON.stringify(parcelsGeo)};\nconst SITE = ${JSON.stringify(siteGeo)};`)
  .replaceAll('__SITE__', siteName));

// ---------------------------------------------------------------- 콘솔 요약
console.log(`⑤ 적합도 판정 — ${siteName}`);
console.log(`  필지 ${parcels.length} (개발가능 ${dev.length}, ${r2(ha(devArea))}ha / 녹지 선확정 ${summary.areaHa.green}ha / 기존 시설 ${summary.areaHa.facility}ha)`);
console.log(`  가중치 ${AXES.map((a) => `${C.axes[a]} ${C.weights[a]}`).join(' · ')} — ${C.approval.approved ? '승인됨' : '승인 전 시험 계산'}`);
ranking.forEach((u, i) => console.log(`  ${i + 1}위 ${nm(u)} ${r2(totals[u])}점 (적합 면적 ${r2(100 * suitableShare[u])}%)  [${AXES.map((a) => `${C.axes[a]} ${r2(matrix[u][a])}`).join(', ')}]`));
console.log(`  IC: 반경 ${C.roads.ic.searchKm}km ${ic.why} · 간선 교차점 ${nodes.length}곳 · 기반시설 표고 ${r2(baseZ)}m`);
dashboard.forEach((d) => console.log(`  지표 ${d.no} ${d.name}: ${d.status}${d.value ? ' — ' + d.value : ''}`));
if (targetInfo && !targetInfo.missing) {
  console.log(`  검색 필지 ${targetInfo.addr} (${targetInfo.jimok}, ${targetInfo.zone}): ${targetInfo.status}`
    + (targetInfo.scores ? ` · ${Object.entries(targetInfo.scores).map(([u, s]) => `${u} ${s}`).join(' / ')} → ${targetInfo.best}` : ` — ${targetInfo.reason}`));
}
console.log(`✓ ${join(outDir, 'report.html')} (+ matrix.csv · reversal.csv · indicator6.csv · indicators.csv · parcels.csv · parcels.geojson · summary.json)`);
