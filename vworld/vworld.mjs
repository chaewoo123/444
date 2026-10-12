#!/usr/bin/env node
// 브이월드 2D 데이터 API 2.0 하네스 — 요청 네 단계
//   ① 키와 서비스 URL  ② 서비스 ID 확정  ③ 요청 조립  ④ 응답 읽기
//
// 사용:
//   node --env-file=.env vworld.mjs [--data LT_C_ADSIDO_INFO] [--geom "BOX(...)"] [--size 1000] [--dry-run]
//
// 의존성 없음 (Node 18+ 내장 fetch). 키는 환경변수로만 받고, 화면·파일 어디에도 남기지 않는다.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ENDPOINT = 'https://api.vworld.kr/req/data';
const MAX_SIZE = 1000;

// ② 자주 쓰는 서비스 ID 예시. 전체 158개 목록은 vworld.kr 개발자센터 > 2D 데이터 API 레퍼런스에서 확인.
const EXAMPLES = {
  LT_C_ADSIDO_INFO: '행정구역 시도',
  LT_C_ADSIGG_INFO: '행정구역 시군구',
  LT_C_ADEMD_INFO: '행정구역 읍면동',
  LP_PA_CBND_BUBUN: '연속지적도 (토지)',
  LT_C_UQ111: '용도지역 — 도시지역',
  LT_C_UQ112: '용도지역 — 관리지역',
  LT_C_UQ113: '용도지역 — 농림지역',
  LT_C_UQ114: '용도지역 — 자연환경보전지역',
  LT_C_UQ121: '용도지구 — 경관지구',
  LT_C_UQ126: '용도지구 — 보호지구',
  LT_C_UQ128: '용도지구 — 취락지구',
  LT_C_UQ129: '용도지구 — 개발진흥지구',
  LT_C_UQ130: '용도지구 — 특정용도제한지구',
  LT_C_ADRI_INFO: '행정구역 리',
  LT_C_SPBD: '도로명주소 건물',
  LT_L_SPRD: '도로명주소 도로',
  LT_L_MOCTLINK: '교통 링크 (도로 등급)',
};

// ---------------------------------------------------------------- 인자
function parseArgs(argv) {
  const opts = {
    data: 'LT_C_ADSIDO_INFO',
    geom: null,
    size: MAX_SIZE,
    maxPages: 50,
    out: 'out',
    attrFilter: null,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--data') opts.data = next();
    else if (a === '--geom') opts.geom = next();
    else if (a === '--attr') opts.attrFilter = next();
    else if (a === '--size') opts.size = Number(next());
    else if (a === '--max-pages') opts.maxPages = Number(next());
    else if (a === '--out') opts.out = next();
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--list') { listExamples(); process.exit(0); }
    else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else fail(`알 수 없는 인자: ${a}`);
  }
  // 범위·속성 조건이 둘 다 없을 때만 기본 범위(서울시 경계 상자, 경도·위도 순)를 쓴다
  if (!opts.geom && !opts.attrFilter) opts.geom = 'BOX(126.76,37.41,127.19,37.72)';
  return opts;
}

function usage() {
  console.log(`사용: node --env-file=.env vworld.mjs [옵션]
  --data ID        서비스 ID (기본 LT_C_ADSIDO_INFO)
  --geom WKT       geomFilter, EPSG:4326 경도·위도 (기본 서울 BOX)
  --attr EXPR      attrFilter (예: "emd_cd:=:11110101")
  --size N         페이지당 건수, 1~1000 (기본 1000)
  --max-pages N    최대 페이지 수 안전장치 (기본 50)
  --out DIR        저장 폴더 (기본 out)
  --dry-run        요청하지 않고 조립된 URL(키 제외)만 출력
  --list           서비스 ID 예시 보기`);
}

function listExamples() {
  for (const [id, name] of Object.entries(EXAMPLES)) console.log(`${id.padEnd(20)} ${name}`);
}

function fail(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------- ① 키와 서비스 URL
function loadCredentials({ dryRun }) {
  const key = process.env.VWORLD_KEY?.trim();
  const domain = process.env.VWORLD_DOMAIN?.trim() || null;
  if (!key && !dryRun) {
    fail('VWORLD_KEY 환경변수가 없습니다. .env.example을 .env로 복사해 키를 넣고 --env-file=.env로 실행하세요.');
  }
  if (!domain) {
    console.warn('! VWORLD_DOMAIN 없음 — 브라우저 밖에서 호출하면 키 발급 때 등록한 서비스 URL과 맞지 않아 거부될 수 있습니다.');
  }
  return { key: key || 'DRY_RUN', domain };
}

// ---------------------------------------------------------------- ② 서비스 ID 확정
function checkServiceId(data) {
  if (!/^L[TP]_[A-Z0-9_]+$/.test(data)) {
    fail(`서비스 ID 형식이 아닙니다: ${data} (예: LT_C_ADSIDO_INFO)`);
  }
  if (!EXAMPLES[data]) {
    console.warn(`! ${data}은(는) 예시 목록에 없습니다. 레퍼런스의 158개 목록에서 철자를 확인하세요.`);
  }
}

// ---------------------------------------------------------------- ③ 요청 조립
function buildUrl({ key, domain }, opts, page) {
  if (!Number.isInteger(opts.size) || opts.size < 1 || opts.size > MAX_SIZE) {
    fail(`size는 1~${MAX_SIZE} 정수여야 합니다: ${opts.size}`);
  }
  if (!opts.geom && !opts.attrFilter) fail('geomFilter 또는 attrFilter 중 하나는 필요합니다.');

  const p = new URLSearchParams({
    service: 'data',
    version: '2.0',
    request: 'GetFeature',
    format: 'json',
    errorFormat: 'json',
    data: opts.data,
    key,
    crs: 'EPSG:4326',
    size: String(opts.size),
    page: String(page),
    geometry: 'true',
    attribute: 'true',
  });
  if (opts.geom) p.set('geomFilter', opts.geom);
  if (opts.attrFilter) p.set('attrFilter', opts.attrFilter);
  if (domain) p.set('domain', domain);
  return `${ENDPOINT}?${p}`;
}

// 일부 레이어(연속지적도·건물 등)는 BOX·POLYGON 면적을 10km² 이내로 제한한다.
// 넓은 BOX는 여유를 두고 TILE_KM2 이하 격자 조각으로 나눈다. BOX가 아니면 그대로.
const TILE_KM2 = 9.5;
function splitBox(geom) {
  const m = geom?.match(/^BOX\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/i);
  if (!m) return [geom];
  const [minx, miny, maxx, maxy] = m.slice(1).map(Number);
  const kx = 111.32 * Math.cos(((miny + maxy) / 2) * Math.PI / 180), ky = 110.57;
  const w = (maxx - minx) * kx, h = (maxy - miny) * ky;
  if (w * h <= TILE_KM2) return [geom];
  let nx = Math.max(1, Math.round(Math.sqrt((w * h / TILE_KM2) * (w / h)))), ny = 1;
  while ((w / nx) * (h / ny) > TILE_KM2) (w / nx > h / ny ? nx++ : ny++);
  const dx = (maxx - minx) / nx, dy = (maxy - miny) / ny, f = (v) => v.toFixed(6);
  const out = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    out.push(`BOX(${f(minx + i * dx)},${f(miny + j * dy)},${f(minx + (i + 1) * dx)},${f(miny + (j + 1) * dy)})`);
  return out;
}

// 기록·출력용: key 파라미터를 통째로 뺀다
function redact(url) {
  const u = new URL(url);
  u.searchParams.delete('key');
  return u.toString();
}

// ---------------------------------------------------------------- ④ 응답 읽기
async function fetchPage(url, tries = 3) {
  for (let t = 1; ; t++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      try { return JSON.parse(text); }
      catch { throw new Error(`JSON이 아닌 응답: ${text.slice(0, 200)}`); }
    } catch (e) {
      if (t >= tries) throw e;
      console.warn(`  재시도 ${t}/${tries - 1}: ${e.message}`);
      await sleep(1000 * t);
    }
  }
}

// 응답 필드 5개: service · status · record · page · result (오류 시 error)
function readResponse(json) {
  const r = json?.response;
  if (!r) throw new Error('response 필드가 없습니다.');

  // status를 가장 먼저 본다
  if (r.status === 'NOT_FOUND') return { features: [], pageTotal: 0, recordTotal: 0 };
  if (r.status !== 'OK') {
    const e = r.error ?? {};
    throw new Error(`status=${r.status} [${e.level ?? '-'}/${e.code ?? '-'}] ${e.text ?? ''}`.trim());
  }

  return {
    features: r.result?.featureCollection?.features ?? [],
    pageTotal: Number(r.page?.total ?? 1),
    pageCurrent: Number(r.page?.current ?? 1),
    recordTotal: Number(r.record?.total ?? 0),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kstNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00';
}

// ---------------------------------------------------------------- 실행
async function main() {
  const opts = parseArgs(process.argv);

  console.log('① 키와 서비스 URL');
  const cred = loadCredentials(opts);
  console.log(`  key: ${opts.dryRun && cred.key === 'DRY_RUN' ? '(없음, dry-run)' : '설정됨 (출력 안 함)'}`);
  console.log(`  domain: ${cred.domain ?? '(없음)'}`);

  console.log('② 서비스 ID 확정');
  checkServiceId(opts.data);
  console.log(`  data=${opts.data}${EXAMPLES[opts.data] ? ` (${EXAMPLES[opts.data]})` : ''}`);

  console.log('③ 요청 조립');
  const firstUrl = buildUrl(cred, opts, 1);
  console.log(`  ${redact(firstUrl)}`);
  if (opts.dryRun) return;

  console.log('④ 응답 읽기');
  const queriedAt = kstNow();
  const byId = new Map(); // 조각 경계에 걸친 피처는 id로 한 번만 저장
  const requests = [];
  let tiles = [opts.geom];
  let recordTotal = 0, truncated = false;

  for (let t = 0; t < tiles.length; t++) {
    const geom = tiles[t];
    let page = 1, pageTotal = 1;
    while (page <= pageTotal) {
      if (page > opts.maxPages) {
        console.warn(`! --max-pages ${opts.maxPages} 도달 — ${pageTotal}쪽 중 일부만 받았습니다.`);
        truncated = true;
        break;
      }
      const url = buildUrl(cred, { ...opts, geom }, page);
      requests.push(redact(url));
      let r;
      try {
        r = readResponse(await fetchPage(url));
      } catch (e) {
        // 면적 제한이 있는 레이어만 오류를 낸다 → 그때만 BOX를 나눠 처음부터 다시 받는다
        const parts = splitBox(geom);
        if (tiles.length === 1 && /요청면적/.test(e.message) && parts.length > 1) {
          tiles = parts;
          console.log(`  면적 제한 응답 → BOX를 ${tiles.length}조각(각 ${TILE_KM2}km² 이하)으로 나눠 받습니다.`);
          t = -1;
          break;
        }
        throw e;
      }
      for (const f of r.features) byId.set(f.id ?? `${t}:${byId.size}`, f);
      pageTotal = r.pageTotal;
      if (page === 1) recordTotal += r.recordTotal;
      const tag = tiles.length > 1 ? `조각 ${t + 1}/${tiles.length} ` : '';
      console.log(`  ${tag}page ${page}/${pageTotal || 1}: ${r.features.length}건 (고유 누적 ${byId.size})`);
      if (r.features.length === 0) break;
      page++;
      await sleep(200);
    }
  }
  const features = [...byId.values()];
  // 조각으로 받으면 경계 중복 때문에 조각별 total 합이 고유 건수보다 크다
  if (tiles.length > 1 && !truncated) recordTotal = features.length;

  const stamp = queriedAt.slice(0, 10);
  await mkdir(opts.out, { recursive: true });
  const base = join(opts.out, `${opts.data}_${stamp}`);

  await writeFile(`${base}.geojson`, JSON.stringify({ type: 'FeatureCollection', features }));
  await writeFile(`${base}.meta.json`, JSON.stringify({
    source: 'VWorld 2D 데이터 API 2.0',
    data: opts.data,
    dataName: EXAMPLES[opts.data] ?? null,
    queriedAt,
    crs: 'EPSG:4326',
    geomFilter: opts.geom,
    tiles: tiles.length,
    attrFilter: opts.attrFilter,
    recordTotal,
    received: features.length,
    complete: features.length === recordTotal,
    requests, // 키 제외
  }, null, 2));

  console.log(`✓ ${features.length}건 저장 → ${base}.geojson, ${base}.meta.json`);
  if (features.length !== recordTotal) console.warn(`! 총 ${recordTotal}건 중 ${features.length}건만 받았습니다.`);
}

// 비동기 실패는 process.exit 대신 exitCode (Windows에서 열린 fetch 핸들과 겹치면 Node가 비정상 종료됨)
main().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
