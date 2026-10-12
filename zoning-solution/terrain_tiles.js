// 공개 지형 타일(AWS Open Data "Terrain Tiles", Mapzen Terrarium 형식)로 표고 격자를 만든다.
// 키·로그인 없이 받을 수 있어 자동 갱신에 쓴다. 좌표는 EPSG:3857(웹 메르카토르).
//   표고(m) = R*256 + G + B/256 - 32768
const zlib = require('zlib');

const HALF = 20037508.342789244; // 메르카토르 반폭(m)
const R = 6378137;
const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

const lonLatToMerc = (lon, lat) => [(lon * HALF) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
const mercToLat = (y) => (Math.atan(Math.sinh(y / R)) * 180) / Math.PI;

// 8비트 RGB/RGBA, 인터레이스 없는 PNG 만 푼다 (지형 타일이 이 형식)
function decodePng(buf) {
  let pos = 8;
  let width, height, channels;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const colorType = data[9];
      if (data[8] !== 8 || (colorType !== 2 && colorType !== 6) || data[12] !== 0) throw new Error('지원하지 않는 PNG 형식입니다.');
      channels = colorType === 2 ? 3 : 4;
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = y && x >= channels ? out[(y - 1) * stride + x - channels] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = (raw[line + x] + pred) & 255;
    }
  }
  return { width, height, channels, data: out };
}

// 메르카토르 범위 [minx, miny, maxx, maxy] 를 덮는 타일을 받아 한 장의 표고 격자로 잇는다
async function fetchElevation([minx, miny, maxx, maxy], zoom) {
  const n = 2 ** zoom;
  const tileM = (2 * HALF) / n;
  const tx0 = Math.floor((minx + HALF) / tileM);
  const tx1 = Math.floor((maxx + HALF) / tileM);
  const ty0 = Math.floor((HALF - maxy) / tileM);
  const ty1 = Math.floor((HALF - miny) / tileM);
  const ncols = (tx1 - tx0 + 1) * 256;
  const nrows = (ty1 - ty0 + 1) * 256;
  const z = new Float32Array(ncols * nrows);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
  const urls = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      const url = `${TILE_URL}/${zoom}/${tx}/${ty}.png`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`지형 타일 ${zoom}/${tx}/${ty}: HTTP ${res.status}`);
      const png = decodePng(Buffer.from(await res.arrayBuffer()));
      if (png.width !== 256 || png.height !== 256) throw new Error(`지형 타일 크기가 256이 아닙니다: ${url}`);
      urls.push(url);
      for (let r = 0; r < 256; r++) {
        for (let c = 0; c < 256; c++) {
          const i = (r * 256 + c) * png.channels;
          z[((ty - ty0) * 256 + r) * ncols + (tx - tx0) * 256 + c] = png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  const cell = tileM / 256; // 메르카토르 단위. 실제 지상 거리는 cos(위도) 를 곱한다.
  const x0 = -HALF + tx0 * tileM;
  const yTop = HALF - ty0 * tileM;
  return { ncols, nrows, cell, x0, yTop, z, tiles: jobs.length, urls: urls.sort() };
}

// Horn 3x3 경사(%) — 행마다 위도에 맞춘 지상 격자 크기를 쓴다
function slopePercent({ ncols, nrows, cell, yTop, z }) {
  const out = new Float32Array(ncols * nrows).fill(-1);
  for (let r = 1; r < nrows - 1; r++) {
    const ground = cell * Math.cos((mercToLat(yTop - (r + 0.5) * cell) * Math.PI) / 180);
    for (let c = 1; c < ncols - 1; c++) {
      const i = r * ncols + c;
      const dzdx = (z[i - ncols + 1] + 2 * z[i + 1] + z[i + ncols + 1] - (z[i - ncols - 1] + 2 * z[i - 1] + z[i + ncols - 1])) / (8 * ground);
      const dzdy = (z[i - ncols - 1] + 2 * z[i - ncols] + z[i - ncols + 1] - (z[i + ncols - 1] + 2 * z[i + ncols] + z[i + ncols + 1])) / (8 * ground);
      out[i] = Math.hypot(dzdx, dzdy) * 100;
    }
  }
  return out;
}

module.exports = { lonLatToMerc, mercToLat, decodePng, fetchElevation, slopePercent };
