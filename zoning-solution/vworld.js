// 브이월드 오픈API 도구 — 2D 데이터 API 2.0 · WMS · 지오코더 2.0
//   node vworld.js data <서비스ID> "<geomFilter>" [attrFilter] [size] [태그]
//   node vworld.js geocode "<주소>" [road|parcel]
//   node vworld.js reverse <경도> <위도>
//   node vworld.js wms <레이어,레이어> <minx,miny,maxx,maxy> [가로px]
//       지적도 선은 lp_pa_cbnd_bubun,lp_pa_cbnd_bonbun 을 함께 넣어야 그려진다
//   node vworld.js at "<주소>"            주소 → 좌표 → 필지 · 용도지역지구
// 쓰지 않는 인자 자리는 "-" 로 비운다. 좌표는 모두 EPSG:4326(경도,위도).
const fs = require('fs');
const path = require('path');

// .env 의 값은 환경변수에 없을 때만 채운다
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

// 키는 환경변수에서만 읽고 코드·문서·화면에 남기지 않는다
const KEY = process.env.VWORLD_KEY;
const DOMAIN = process.env.VWORLD_DOMAIN; // 발급 시 등록한 서비스 URL
const HOST = 'https://api.vworld.kr/req';
const OUT_DIR = path.join(__dirname, 'vworld_out');

// 대시보드에서 자주 쓰는 서비스 ID (2026-10-12 조회로 응답 확인한 것만)
const LAYERS = {
  시도: 'LT_C_ADSIDO_INFO',
  시군구: 'LT_C_ADSIGG_INFO',
  읍면동: 'LT_C_ADEMD_INFO',
  리: 'LT_C_ADRI_INFO',
  연속지적도: 'LP_PA_CBND_BUBUN',
  도시지역: 'LT_C_UQ111',
  관리지역: 'LT_C_UQ112',
  농림지역: 'LT_C_UQ113',
  자연환경보전지역: 'LT_C_UQ114',
  경관지구: 'LT_C_UQ121',
  고도지구: 'LT_C_UQ123',
  방화지구: 'LT_C_UQ124',
  방재지구: 'LT_C_UQ125',
  보호지구: 'LT_C_UQ126',
  취락지구: 'LT_C_UQ128',
  개발진흥지구: 'LT_C_UQ129',
  지구단위계획등: 'LT_C_UQ141',
  개발제한구역: 'LT_C_UD801',
};

function buildUrl(service, params, key) {
  const p = new URLSearchParams({ ...params, key });
  if (DOMAIN) p.set('domain', DOMAIN);
  return `${HOST}/${service}?${p}`;
}
const masked = (service, params) => buildUrl(service, params, '{VWORLD_KEY}');

// status 를 먼저 확인한다. NOT_FOUND 는 오류가 아니라 0건.
async function call(service, params) {
  if (!KEY) throw new Error('환경변수 VWORLD_KEY 가 없습니다.');
  const res = await fetch(buildUrl(service, params, KEY));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { response } = await res.json();
  if (response.status === 'ERROR') {
    const e = response.error || {};
    throw new Error(`status=ERROR ${e.code || ''} ${e.text || ''}`.trim());
  }
  return response;
}

// 2D 데이터 API 2.0 — 1000건 초과 시 page 증가 연속 수신
async function getFeatures(data, { geomFilter, attrFilter, size = 1000, geometry = true, crs = 'EPSG:4326' } = {}) {
  const base = {
    service: 'data',
    version: '2.0',
    request: 'GetFeature',
    format: 'json',
    errorformat: 'json',
    data,
    crs, // geomFilter 좌표도 이 좌표계로 적는다
    size: String(Math.min(Number(size) || 1000, 1000)),
    geometry: String(geometry),
    attribute: 'true',
  };
  if (geomFilter) base.geomFilter = geomFilter;
  if (attrFilter) base.attrFilter = attrFilter;

  const features = [];
  const requests = [];
  let page = 1;
  let totalPages = 1;
  let total = 0;
  let crsInfo;
  do {
    const params = { ...base, page: String(page) };
    const r = await call('data', params);
    requests.push(masked('data', params));
    if (r.status === 'NOT_FOUND') break;
    const fc = r.result.featureCollection;
    features.push(...fc.features);
    crsInfo = crsInfo || fc.crs;
    total = Number(r.record.total);
    totalPages = Number(r.page.total);
    page += 1;
  } while (page <= totalPages);
  return { features, total, pages: totalPages, crs: crsInfo, requests };
}

// 지오코더 2.0 — 주소 → 좌표. type 을 주지 않으면 도로명 후 지번 순으로 시도한다.
async function geocode(address, type) {
  for (const t of type ? [type] : ['road', 'parcel']) {
    const params = {
      service: 'address',
      request: 'getcoord',
      version: '2.0',
      crs: 'epsg:4326',
      address,
      refine: 'true',
      simple: 'false',
      format: 'json',
      type: t,
    };
    const r = await call('address', params);
    if (r.status === 'OK') {
      return {
        x: Number(r.result.point.x),
        y: Number(r.result.point.y),
        type: t,
        refined: r.refined && r.refined.text,
        request: masked('address', params),
      };
    }
  }
  return null;
}

// 지오코더 2.0 — 좌표 → 주소
async function reverseGeocode(x, y) {
  const params = {
    service: 'address',
    request: 'getAddress',
    version: '2.0',
    crs: 'epsg:4326',
    point: `${x},${y}`,
    format: 'json',
    type: 'both',
  };
  const r = await call('address', params);
  if (r.status !== 'OK') return [];
  return r.result.map((a) => ({ type: a.type, text: a.text }));
}

// WMS(화면 중첩용) — PNG 한 장. WMS 1.3.0 의 EPSG:4326 은 위도,경도 순서.
async function wmsImage(layers, [minx, miny, maxx, maxy], width = 1024) {
  if (!KEY) throw new Error('환경변수 VWORLD_KEY 가 없습니다.');
  const midLat = ((miny + maxy) / 2) * (Math.PI / 180);
  const height = Math.round((width * (maxy - miny)) / ((maxx - minx) * Math.cos(midLat)));
  const names = layers.toLowerCase();
  const params = {
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.3.0',
    LAYERS: names,
    STYLES: '',
    CRS: 'EPSG:4326',
    BBOX: `${miny},${minx},${maxy},${maxx}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
    EXCEPTIONS: 'text/xml',
  };
  const res = await fetch(buildUrl('wms', params, KEY));
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) {
    throw new Error(`WMS 실패 (${res.status} ${type}) ${(await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}`);
  }
  const png = Buffer.from(await res.arrayBuffer());
  // 레이어가 그려지지 않는 축척이면 오류 대신 1x1 PNG 가 온다 (지적도는 수 km 이내로 확대해야 함)
  if (png.readUInt32BE(16) !== width) throw new Error('WMS 가 빈 1x1 이미지를 반환했습니다. 범위를 좁혀 보세요.');
  return { png, width, height, request: masked('wms', params) };
}

const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (로컬)

function save(name, content) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, content);
  return path.relative(__dirname, file);
}

// 지오메트리·속성은 .geojson, 요청 URL(키 제외)·조회일은 .meta.json
function saveFeatures(data, r, tag) {
  const base = `${data}_${today()}${tag ? `_${tag}` : ''}`;
  const out = save(`${base}.geojson`, JSON.stringify({ type: 'FeatureCollection', crs: r.crs, features: r.features }));
  save(
    `${base}.meta.json`,
    JSON.stringify(
      {
        서비스ID: data,
        조회일: today(),
        좌표계: 'EPSG:4326',
        전체건수: r.total,
        수신건수: r.features.length,
        페이지수: r.pages,
        요청URL: r.requests,
      },
      null,
      2
    )
  );
  return out;
}

module.exports = { LAYERS, call, getFeatures, geocode, reverseGeocode, wmsImage, saveFeatures };

const blank = (a) => (a === '-' || a === undefined ? '' : a);

const commands = {
  async data(id, geomFilter, attrFilter, size, tag) {
    const data = LAYERS[id] || id;
    const r = await getFeatures(data, { geomFilter: blank(geomFilter), attrFilter: blank(attrFilter), size: blank(size) });
    console.log(`${data}: ${r.features.length}건 수신 (전체 ${r.total}건, ${r.pages}쪽)`);
    if (r.features.length) console.log(`저장: ${saveFeatures(data, r, blank(tag))}`);
    if (r.features.length !== r.total) throw new Error(`수신 ${r.features.length}건 ≠ 전체 ${r.total}건`);
  },
  async geocode(address, type) {
    const g = await geocode(address, blank(type));
    if (!g) throw new Error('좌표를 찾지 못했습니다.');
    console.log(`${g.x},${g.y}  (${g.type}) ${g.refined}`);
  },
  async reverse(x, y) {
    for (const a of await reverseGeocode(x, y)) console.log(`${a.type}: ${a.text}`);
  },
  async wms(layers, bbox, width) {
    const img = await wmsImage(layers, bbox.split(',').map(Number), Number(blank(width)) || 1024);
    console.log(`저장: ${save(`WMS_${layers.replace(/,/g, '+')}_${today()}.png`, img.png)} (${img.width}x${img.height})`);
  },
  async at(address) {
    const g = await geocode(address);
    if (!g) throw new Error('좌표를 찾지 못했습니다.');
    console.log(`좌표: ${g.x},${g.y}  (${g.type}) ${g.refined}`);
    const point = `POINT(${g.x} ${g.y})`;
    const parcel = await getFeatures(LAYERS.연속지적도, { geomFilter: point, geometry: false });
    for (const f of parcel.features) console.log(`필지: ${f.properties.addr} · PNU ${f.properties.pnu} · ${f.properties.jibun}`);
    for (const name of ['도시지역', '관리지역', '농림지역', '자연환경보전지역']) {
      const z = await getFeatures(LAYERS[name], { geomFilter: point, geometry: false });
      for (const f of z.features) console.log(`${name}: ${JSON.stringify(f.properties)}`);
    }
  },
};

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!commands[cmd]) {
    console.error('사용: node vworld.js <data|geocode|reverse|wms|at> ...  (파일 첫머리 주석 참조)');
    process.exit(1);
  }
  commands[cmd](...args).catch((e) => {
    console.error('실패:', e.message);
    process.exit(1);
  });
}
