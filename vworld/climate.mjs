#!/usr/bin/env node
// 지표 ① 기온·강수 — 대상지 중심점의 최근 연평균 기온·연강수량 (참고값)
//
// 사용: node climate.mjs <대상지경계.geojson> <저장폴더> [--years 10]
// 출처: Open-Meteo Historical Weather API(ERA5 재분석, 키 불필요).
//   격자 재분석값이라 기상청 관측소(ASOS) 값과 다르다. 팀이 기상청 값을 확보했으면 indicators.json에 적을 것.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const [src, outDir] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const years = Number(args.includes('--years') ? args[args.indexOf('--years') + 1] : 10);
if (!src || !outDir) { console.error('사용: node climate.mjs <대상지경계.geojson> <저장폴더> [--years 10]'); process.exit(1); }

const site = JSON.parse(await readFile(src, 'utf8'));
let b = [Infinity, Infinity, -Infinity, -Infinity];
const walk = (c) => (typeof c[0] === 'number' ? (b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])]) : c.forEach(walk));
site.features.forEach((f) => walk(f.geometry.coordinates));
const lon = +((b[0] + b[2]) / 2).toFixed(4), lat = +((b[1] + b[3]) / 2).toFixed(4);

const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
const endYear = now.getFullYear() - 1, startYear = endYear - years + 1; // 마지막 완결 연도까지
const p = new URLSearchParams({ latitude: lat, longitude: lon, start_date: `${startYear}-01-01`, end_date: `${endYear}-12-31`,
  daily: 'temperature_2m_mean,precipitation_sum', timezone: 'Asia/Seoul' });
const res = await fetch('https://archive-api.open-meteo.com/v1/archive?' + p, { signal: AbortSignal.timeout(60_000) });
const j = await res.json();
if (!res.ok || j.error) throw new Error(`기후 자료 조회 실패: ${j.reason ?? res.status}`);

const byYear = {};
j.daily.time.forEach((d, i) => {
  const y = d.slice(0, 4);
  const e = (byYear[y] ??= { tSum: 0, tN: 0, precip: 0 });
  if (j.daily.temperature_2m_mean[i] != null) { e.tSum += j.daily.temperature_2m_mean[i]; e.tN++; }
  e.precip += j.daily.precipitation_sum[i] ?? 0;
});
const rows = Object.entries(byYear).map(([y, e]) => ({ year: +y, tempC: +(e.tSum / e.tN).toFixed(1), precipMm: Math.round(e.precip) }));
const mean = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;

const queriedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00';
await mkdir(outDir, { recursive: true });
const file = join(outDir, `CLIMATE_era5_${queriedAt.slice(0, 10)}.json`);
await writeFile(file, JSON.stringify({
  source: 'Open-Meteo Historical Weather API — ERA5 재분석',
  note: '격자 재분석 참고값. 기상청 관측값과 다를 수 있음',
  queriedAt, point: [lon, lat], gridElevationM: j.elevation, period: `${startYear}–${endYear}`,
  meanTempC: +mean('tempC').toFixed(1), meanPrecipMm: Math.round(mean('precipMm')), years: rows,
}, null, 2));
console.log(`✓ ${file} — ${startYear}–${endYear} 연평균 ${mean('tempC').toFixed(1)}℃ · 연강수 ${Math.round(mean('precipMm'))}mm`);
