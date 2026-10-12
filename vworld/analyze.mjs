#!/usr/bin/env node
// 주소 하나로 전 과정 실행
//   주소 → (지오코더) 필지 PNU → 법정동(읍·면이면 리) 대상지 → 레이어 수집 → DEM·기후 → 적합도 판정·지표 대시보드
//
// 사용: node --env-file=.env analyze.mjs "충청남도 천안시 동남구 상명대길 31" [--out out] [--refresh]
//   같은 동·리를 이미 받았으면 수집을 건너뛰고 판정만 다시 함(--refresh로 새로 수집)
//
// 지오코더 2.0 이용조건(결과 저장 금지): 좌표는 필지를 찾는 데만 쓰고 저장하지 않는다.
// 저장되는 것은 검색어·PNU와 행정코드로 받은 레이어뿐.

import { spawn } from 'node:child_process';
import { readFile, readdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const address = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.match(/^--(out)$/)).join(' ').trim();
const outRoot = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(HERE, 'out');
const refresh = args.includes('--refresh');
const KEY = process.env.VWORLD_KEY?.trim(), DOMAIN = process.env.VWORLD_DOMAIN?.trim();

// process.exit()는 열린 fetch 핸들과 겹치면 Windows에서 Node가 비정상 종료됨 → 예외로 멈추고 exitCode만 설정
class Stop extends Error {}
const fail = (m) => { throw new Stop(m); };
async function main() {
if (!address) fail('주소를 입력하세요. 예: node --env-file=.env analyze.mjs "충청남도 천안시 동남구 상명대길 31"');
if (!KEY) fail('VWORLD_KEY가 없습니다. --env-file=.env로 실행하세요.');

// ---------------------------------------------------------------- 1. 주소 → 좌표 (저장하지 않음)
async function geocode(addr) {
  for (const type of ['ROAD', 'PARCEL']) {
    const p = new URLSearchParams({ service: 'address', request: 'getCoord', version: '2.0', crs: 'epsg:4326', format: 'json', errorformat: 'json', type, address: addr, refine: 'true', key: KEY });
    const r = JSON.parse(await (await fetch('https://api.vworld.kr/req/address?' + p, { signal: AbortSignal.timeout(20_000) })).text()).response;
    if (r.status === 'OK') return { x: r.result.point.x, y: r.result.point.y, type, refined: r.refined?.text ?? addr };
    if (r.status === 'ERROR') throw new Error(`지오코더 오류: ${r.error?.code} ${r.error?.text}`);
  }
  return null;
}
async function feature(data, params) {
  const p = new URLSearchParams({ service: 'data', version: '2.0', request: 'GetFeature', format: 'json', errorFormat: 'json',
    key: KEY, crs: 'EPSG:4326', size: '1', page: '1', geometry: 'false', attribute: 'true', data, ...params });
  if (DOMAIN) p.set('domain', DOMAIN);
  const r = JSON.parse(await (await fetch('https://api.vworld.kr/req/data?' + p, { signal: AbortSignal.timeout(20_000) })).text()).response;
  if (r.status === 'ERROR') throw new Error(`${data}: ${r.error?.text}`);
  return r.result?.featureCollection?.features?.[0]?.properties ?? null;
}

console.log(`검색: ${address}`);
const g = await geocode(address);
if (!g) fail('주소를 찾지 못했습니다. 시·군·구부터 도로명+건물번호 또는 동·리+지번으로 적어 보세요.');
console.log(`  → ${g.refined} (${g.type === 'ROAD' ? '도로명' : '지번'})`);
const point = `POINT(${g.x} ${g.y})`;

// ---------------------------------------------------------------- 2. 필지·대상지(법정동 또는 리)
const parcel = await feature('LP_PA_CBND_BUBUN', { geomFilter: point });
if (!parcel) fail('이 위치의 필지를 찾지 못했습니다.');
const pnu = String(parcel.pnu), code10 = pnu.slice(0, 10), isRi = code10.slice(8) !== '00';
const siteLayer = isRi ? { data: 'LT_C_ADRI_INFO', attr: `li_cd:=:${code10}` } : { data: 'LT_C_ADEMD_INFO', attr: `emd_cd:=:${code10.slice(0, 8)}` };
const siteProps = await feature(siteLayer.data, { attrFilter: siteLayer.attr });
if (!siteProps) fail(`대상지 경계(${siteLayer.data} ${siteLayer.attr})를 찾지 못했습니다.`);
const siteName = siteProps.li_kor_nm ?? siteProps.emd_kor_nm;
console.log(`  필지 ${parcel.addr} (PNU ${pnu})`);
console.log(`  대상지 ${siteProps.full_nm} — ${isRi ? '리' : '법정동'} 코드 ${code10}`);

const dir = join(outRoot, `${code10}_${siteName}`);
const exists = async (p) => access(p).then(() => true, () => false);
const has = async (prefix) => (await exists(dir)) && (await readdir(dir)).some((f) => f.startsWith(prefix));

// ---------------------------------------------------------------- 3. 수집·판정 (하위 스크립트 실행)
// vworld.mjs는 결과 줄(✓ ✗ ! 면적 제한)만, 나머지 스크립트는 전체를 그대로 보여 줌
function run(script, scriptArgs, label) {
  return new Promise((resolve, reject) => {
    console.log(`▶ ${label}`);
    const ch = spawn(process.execPath, [join(HERE, script), ...scriptArgs], { cwd: HERE, env: process.env });
    const keep = script === 'vworld.mjs'
      ? (l) => /✓|✗|^\s*!|면적 제한/.test(l) && !/예시 목록에 없습니다/.test(l)
      : (l) => !/^\s*https:\/\//.test(l);
    const relay = (s) => s.toString().split(/\r?\n|\r/).filter((l) => l.trim() && keep(l)).forEach((l) => console.log('   ' + l.trim().replace(/ → .*[\\/]([^\\/]+)\.geojson,.*$/, ' → $1')));
    ch.stdout.on('data', relay);
    ch.stderr.on('data', relay);
    ch.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${label} 실패 (exit ${code})`))));
  });
}
const latestFile = async (prefix) => (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.geojson')).sort().at(-1);

const collected = !refresh && (await has(`${siteLayer.data}_`)) && (await has('LP_PA_CBND_BUBUN_')) && (await has('DEM_'));
if (collected) {
  console.log(`  이미 받은 자료 사용: ${dir} (새로 받으려면 --refresh)`);
} else {
  const v = (data, extra, label) => run('vworld.mjs', ['--out', dir, '--data', data, ...extra], label);
  await v(siteLayer.data, ['--attr', siteLayer.attr], `대상지 경계 ${siteLayer.data}`);
  const boundary = JSON.parse(await readFile(join(dir, await latestFile(`${siteLayer.data}_`)), 'utf8'));
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => (typeof c[0] === 'number' ? (b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])]) : c.forEach(walk));
  boundary.features.forEach((f) => walk(f.geometry.coordinates));
  const BOX = `BOX(${b.map((x) => x.toFixed(5)).join(',')})`;
  // 경계 바로 밖의 간선도로·교차점·IC 진입로와 건물도 거리·밀도 계산에 들어가도록 넓혀 받음
  const lat0 = (b[1] + b[3]) / 2;
  const grow = (m) => { const dx = m / (111320 * Math.cos((lat0 * Math.PI) / 180)), dy = m / 110574; return `BOX(${[b[0] - dx, b[1] - dy, b[2] + dx, b[3] + dy].map((x) => x.toFixed(5)).join(',')})`; };

  await v('LP_PA_CBND_BUBUN', ['--attr', `pnu:like:${code10}`], '필지(연속지적도)');
  for (const id of ['LT_C_UQ111', 'LT_C_UQ112', 'LT_C_UQ113', 'LT_C_UQ114']) await v(id, ['--geom', BOX], `용도지역 ${id}`);
  for (const id of ['LT_C_UQ121', 'LT_C_UQ123', 'LT_C_UQ124', 'LT_C_UQ125', 'LT_C_UQ126', 'LT_C_UQ128', 'LT_C_UQ129', 'LT_C_UQ130']) await v(id, ['--geom', BOX], `용도지구 ${id}`);
  await v('LT_L_MOCTLINK', ['--geom', grow(2000)], '도로(교통 링크, 경계 +2km)');
  await v('LT_C_SPBD', ['--geom', grow(500)], '건물(경계 +500m)');
  const bf = join(dir, await latestFile(`${siteLayer.data}_`));
  await run('dem.mjs', [bf, dir], 'DEM 90m');
  await run('climate.mjs', [bf, dir], '기온·강수(참고값)').catch((e) => console.warn(`  ! ${e.message} — 지표 ①은 대기로 표시`));
}

await run('suitability.mjs', [dir, '--target-pnu', pnu, '--target-label', address], '적합도 판정·지표 대시보드');
const report = join(dir, 'suitability', 'report.html');
console.log(`REPORT ${report}`);
}

try { await main(); } catch (e) { console.error(`✗ ${e.message}`); process.exitCode = 1; }
