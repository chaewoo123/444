// 용도지역 대시보드 서버 — 전국 검색·위성지도·용도지역 분석을 브이월드에 실시간으로 묻는다.
//   node dashboard_server.js   →  http://localhost:5180
// 인증키는 이 서버만 알고(환경변수 VWORLD_KEY), 브라우저 페이지에는 내려가지 않는다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { call, getFeatures } = require('./vworld.js');
const { toLonLat, toMerc } = require('./proj5179.js');
const tiles = require('./terrain_tiles.js');
const { readImg, slopeAspect } = require('./dem.js');

const DEM_DIR = path.join(__dirname, 'dem_ngii'); // 국토지리정보원 공개DEM 도엽 (도엽번호/도엽번호.img)
const DEM_CELL = 90;
const DEM_LABEL = '국토지리정보원 공개DEM 90m (2025)';
const SLOPE_BANDS = [0, 5, 10, 15, 25]; // 경사 구간 하한(%) — 강의자료의 기준값 5·10·15·25
const URBAN = new Set(['res', 'com', 'ind']);
const RURAL = new Set(['green', 'manage', 'agri', 'nature']);
// 대안의 격자 규칙 (2026-10-12 사용자 승인). 전환 부호: 1 녹지로 전환, 2 개발 후보·공업 가능(경사 5% 이하), 3 개발 후보
const ALTERNATIVES = [
  { id: 'A', name: '보전 우선', rule: '현재 주거·상업·공업 중 경사 25% 초과 → 녹지' },
  { id: 'B', name: '개발 우선', rule: '현재 비시가화 중 경사 25% 이하 → 개발 후보', limit: 25 },
  { id: 'C', name: '절충', rule: '현재 비시가화 중 경사 15% 이하 → 개발 후보', limit: 15 },
];
const MAX_QUADS = 40000;
const memo = new Map(); // 구역별 격자(용도 번호·구역 마스크) — 솔루션 계산에 다시 쓴다

const PORT = 5180;
const KEY = process.env.VWORLD_KEY;
const DOMAIN = process.env.VWORLD_DOMAIN;
const CACHE_DIR = process.env.VERCEL ? path.join(require('os').tmpdir(), 'zoning_cache') : path.join(__dirname, 'vworld_out', 'zoning_cache');
const ZONE_SERVICES = ['LT_C_UQ111', 'LT_C_UQ112', 'LT_C_UQ113', 'LT_C_UQ114'];
const MAX_CELLS = 300000; // 구역 하나를 나누는 격자 칸 수 상한
const SLOPE_THRESHOLDS = [10, 15, 25];

// 용도지역 이름 → 큰 분류. 위에서부터 먼저 맞는 것을 쓴다.
const CATEGORIES = [
  ['res', '주거', /주거/],
  ['com', '상업', /상업/],
  ['ind', '공업', /공업/],
  ['green', '녹지', /녹지/],
  ['manage', '관리', /관리/],
  ['agri', '농림', /농림/],
  ['nature', '자연환경보전', /자연환경보전/],
  ['etc', '기타·미세분', /./],
];
const categoryOf = (uname) => CATEGORIES.find(([, , re]) => re.test(uname))[0];

const polygonsOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

function simplify(ring, tol) {
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a];
    const dx = ring[b][0] - ax;
    const dy = ring[b][1] - ay;
    const len = Math.hypot(dx, dy);
    let far = -1;
    let max = tol;
    for (let i = a + 1; i < b; i++) {
      const d = len ? Math.abs(dy * (ring[i][0] - ax) - dx * (ring[i][1] - ay)) / len : Math.hypot(ring[i][0] - ax, ring[i][1] - ay);
      if (d > max) { max = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return ring.filter((_, i) => keep[i]);
}

// 폴리곤 하나에 중심점이 들어가는 격자 칸을 주사선으로 찾는다 (구멍은 짝홀 규칙으로 빠진다)
function eachCell({ ncols, nrows, cell, x0, yTop }, rings, visit) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) for (const [, y] of ring) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const rFrom = Math.max(0, Math.floor((yTop - maxY) / cell));
  const rTo = Math.min(nrows - 1, Math.floor((yTop - minY) / cell));
  for (let r = rFrom; r <= rTo; r++) {
    const y = yTop - (r + 0.5) * cell;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xa, ya] = ring[j];
        const [xb, yb] = ring[i];
        if (ya > y !== yb > y) xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const cFrom = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5));
      const cTo = Math.min(ncols - 1, Math.ceil((xs[k + 1] - x0) / cell - 0.5) - 1);
      for (let c = cFrom; c <= cTo; c++) visit(r * ncols + c);
    }
  }
}

const bboxOf = (polys) => {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const rings of polys) for (const [x, y] of rings[0]) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
  return b;
};
const toLatLng = (ring) => ring.map(([x, y]) => { const [lon, lat] = toLonLat(x, y); return [+lat.toFixed(5), +lon.toFixed(5)]; });

// 구역 경계(EPSG:5179). 구가 있는 시는 시 코드(끝자리 0)로 물으면 없으므로 앞 네 자리로 구들을 모은다.
async function regionPolygons(level, code) {
  const [service, field] = level === 'emd' ? ['LT_C_ADEMD_INFO', 'emd_cd'] : ['LT_C_ADSIGG_INFO', 'sig_cd'];
  let r = await getFeatures(service, { attrFilter: `${field}:=:${code}`, crs: 'EPSG:5179' });
  if (!r.features.length && level === 'sgg' && code.endsWith('0')) {
    r = await getFeatures(service, { attrFilter: `${field}:like:${code.slice(0, 4)}`, crs: 'EPSG:5179' });
  }
  if (!r.features.length) throw new Error('구역 경계를 찾지 못했습니다.');
  return { polys: r.features.flatMap((f) => polygonsOf(f.geometry)), names: r.features.map((f) => f.properties.full_nm) };
}

// 경사(참고): 공개 지형 타일로 구역 안에서 임계값 이상인 면적 비율
async function slopeShares(polys) {
  const merc = polys.map((rings) => rings.map((ring) => ring.map(([x, y]) => toMerc(x, y))));
  const box = bboxOf(merc);
  // 타일 수가 너무 많아지지 않게 큰 구역은 한 단계씩 낮춘다
  let zoom = 12;
  while (zoom > 9 && ((box[2] - box[0]) * (box[3] - box[1])) / (40075016.68 / 2 ** zoom) ** 2 > 40) zoom -= 1;
  const g = await tiles.fetchElevation(box, zoom);
  const slope = tiles.slopePercent(g);
  const count = SLOPE_THRESHOLDS.map(() => 0);
  let n = 0;
  for (const rings of merc) {
    eachCell(g, rings, (i) => {
      if (slope[i] < 0) return;
      n += 1;
      SLOPE_THRESHOLDS.forEach((t, k) => { if (slope[i] >= t) count[k] += 1; });
    });
  }
  const ground = g.cell * Math.cos((tiles.mercToLat((box[1] + box[3]) / 2) * Math.PI) / 180);
  return { dem: `공개 지형 타일(Mapzen Terrarium z${zoom}) · 약 ${Math.round(ground)}m`, shares: SLOPE_THRESHOLDS.map((t, k) => ({ threshold: t, share: n ? +((100 * count[k]) / n).toFixed(1) : null })) };
}

async function analyze(level, code, title) {
  const region = await regionPolygons(level, code);
  const box = bboxOf(region.polys);
  const cell = Math.max(3, Math.sqrt(((box[2] - box[0]) * (box[3] - box[1])) / MAX_CELLS));
  const grid = { cell, x0: box[0], yTop: box[3], ncols: Math.ceil((box[2] - box[0]) / cell), nrows: Math.ceil((box[3] - box[1]) / cell) };
  const mask = new Uint8Array(grid.ncols * grid.nrows);
  let regionCells = 0;
  for (const rings of region.polys) eachCell(grid, rings, (i) => { if (!mask[i]) { mask[i] = 1; regionCells += 1; } });

  // 용도지역 도형: 구역 경계 상자에 걸친 것을 모두 받아, 구역 안쪽 칸만 센다
  const features = [];
  for (const service of ZONE_SERVICES) {
    const r = await getFeatures(service, { geomFilter: `BOX(${box.join(',')})`, crs: 'EPSG:5179' });
    if (r.features.length !== r.total) throw new Error(`${service}: 수신 ${r.features.length}건 ≠ 전체 ${r.total}건`);
    for (const f of r.features) if (f.properties.uname) features.push(f);
  }
  // 세분되지 않은 '도시지역' 같은 도형이 세분된 도형을 덮지 않게 먼저 칠한다
  features.sort((a, b) => (categoryOf(b.properties.uname) === 'etc') - (categoryOf(a.properties.uname) === 'etc'));

  const names = [];
  const label = new Uint16Array(mask.length); // 칸마다 용도지역 이름 번호 + 1
  const zones = [];
  const noticeYears = {}; // 고시연도(dyear) → 구역에 걸친 용도지역 도형 수
  for (const f of features) {
    let n = names.indexOf(f.properties.uname);
    if (n < 0) n = names.push(f.properties.uname) - 1;
    for (const rings of polygonsOf(f.geometry)) {
      let touched = 0;
      eachCell(grid, rings, (i) => { if (mask[i]) { label[i] = n + 1; touched += 1; } });
      if (touched && f.properties.dyear) noticeYears[f.properties.dyear] = (noticeYears[f.properties.dyear] || 0) + 1;
      if (touched) zones.push({ n, rings: rings.map((ring) => toLatLng(simplify(ring, cell * 0.75))).filter((ring) => ring.length >= 4) });
    }
  }
  const cells = new Array(names.length + 1).fill(0);
  for (let i = 0; i < mask.length; i++) if (mask[i]) cells[label[i]] += 1;

  const km2 = (n) => +((n * cell * cell) / 1e6).toFixed(3);
  const share = (n) => +((100 * n) / regionCells).toFixed(1);
  const detail = names.map((uname, n) => ({ uname, cat: categoryOf(uname), km2: km2(cells[n + 1]), share: share(cells[n + 1]) })).filter((d) => d.km2 > 0);
  const categories = CATEGORIES.map(([key, labelText]) => {
    const n = names.reduce((s, uname, k) => s + (categoryOf(uname) === key ? cells[k + 1] : 0), 0);
    return { key, label: labelText, km2: km2(n), share: share(n) };
  });
  categories.push({ key: 'none', label: '지정 자료 없음', km2: km2(cells[0]), share: share(cells[0]) });

  const slope = null; // 경사 DEM 을 무엇으로 할지 정해진 뒤에 붙인다

  memo.set(`${level}_${code}`, { grid, mask, label, names, polys: region.polys, name: title || region.names[0] });
  const nameIndex = detail.map((d) => d.uname);
  return {
    level,
    code,
    name: title || region.names[0],
    date: new Date().toLocaleDateString('sv-SE'),
    services: ZONE_SERVICES.join(' · '),
    areaKm2: km2(regionCells),
    cellM: +cell.toFixed(1),
    featureCount: features.length,
    categories,
    detail: detail.sort((a, b) => b.km2 - a.km2),
    slope,
    notices: Object.entries(noticeYears).map(([year, count]) => ({ year, count })).sort((a, b) => a.year.localeCompare(b.year)),
    boundary: region.polys.map((rings) => rings.map((ring) => toLatLng(simplify(ring, cell * 0.75)))),
    zones: zones.filter((z) => nameIndex.includes(names[z.n])).map((z) => ({ uname: names[z.n], cat: categoryOf(names[z.n]), rings: z.rings })),
  };
}

// 1:50,000 도엽번호: 앞 두 자리 위도, 셋째 자리 경도-120, 뒤 두 자리는 1도 칸 안의 4x4 순번(북서→남동)
function sheetOf(lon, lat) {
  const la = Math.floor(lat);
  const lo = Math.floor(lon);
  const row = Math.min(3, Math.floor((la + 1 - lat) / 0.25));
  const col = Math.min(3, Math.floor((lon - lo) / 0.25));
  return `${la}${lo - 120}${String(row * 4 + col + 1).padStart(2, '0')}`;
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// 구역에 걸친 도엽 번호: 경계 꼭짓점이 든 도엽 + 중심이 구역 안에 든 도엽
function sheetsFor(polys) {
  const set = new Set();
  const outers = polys.map((rings) => rings[0].map(([x, y]) => toLonLat(x, y)));
  let b = [999, 999, -999, -999];
  for (const ring of outers) for (const [lon, lat] of ring) {
    set.add(sheetOf(lon, lat));
    b = [Math.min(b[0], lon), Math.min(b[1], lat), Math.max(b[2], lon), Math.max(b[3], lat)];
  }
  for (let lat = Math.floor(b[1] * 4) / 4 + 0.125; lat < b[3]; lat += 0.25) {
    for (let lon = Math.floor(b[0] * 4) / 4 + 0.125; lon < b[2]; lon += 0.25) {
      if (outers.some((ring) => inRing(lon, lat, ring))) set.add(sheetOf(lon, lat));
    }
  }
  return [...set].sort();
}

const sheetCache = new Map();
function loadSheet(no) {
  if (sheetCache.has(no)) return sheetCache.get(no);
  const file = path.join(DEM_DIR, no, `${no}.img`);
  if (!fs.existsSync(file)) return null;
  const d = readImg(file);
  if (d.cellsize !== DEM_CELL) throw new Error(`도엽 ${no}: 격자가 ${d.cellsize}m 입니다 (90m 필요).`);
  const sheet = { x0: d.header.xllcorner, yTop: d.header.yllcorner + d.nrows * d.cellsize, ncols: d.ncols, nrows: d.nrows, z: d.z, nodata: d.nodata };
  sheetCache.set(no, sheet);
  return sheet;
}

// 도엽들을 90m 격자 한 장으로 이어 붙여 경사(%)를 낸다. 이어 붙인 뒤 계산하므로 도엽 이음매에서도 값이 나온다.
function slopeMosaic(box, sheetNos) {
  const x0 = Math.floor(box[0] / DEM_CELL) * DEM_CELL - DEM_CELL;
  const yTop = Math.ceil(box[3] / DEM_CELL) * DEM_CELL + DEM_CELL;
  const ncols = Math.ceil((box[2] - x0) / DEM_CELL) + 1;
  const nrows = Math.ceil((yTop - box[1]) / DEM_CELL) + 1;
  const NODATA = -9999;
  const z = new Float64Array(ncols * nrows).fill(NODATA);
  for (const no of sheetNos) {
    const s = loadSheet(no);
    const c0 = Math.round((s.x0 - x0) / DEM_CELL);
    const r0 = Math.round((yTop - s.yTop) / DEM_CELL);
    for (let r = Math.max(0, -r0); r < s.nrows && r + r0 < nrows; r++) {
      for (let c = Math.max(0, -c0); c < s.ncols && c + c0 < ncols; c++) {
        const v = s.z[r * s.ncols + c];
        if (v !== s.nodata) z[(r + r0) * ncols + c + c0] = v; // 도엽의 빈 값(바다 등)은 건너뛴다
      }
    }
  }
  const { slope } = slopeAspect({ ncols, nrows, cellsize: DEM_CELL, nodata: NODATA, z });
  const pct = new Float32Array(slope.length);
  for (let i = 0; i < slope.length; i++) pct[i] = slope[i] < 0 ? -1 : Math.tan((slope[i] * Math.PI) / 180) * 100;
  return { x0, yTop, ncols, nrows, pct };
}

// 솔루션: 현재 용도 × 경사 구간, 그리고 대안 A·B·C 의 전환 면적과 지도 도형
async function solve(level, code, title) {
  const key = `${level}_${code}`;
  if (!memo.has(key)) await analyze(level, code, title);
  const { grid, mask, label, names, polys, name } = memo.get(key);
  const needed = sheetsFor(polys);
  const missing = needed.filter((no) => !fs.existsSync(path.join(DEM_DIR, no, `${no}.img`)));
  if (missing.length) return { name, dem: DEM_LABEL, sheets: needed, missing };

  const dem = slopeMosaic(bboxOf(polys), needed);
  const { ncols, nrows, cell, x0, yTop } = grid;
  const cats = names.map(categoryOf);
  const catKeys = [...CATEGORIES.map(([k]) => k), 'none'];
  const cellKm2 = (cell * cell) / 1e6;
  const bandOf = (s) => { let b = 0; for (let k = 0; k < SLOPE_BANDS.length; k++) if (s > SLOPE_BANDS[k]) b = k; return b; };

  const current = Object.fromEntries(catKeys.map((k) => [k, 0]));
  const bands = Object.fromEntries(catKeys.map((k) => [k, SLOPE_BANDS.map(() => 0)]));
  const noSlope = { cells: 0 };
  const alts = ALTERNATIVES.map((a) => ({ ...a, urban: 0, gentle: 0, codes: new Uint8Array(mask.length), from: Object.fromEntries(catKeys.map((k) => [k, [0, 0, 0, 0]])) }));
  let regionCells = 0;
  for (let r = 0; r < nrows; r++) {
    const dr = Math.floor((dem.yTop - (yTop - (r + 0.5) * cell)) / DEM_CELL);
    for (let c = 0; c < ncols; c++) {
      const i = r * ncols + c;
      if (!mask[i]) continue;
      regionCells += 1;
      const cat = label[i] ? cats[label[i] - 1] : 'none';
      current[cat] += 1;
      const s = dem.pct[dr * dem.ncols + Math.floor((x0 + (c + 0.5) * cell - dem.x0) / DEM_CELL)];
      if (!(s >= 0)) { noSlope.cells += 1; continue; } // 경사 값이 없는 칸(바다·도엽 빈 값)은 전환 대상에서 뺀다
      bands[cat][bandOf(s)] += 1;
      for (const a of alts) {
        let codeNo = 0;
        if (a.id === 'A') { if (URBAN.has(cat) && s > 25) codeNo = 1; }
        else if (RURAL.has(cat) && s <= a.limit) codeNo = s <= 5 ? 2 : 3;
        if (codeNo) { a.codes[i] = codeNo; a.from[cat][codeNo] += 1; }
        // 전환 뒤 시가화 용지(주거·상업·공업 + 개발 후보)와 그중 경사 15% 이하 칸
        if ((URBAN.has(cat) && codeNo !== 1) || codeNo > 1) { a.urban += 1; if (s <= 15) a.gentle += 1; }
      }
    }
  }

  const km2 = (n) => +(n * cellKm2).toFixed(3);
  // 같은 줄에서 이어진 같은 부호 칸을 사각형 하나로 묶는다. 도형이 너무 많으면 줄을 건너뛰며 굵게 그린다.
  function quadsOf(codes) {
    for (let step = 1; ; step++) {
      const out = { 1: [], 2: [], 3: [] };
      let count = 0;
      for (let r = 0; r < nrows; r += step) {
        let c = 0;
        while (c < ncols) {
          const v = codes[r * ncols + c];
          if (!v) { c += 1; continue; }
          let e = c;
          while (e + 1 < ncols && codes[r * ncols + e + 1] === v) e += 1;
          const xa = x0 + c * cell, xb = x0 + (e + 1) * cell, ya = yTop - r * cell, yb = yTop - Math.min(nrows, r + step) * cell;
          out[v].push(toLatLng([[xa, ya], [xb, ya], [xb, yb], [xa, yb]]));
          count += 1;
          c = e + 1;
        }
      }
      if (count <= MAX_QUADS) return out;
    }
  }

  return {
    name,
    dem: DEM_LABEL,
    sheets: needed,
    missing: [],
    date: new Date().toLocaleDateString('sv-SE'),
    cellM: +cell.toFixed(1),
    areaKm2: km2(regionCells),
    noSlopeKm2: km2(noSlope.cells),
    bandEdges: SLOPE_BANDS,
    current: catKeys.map((k) => ({ key: k, km2: km2(current[k]), bands: bands[k].map(km2) })).filter((c) => c.km2 > 0),
    alternatives: alts.map((a) => {
      const toGreen = catKeys.reduce((s, k) => s + a.from[k][1], 0);
      const candInd = catKeys.reduce((s, k) => s + a.from[k][2], 0);
      const candDev = catKeys.reduce((s, k) => s + a.from[k][3], 0);
      // 전환 뒤 구성: 전환된 칸을 원래 용도에서 빼고 새 분류에 더한다
      const after = Object.fromEntries(catKeys.map((k) => [k, current[k] - a.from[k][1] - a.from[k][2] - a.from[k][3]]));
      after.green += toGreen;
      const pct = (x, total) => (total ? +((100 * x) / total).toFixed(1) : null);
      return {
        id: a.id,
        name: a.name,
        rule: a.rule,
        // 목표-성취 지표(%): 국토계획평가 기준 ①④⑤ 에 대응 (2026-10-12 사용자 승인)
        indicators: {
          jobs: pct(after.com + after.ind + candInd, regionCells),
          green: pct(after.green, regionCells),
          gentle: pct(a.gentle, a.urban),
        },
        // 계획 대차대조표: 용도별 이용 집단의 면적 증감(km²). 개발 후보는 용도 미정으로 따로 둔다.
        groups: ['res', 'com', 'ind', 'green'].map((k) => ({ key: k, delta: +((after[k] - current[k]) * cellKm2).toFixed(3) })),
        undecidedKm2: km2(candInd + candDev),
        toGreenKm2: km2(toGreen),
        candIndKm2: km2(candInd),
        candDevKm2: km2(candDev),
        from: catKeys.map((k) => ({ key: k, toGreen: km2(a.from[k][1]), candInd: km2(a.from[k][2]), candDev: km2(a.from[k][3]) })).filter((f) => f.toGreen + f.candInd + f.candDev > 0),
        after: [...catKeys.map((k) => ({ key: k, km2: km2(after[k]) })), { key: 'candInd', km2: km2(candInd) }, { key: 'candDev', km2: km2(candDev) }].filter((x) => x.km2 > 0),
        quads: quadsOf(a.codes),
      };
    }),
  };
}

// 현재 용도별 평균 개별공시지가(원/㎡): 연속지적도 필지의 jiga 를 필지 면적으로 가중 평균한다.
// 필지는 대표점(바깥 고리 꼭짓점 평균)이 놓인 칸의 용도로 센다.
const MAX_PARCELS = 60000;
async function landPrice(level, code, title) {
  const key = `${level}_${code}`;
  if (!memo.has(key)) await analyze(level, code, title);
  const { grid, mask, label, names, polys } = memo.get(key);
  const box = bboxOf(polys);
  // 연속지적도는 한 번에 10km² 까지만 조회된다. 구역을 3km 칸으로 나눠 받고 PNU 로 중복을 없앤다.
  const TILE = 3000;
  const seen = new Map();
  for (let ty = box[1]; ty < box[3]; ty += TILE) {
    for (let tx = box[0]; tx < box[2]; tx += TILE) {
      const tile = [tx, ty, Math.min(tx + TILE, box[2]), Math.min(ty + TILE, box[3])];
      // 구역과 겹치지 않는 칸은 건너뛴다
      let touches = false;
      const c0 = Math.max(0, Math.floor((tile[0] - grid.x0) / grid.cell)), c1 = Math.min(grid.ncols - 1, Math.floor((tile[2] - grid.x0) / grid.cell));
      const r0 = Math.max(0, Math.floor((grid.yTop - tile[3]) / grid.cell)), r1 = Math.min(grid.nrows - 1, Math.floor((grid.yTop - tile[1]) / grid.cell));
      for (let rr = r0; rr <= r1 && !touches; rr++) for (let cc = c0; cc <= c1; cc++) if (mask[rr * grid.ncols + cc]) { touches = true; break; }
      if (!touches) continue;
      const part = await getFeatures('LP_PA_CBND_BUBUN', { geomFilter: `BOX(${tile.join(',')})`, crs: 'EPSG:5179' });
      for (const f of part.features) seen.set(f.properties.pnu, f);
      if (seen.size > MAX_PARCELS) return { tooMany: true, total: seen.size, limit: MAX_PARCELS };
    }
  }
  const cats = names.map(categoryOf);
  const sum = {};
  const years = new Set();
  let used = 0;
  for (const f of seen.values()) {
    const price = Number(f.properties.jiga);
    const parts = polygonsOf(f.geometry);
    if (!(price > 0) || !parts.length) continue;
    const ring = parts[0][0];
    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const c = Math.floor((cx - grid.x0) / grid.cell);
    const row = Math.floor((grid.yTop - cy) / grid.cell);
    if (c < 0 || row < 0 || c >= grid.ncols || row >= grid.nrows) continue;
    const i = row * grid.ncols + c;
    if (!mask[i]) continue;
    const cat = label[i] ? cats[label[i] - 1] : 'none';
    let area = 0;
    for (const rings of parts) {
      for (let k = 0; k < rings.length; k++) {
        let a = 0;
        for (let p = 0, q = rings[k].length - 1; p < rings[k].length; q = p++) a += rings[k][q][0] * rings[k][p][1] - rings[k][p][0] * rings[k][q][1];
        area += (k ? -1 : 1) * Math.abs(a) / 2;
      }
    }
    if (!sum[cat]) sum[cat] = { won: 0, area: 0, parcels: 0 };
    sum[cat].won += price * area;
    sum[cat].area += area;
    sum[cat].parcels += 1;
    years.add(f.properties.gosi_year);
    used += 1;
  }
  return {
    date: new Date().toLocaleDateString('sv-SE'),
    service: 'LP_PA_CBND_BUBUN',
    parcels: used,
    years: [...years].filter(Boolean).sort(),
    prices: Object.entries(sum).map(([k, v]) => ({ key: k, wonPerM2: Math.round(v.won / v.area), parcels: v.parcels })),
  };
}

// 인구: 사용자의 예전 프로젝트가 배포해 둔 SGIS 중계(/api/sgis)를 부른다 (2026-10-12 사용자 지정).
//   op=stage&cd=  하위 행정구역 목록 · op=region&adm_cd=  시군구→읍면동, 읍면동→집계구 단위의 경계와 인구
const SGIS_RELAY = 'https://444-beta-murex.vercel.app/api/sgis';
const SGIS_YEAR = '2024';
const SIDO_ALIASES = { 전남광주통합특별시: ['광주광역시', '전라남도'] };
const sgisCache = new Map();
async function sgis(query) {
  if (!sgisCache.has(query)) {
    const res = await fetch(`${SGIS_RELAY}?${query}`);
    if (!res.ok) throw new Error(`SGIS 중계 ${res.status}`);
    sgisCache.set(query, await res.json());
  }
  return sgisCache.get(query);
}
async function population(level, code, title) {
  const key = `${level}_${code}`;
  if (!memo.has(key)) await analyze(level, code, title);
  const { polys, name, mask, grid } = memo.get(key);
  const parts = name.split(/\s+/);
  const sggName = (level === 'emd' ? parts.slice(1, -1) : parts.slice(1)).join(' ');
  if (!sggName) return { missing: '시군구 이름을 알 수 없음' };
  // 시도 → 시군구 코드 찾기 (SGIS 행정구역 코드는 브이월드 법정동 코드와 체계가 다르다)
  const sidos = (await sgis('op=stage')).items.filter((s) => (SIDO_ALIASES[parts[0]] || [parts[0]]).includes(s.name));
  let sgg = null;
  for (const s of sidos) sgg = sgg || (await sgis(`op=stage&cd=${s.cd}`)).items.find((x) => x.name === sggName);
  if (!sgg) return { missing: `SGIS에서 ${sggName}을 찾지 못함` };

  const box = bboxOf(polys);
  const inRegion = (x, y) => polys.some((rings) => inRing(x, y, rings[0]) && !rings.slice(1).some((hole) => inRing(x, y, hole)));
  const overlaps = (f) => { const b = bboxOf(f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates); return b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1]; };
  const whole = await sgis(`op=region&adm_cd=${sgg.cd}&year=${SGIS_YEAR}`);
  let pop = 0;
  let units = 0;
  let unitName = whole.unitName;
  if (level === 'sgg') {
    for (const v of Object.values(whole.stats)) { pop += Number(v.pop) || 0; units += 1; }
  } else {
    // 법정동 구역에 대표점이 드는 집계구의 인구를 더한다
    unitName = '집계구';
    for (const dong of whole.areas.features.filter(overlaps)) {
      // 시군구 응답의 읍면동 코드는 7자리, 읍면동 조회는 8자리(끝에 0)
      const d = await sgis(`op=region&adm_cd=${String(dong.properties.code).padEnd(8, '0')}&year=${SGIS_YEAR}`);
      for (const f of d.areas.features) {
        if (!inRegion(f.properties.x, f.properties.y)) continue;
        pop += Number((d.stats[f.properties.code] || {}).pop) || 0;
        units += 1;
      }
    }
  }
  let cells = 0;
  for (let i = 0; i < mask.length; i++) cells += mask[i];
  const areaKm2 = (cells * grid.cell * grid.cell) / 1e6;
  return { pop, units, unitName, year: SGIS_YEAR, density: areaKm2 ? Math.round(pop / areaKm2) : null, source: '국가데이터처 인구총조사 (SGIS)', date: new Date().toLocaleDateString('sv-SE') };
}

// 전국 검색: 행정구역(읍면동·시군구·시도) → 주소 → 장소 순으로 모은다
async function search(query) {
  const base = { service: 'search', request: 'search', version: '2.0', query, format: 'json', size: '4', page: '1', crs: 'EPSG:4326' };
  const ask = (extra) => call('search', { ...base, ...extra }).then((r) => (r.status === 'OK' ? r.result.items : []), () => []);
  const [emd, sgg, sido, road, parcel, place] = await Promise.all([
    ask({ type: 'district', category: 'L4' }),
    ask({ type: 'district', category: 'L2' }),
    ask({ type: 'district', category: 'L1' }),
    ask({ type: 'address', category: 'road', size: '2' }),
    ask({ type: 'address', category: 'parcel', size: '2' }),
    ask({ type: 'place', size: '2' }),
  ]);
  const district = (kind, label) => (i) => ({ kind, label, code: i.id, title: i.title, x: +i.point.x, y: +i.point.y });
  const point = (label, titleOf) => (i) => ({ kind: 'point', label, title: titleOf(i), x: +i.point.x, y: +i.point.y });
  const seen = new Set();
  return [
    ...sgg.map(district('sgg', '시군구')),
    ...emd.map(district('emd', '읍면동')),
    ...sido.map(district('sido', '시도')),
    ...road.map(point('도로명주소', (i) => i.address.road)),
    ...parcel.map(point('지번주소', (i) => i.address.parcel)),
    ...place.map(point('장소', (i) => `${i.title} (${i.address.road || i.address.parcel})`)),
  ].filter((h) => !seen.has(h.kind + h.title) && seen.add(h.kind + h.title)).slice(0, 12);
}

// 좌표가 속한 읍면동
async function locate(x, y) {
  const r = await getFeatures('LT_C_ADEMD_INFO', { geomFilter: `POINT(${x} ${y})`, geometry: false });
  if (!r.features.length) return null;
  return { kind: 'emd', code: r.features[0].properties.emd_cd, title: r.features[0].properties.full_nm };
}

async function proxy(res, url, cacheSeconds) {
  const upstream = await fetch(url);
  const type = upstream.headers.get('content-type') || 'application/octet-stream';
  res.writeHead(upstream.ok && type.startsWith('image/') ? 200 : 502, { 'Content-Type': type, 'Cache-Control': `public, max-age=${cacheSeconds}` });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

const TILE_EXT = { Satellite: 'jpeg', Hybrid: 'png', Base: 'png' };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

// 모든 요청은 /api/zoning?r=<기능> 한 주소로 받는다. 로컬 서버와 Vercel 서버 함수가 같은 처리기를 쓴다.
const regionOf = (q) => {
  const level = q.get('level');
  const code = q.get('code') || '';
  return ['emd', 'sgg'].includes(level) && /^\d{4,10}$/.test(code) ? { level, code, title: q.get('title') } : null;
};
function cached(res, name, make, keep = () => true) {
  const file = path.join(CACHE_DIR, `${name}_${new Date().toLocaleDateString('sv-SE')}.json`);
  if (fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(fs.readFileSync(file)); return null; }
  return make().then((result) => {
    if (keep(result)) { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(result)); } catch (e) { /* 저장 못 해도 응답은 한다 */ } }
    json(res, 200, result);
  });
}
async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  try {
    if (!KEY) return json(res, 500, { error: '서버에 VWORLD_KEY 환경변수가 없습니다.' });
    if (url.pathname === '/api/zoning') {
      const route = q.get('r');
      if (route === 'tile') {
        const layer = q.get('layer');
        const [z, y, x] = ['z', 'y', 'x'].map((k) => q.get(k) || '');
        if (!TILE_EXT[layer] || ![z, y, x].every((v) => /^\d+$/.test(v))) return json(res, 400, { error: '타일 주소가 잘못됐습니다.' });
        return await proxy(res, `https://api.vworld.kr/req/wmts/1.0.0/${KEY}/${layer}/${z}/${y}/${x}.${TILE_EXT[layer]}`, 86400);
      }
      if (route === 'search') return json(res, 200, await search(q.get('q') || ''));
      if (route === 'locate') return json(res, 200, await locate(Number(q.get('x')), Number(q.get('y'))));
      const region = regionOf(q);
      if (['analyze', 'solution', 'population', 'landprice'].includes(route) && !region) return json(res, 400, { error: '읍면동이나 시군구를 골라 주세요.' });
      if (route === 'analyze') return await cached(res, `${region.level}_${region.code}_v2`, () => analyze(region.level, region.code, region.title));
      if (route === 'solution') return json(res, 200, await solve(region.level, region.code, region.title));
      if (route === 'population') return json(res, 200, await population(region.level, region.code, region.title));
      if (route === 'landprice') {
        if (region.level !== 'emd') return json(res, 200, { emdOnly: true });
        return await cached(res, `landprice_${region.code}`, () => landPrice('emd', region.code, region.title), (r) => !r.tooMany);
      }
      return json(res, 404, { error: '없는 기능입니다.' });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    json(res, 404, { error: '없는 주소입니다.' });
  } catch (e) {
    console.error(url.pathname, q.get('r') || '', e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
}

module.exports = { handler };

// 직접 실행하면 로컬 서버로 뜬다: node dashboard_server.js
if (require.main === module) {
  if (!KEY) {
    console.error('환경변수 VWORLD_KEY 가 없습니다.');
    process.exit(1);
  }
  http.createServer(handler).listen(PORT, () => console.log(`http://localhost:${PORT}`));
}
