// DEM → 경사·향 계산 (Horn 3x3 방식, GDAL·ArcGIS 와 같은 식)
//   node dem.js <DEM.asc|DEM.img> [출력 접두어]
// 입력: ESRI ASCII Grid(.asc) 또는 ERDAS Imagine(.img), 미터 단위 투영좌표계(예: EPSG:5179·5186)
// 출력: <접두어>_slope.asc (도), <접두어>_aspect.asc (북 0° 시계방향, 평지 -1)
const fs = require('fs');

// 결과 격자의 빈 칸 값. 입력 DEM 의 NODATA(0 인 경우도 있음)와 따로 둔다.
const OUT_NODATA = -9999;

function readAsc(file) {
  const text = fs.readFileSync(file, 'utf8');
  const header = {};
  let pos = 0;
  for (;;) {
    const end = text.indexOf('\n', pos);
    const m = text.slice(pos, end).trim().match(/^([A-Za-z_]+)\s+(\S+)$/);
    if (!m) break;
    header[m[1].toLowerCase()] = Number(m[2]);
    pos = end + 1;
  }
  const { ncols, nrows, cellsize } = header;
  if (!ncols || !nrows || !cellsize) throw new Error('ASCII Grid 헤더(ncols·nrows·cellsize)를 읽지 못했습니다.');
  const z = Float64Array.from(text.slice(pos).trim().split(/\s+/), Number);
  if (z.length !== ncols * nrows) throw new Error(`격자 값 ${z.length}개 ≠ ${ncols}x${nrows}`);
  return { header, ncols, nrows, cellsize, nodata: header.nodata_value ?? -9999, z };
}

// ERDAS Imagine(.img, HFA) — 국토지리정보원 공개DEM 배포 형식. 단일 밴드만 읽는다.
function readImg(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 15) !== 'EHFA_HEADER_TAG') throw new Error('ERDAS Imagine(.img) 파일이 아닙니다.');
  const entry = (p) => ({
    next: b.readInt32LE(p),
    child: b.readInt32LE(p + 12),
    data: b.readInt32LE(p + 16),
    name: b.toString('latin1', p + 24, p + 88).split('\0')[0],
    type: b.toString('latin1', p + 88, p + 120).split('\0')[0],
  });
  const children = (parent) => {
    const list = [];
    for (let p = parent.child; p; p = list[list.length - 1].next) list.push(entry(p));
    return list;
  };
  const root = entry(b.readInt32LE(b.readInt32LE(16) + 8));
  const layer = children(root).find((e) => e.type === 'Eimg_Layer');
  if (!layer) throw new Error('.img 에 래스터 레이어가 없습니다.');
  const parts = children(layer);
  const part = (type) => parts.find((e) => e.type.startsWith(type));

  const ncols = b.readInt32LE(layer.data);
  const nrows = b.readInt32LE(layer.data + 4);
  const pixelType = b.readUInt16LE(layer.data + 10);
  const blockW = b.readInt32LE(layer.data + 12);
  const blockH = b.readInt32LE(layer.data + 16);
  // 화소 형식 번호 → [바이트 수, 읽기 함수]
  const types = {
    3: [1, (o) => b.readUInt8(o)],
    4: [1, (o) => b.readInt8(o)],
    5: [2, (o) => b.readUInt16LE(o)],
    6: [2, (o) => b.readInt16LE(o)],
    7: [4, (o) => b.readUInt32LE(o)],
    8: [4, (o) => b.readInt32LE(o)],
    9: [4, (o) => b.readFloatLE(o)],
    10: [8, (o) => b.readDoubleLE(o)],
  };
  if (!types[pixelType]) throw new Error(`지원하지 않는 화소 형식(${pixelType})입니다.`);
  const [bytes, read] = types[pixelType];

  // 좌표: 좌상단 화소 중심과 화소 크기. 가변 길이 항목은 [개수, 포인터] 8바이트 뒤에 값이 온다.
  const info = part('Eprj_MapInfo');
  let p = info.data;
  const projection = b.toString('latin1', p + 8, p + 8 + b.readInt32LE(p)).split('\0')[0];
  p += 8 + b.readInt32LE(p);
  const ulx = b.readDoubleLE(p + 8);
  const uly = b.readDoubleLE(p + 16);
  const cellsize = b.readDoubleLE(p + 56);
  if (Math.abs(b.readDoubleLE(p + 64) - cellsize) > 1e-6) throw new Error('가로·세로 화소 크기가 다른 DEM 은 지원하지 않습니다.');

  const nodataNode = part('Eimg_NonInitializedValue');
  const nodata = nodataNode ? read(nodataNode.data + 20) : -9999;

  // 블록 목록: 항목마다 fileCode(2) offset(4) size(4) logvalid(2) compressionType(2)
  const dms = part('Edms_State');
  const nblocks = b.readInt32LE(dms.data);
  const table = b.readInt32LE(dms.data + 18);
  const z = new Float64Array(ncols * nrows).fill(nodata);
  const perRow = Math.ceil(ncols / blockW);
  for (let i = 0; i < nblocks; i++) {
    const t = table + i * 14;
    const offset = b.readInt32LE(t + 2);
    if (!b.readUInt16LE(t + 10)) continue; // 값이 없는 블록
    const values = b.readUInt16LE(t + 12) ? unpackBlock(b, offset, blockW * blockH) : null;
    const r0 = Math.floor(i / perRow) * blockH;
    const c0 = (i % perRow) * blockW;
    for (let r = 0; r < blockH && r0 + r < nrows; r++) {
      for (let c = 0; c < blockW && c0 + c < ncols; c++) {
        const k = r * blockW + c;
        z[(r0 + r) * ncols + c0 + c] = values ? values[k] : read(offset + k * bytes);
      }
    }
  }
  const header = { ncols, nrows, xllcorner: ulx - cellsize / 2, yllcorner: uly + cellsize / 2 - nrows * cellsize, cellsize };
  return { header, ncols, nrows, cellsize, nodata, z, projection };
}

// 압축 블록: 최솟값 + 비트 묶음(런 길이 유무 두 가지). 여러 바이트 값은 빅엔디언.
function unpackBlock(b, start, count) {
  const min = b.readInt32LE(start);
  const runs = b.readInt32LE(start + 4);
  const bits = b[start + 12];
  let pos = runs === -1 ? start + 13 : start + b.readInt32LE(start + 8);
  let bit = 0;
  const next = () => {
    let v = 0;
    if (bits >= 8) {
      for (let n = 0; n < bits / 8; n++) v = v * 256 + b[pos++];
    } else if (bits > 0) {
      v = (b[pos] >> bit) & ((1 << bits) - 1);
      bit += bits;
      if (bit === 8) { bit = 0; pos++; }
    }
    return v + min;
  };
  const out = new Float64Array(count);
  if (runs === -1) {
    for (let k = 0; k < count; k++) out[k] = next();
    return out;
  }
  let counter = start + 13;
  let k = 0;
  for (let r = 0; r < runs && k < count; r++) {
    const extra = b[counter] >> 6;
    let repeat = b[counter++] & 0x3f;
    for (let n = 0; n < extra; n++) repeat = repeat * 256 + b[counter++];
    const v = next();
    for (let n = 0; n < repeat && k < count; n++) out[k++] = v;
  }
  return out;
}

// 가장자리와 NODATA 이웃이 있는 칸은 NODATA 로 둔다
function slopeAspect({ ncols, nrows, cellsize, nodata, z }) {
  const slope = new Float32Array(ncols * nrows).fill(OUT_NODATA);
  const aspect = new Float32Array(ncols * nrows).fill(OUT_NODATA);
  const deg = 180 / Math.PI;
  for (let r = 1; r < nrows - 1; r++) {
    for (let c = 1; c < ncols - 1; c++) {
      const i = r * ncols + c;
      const a = z[i - ncols - 1], b = z[i - ncols], cc = z[i - ncols + 1];
      const d = z[i - 1], f = z[i + 1];
      const g = z[i + ncols - 1], h = z[i + ncols], k = z[i + ncols + 1];
      if ([a, b, cc, d, z[i], f, g, h, k].includes(nodata)) continue;
      const dzdx = (cc + 2 * f + k - (a + 2 * d + g)) / (8 * cellsize); // 동쪽으로 갈수록 +
      const dzdy = (a + 2 * b + cc - (g + 2 * h + k)) / (8 * cellsize); // 북쪽으로 갈수록 +
      slope[i] = Math.atan(Math.hypot(dzdx, dzdy)) * deg;
      // 향 = 내리막 방향
      aspect[i] = dzdx === 0 && dzdy === 0 ? -1 : (Math.atan2(-dzdx, -dzdy) * deg + 360) % 360;
    }
  }
  return { slope, aspect };
}

function writeAsc(file, { header, ncols }, values, nodata = OUT_NODATA) {
  const head = Object.entries({ ...header, nodata_value: nodata }).map(([k, v]) => `${k} ${v}`);
  const rows = [];
  for (let i = 0; i < values.length; i += ncols) {
    rows.push(Array.from(values.subarray(i, i + ncols), (v) => (v === nodata ? nodata : v.toFixed(2))).join(' '));
  }
  fs.writeFileSync(file, `${head.join('\n')}\n${rows.join('\n')}\n`);
}

const readDem = (file) => (/\.img$/i.test(file) ? readImg(file) : readAsc(file));

module.exports = { readAsc, readImg, readDem, slopeAspect, writeAsc };

if (require.main === module) {
  const [input, prefix] = process.argv.slice(2);
  if (!input) {
    console.error('사용: node dem.js <DEM.asc|DEM.img> [출력 접두어]');
    process.exit(1);
  }
  const dem = readDem(input);
  const { slope, aspect } = slopeAspect(dem);
  const base = prefix || input.replace(/\.(asc|img)$/i, '');
  writeAsc(`${base}_slope.asc`, dem, slope);
  writeAsc(`${base}_aspect.asc`, dem, aspect);
  const valid = slope.filter((v) => v !== OUT_NODATA);
  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  const max = valid.reduce((m, v) => Math.max(m, v), 0);
  console.log(`${dem.ncols}x${dem.nrows} · 격자 ${dem.cellsize}m · 평균 경사 ${mean.toFixed(2)}° · 최대 ${max.toFixed(2)}°`);
  console.log(`저장: ${base}_slope.asc / ${base}_aspect.asc`);
}
