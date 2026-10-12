#!/usr/bin/env node
// 대상지 DEM 90m 격자 받기 — 지형 축(경사·향·표고)과 지표 ⑥ 계산용 임시 자료
//
// 사용: node dem.mjs <대상지경계.geojson> <저장폴더> [--source tiles|openmeteo]
//   예: node dem.mjs out/anseo/LT_C_ADEMD_INFO_2026-10-12.geojson out/anseo
//
// 출처(둘 다 키 불필요):
//   tiles(기본)  AWS Terrain Tiles(terrarium, z13 ≈ 15m 화소)를 90m 격자로 보간 — 타일 몇 장이라 수 초
//   openmeteo    Open-Meteo Elevation API(Copernicus DEM GLO-90) — 분당 600점 한도라 동 하나에 수 분
// 둘 다 국토지리정보원 DEM이 아니다. 국토지리정보원 DEM을 받으면 그것으로 교체할 것(강의 6주차 27·33번).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';

const CELL_M = 90;     // 강의 기준 DEM 90m 셀 (0.81ha)
const PAD = 2;         // 경사 계산용 바깥 여유 셀
const TILE_Z = 13;

const args = process.argv.slice(2);
const [src, outDir] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const source = args.includes('--source') ? args[args.indexOf('--source') + 1] : 'tiles';
if (!src || !outDir || !['tiles', 'openmeteo'].includes(source)) {
  console.error('사용: node dem.mjs <대상지경계.geojson> <저장폴더> [--source tiles|openmeteo]');
  process.exit(1);
}

// ---------------------------------------------------------------- 격자 정의
const site = JSON.parse(await readFile(src, 'utf8'));
let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
const walk = (c) => (typeof c[0] === 'number'
  ? (minx = Math.min(minx, c[0]), maxx = Math.max(maxx, c[0]), miny = Math.min(miny, c[1]), maxy = Math.max(maxy, c[1]))
  : c.forEach(walk));
site.features.forEach((f) => walk(f.geometry.coordinates));

const lat0 = (miny + maxy) / 2;
const dLon = CELL_M / (111320 * Math.cos(lat0 * Math.PI / 180));
const dLat = CELL_M / 110574;
const x0 = minx - PAD * dLon, y0 = miny - PAD * dLat;
const nx = Math.ceil((maxx - minx) / dLon) + 2 * PAD + 1;
const ny = Math.ceil((maxy - miny) / dLat) + 2 * PAD + 1;
const points = [];
for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) points.push([+(x0 + i * dLon).toFixed(6), +(y0 + j * dLat).toFixed(6)]);
console.log(`격자 ${nx}×${ny} = ${points.length}점 (${source})`);

const elev = source === 'tiles' ? await fromTiles(points) : await fromOpenMeteo(points);
const SOURCES = {
  tiles: 'AWS Terrain Tiles(terrarium, z13) → 90m 보간',
  openmeteo: 'Open-Meteo Elevation API — Copernicus DEM GLO-90 (DSM, 90m)',
};

const queriedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00';
await mkdir(outDir, { recursive: true });
const file = join(outDir, `DEM_90m_${queriedAt.slice(0, 10)}.json`);
await writeFile(file, JSON.stringify({
  source: SOURCES[source],
  note: '국토지리정보원 DEM 확보 전 임시값',
  queriedAt,
  cellM: CELL_M,
  crs: 'EPSG:4326',
  origin: [x0, y0], step: [dLon, dLat], size: [nx, ny], // 행 j는 남→북, 열 i는 서→동
  elevation: elev,
}));
console.log(`✓ ${file}`);

// ---------------------------------------------------------------- tiles: terrarium PNG
// 고도 = R×256 + G + B/256 − 32768 (m). 웹 메르카토르 화소 좌표에서 양선형 보간
async function fromTiles(pts) {
  const N = 256 * 2 ** TILE_Z;
  const px = (lon) => ((lon + 180) / 360) * N;
  const py = (lat) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N; };
  const tiles = new Map();
  const need = new Set();
  for (const [lon, lat] of pts) {
    const X = px(lon) - 0.5, Y = py(lat) - 0.5;
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) need.add(`${Math.floor((Math.floor(X) + a) / 256)}/${Math.floor((Math.floor(Y) + b) / 256)}`);
  }
  console.log(`  타일 ${need.size}장`);
  for (const k of need) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TILE_Z}/${k}.png`;
    for (let t = 1; ; t++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        tiles.set(k, decodePng(Buffer.from(await res.arrayBuffer())));
        break;
      } catch (e) {
        if (t >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1500 * t));
      }
    }
  }
  const at = (gx, gy) => {
    const t = tiles.get(`${Math.floor(gx / 256)}/${Math.floor(gy / 256)}`);
    const i = ((gy % 256) * 256 + (gx % 256)) * t.ch;
    return t.px[i] * 256 + t.px[i + 1] + t.px[i + 2] / 256 - 32768;
  };
  return pts.map(([lon, lat]) => {
    const X = px(lon) - 0.5, Y = py(lat) - 0.5; // 화소 중심 기준
    const i = Math.floor(X), j = Math.floor(Y), u = X - i, v = Y - j;
    const z = at(i, j) * (1 - u) * (1 - v) + at(i + 1, j) * u * (1 - v) + at(i, j + 1) * (1 - u) * v + at(i + 1, j + 1) * u * v;
    return Math.round(z * 10) / 10;
  });
}

// 8비트 RGB/RGBA PNG만 지원(terrarium 형식)
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG 아님');
  let o = 8, w, h, ct, idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9];
      if (d[8] !== 8 || ![2, 6].includes(ct) || d[12] !== 0) throw new Error(`지원하지 않는 PNG (bit ${d[8]}, color ${ct}, interlace ${d[12]})`);
    } else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const ch = ct === 6 ? 4 : 3, stride = w * ch;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride), prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev ? prev[x] : 0, c = prev && x >= ch ? prev[x - ch] : 0;
      let p;
      if (f === 0) p = 0; else if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else throw new Error(`PNG 필터 ${f}`);
      cur[x] = (src[x] + p) & 0xff;
    }
  }
  if (w !== 256 || h !== 256) throw new Error(`타일 크기 ${w}×${h}`);
  return { px, ch };
}

// ---------------------------------------------------------------- openmeteo
async function fromOpenMeteo(pts) {
  const BATCH = 100, GAP_MS = 12_000; // 좌표 1개 = 호출 1회, 분당 600회 → 100점당 12초
  const out = [];
  for (let k = 0; k < pts.length; k += BATCH) {
    const chunk = pts.slice(k, k + BATCH);
    const url = 'https://api.open-meteo.com/v1/elevation?latitude=' + chunk.map((p) => p[1]).join(',') + '&longitude=' + chunk.map((p) => p[0]).join(',');
    for (let t = 1; ; t++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const j = await res.json();
        if (!Array.isArray(j.elevation) || j.elevation.length !== chunk.length) throw new Error('elevation 길이 불일치');
        out.push(...j.elevation);
        break;
      } catch (e) {
        if (t >= 5) throw e;
        const wait = /HTTP 429/.test(e.message) ? 65_000 : 2000 * t;
        console.warn(`\n  재시도 ${t} (${Math.round(wait / 1000)}초 후): ${e.message.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    process.stdout.write(`\r  ${Math.min(k + BATCH, pts.length)}/${pts.length}`);
    if (k + BATCH < pts.length) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  console.log();
  return out;
}
