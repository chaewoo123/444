#!/usr/bin/env node
// 배포용 보고서 모음 만들기 — out/<코드>_<이름>/suitability/의 보고서·csv를 reports/로 복사하고 목록 페이지를 만든다.
// reports/는 git에 올라가 Vercel 미리보기에서 /vworld/reports/ 로 열린다.
//
// 사용: node publish.mjs            (out/ 안의 '코드10자리_이름' 폴더만)
//
// 올라가는 것: 보고서 HTML과 csv(브이월드 레이어·계산 결과). 인증키·원본 레이어 파일·지오코더 좌표는 올라가지 않는다.

import { readdir, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out'), DEST = join(HERE, 'reports');
const FILES = ['report.html', 'matrix.csv', 'reversal.csv', 'indicators.csv', 'indicator6.csv', 'parcels.csv'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

await rm(DEST, { recursive: true, force: true });
const rows = [];
for (const d of (await readdir(OUT).catch(() => [])).filter((x) => /^\d{10}_/.test(x)).sort()) {
  const src = join(OUT, d, 'suitability');
  const s = await readFile(join(src, 'summary.json'), 'utf8').then(JSON.parse, () => null);
  if (!s) continue;
  await mkdir(join(DEST, d), { recursive: true });
  for (const f of FILES) await copyFile(join(src, f), join(DEST, d, f)).catch(() => {});
  rows.push({ d, s });
  console.log(`  ${d} — ${s.site}`);
}
rows.sort((a, b) => b.s.runAt.localeCompare(a.s.runAt));

const card = ({ d, s }) => {
  const [a, b, c] = s.ranking;
  const href = (f) => `${encodeURIComponent(d)}/${f}`;
  return `<article class="card">
    <div class="top"><h2><a href="${href('report.html')}">${esc(s.site)}</a></h2><span class="code">${esc(s.siteCode)}</span></div>
    <div class="ranks">${[a, b, c].map((r, i) => `<div class="r ${i === 0 ? 'first' : ''}"><span>${i + 1}위 ${esc(r.use)}</span><b>${r.score.toFixed(2)}</b></div>`).join('')}</div>
    <p class="meta">개발가능지 ${s.areaHa.dev}ha · 필지 ${s.counts.parcels.toLocaleString()}개${s.target ? ` · 검색 주소 ${esc(s.target.label)}` : ''}</p>
    <p class="meta">${s.approval.approved ? '가중치 승인' : '가중치 승인 전 시험 계산'} · 계산 ${esc(s.runAt.slice(0, 16).replace('T', ' '))}</p>
    <p class="dl"><a class="btn" href="${href('report.html')}">보고서 열기</a>
      ${['matrix.csv', 'reversal.csv', 'indicators.csv', 'parcels.csv'].map((f) => `<a href="${href(f)}" download>${f}</a>`).join(' · ')}</p>
  </article>`;
};

await mkdir(DEST, { recursive: true });
await writeFile(join(DEST, 'index.html'), `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>대상지 적합도 보고서</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#1d2433; --muted:#5f6b7a; --line:#e3e7ee; --brand:#0b4a8f; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 "Pretendard","Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif; }
  header { background:var(--brand); color:#fff; padding:28px 16px 22px; }
  .wrap { max-width:960px; margin:0 auto; }
  header small { opacity:.8; } header h1 { margin:6px 0 4px; font-size:24px; } header p { margin:0; opacity:.9; font-size:14px; }
  main { padding:20px 16px 48px; display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; }
  .top { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
  h2 { margin:0; font-size:17px; } h2 a { color:inherit; text-decoration:none; } h2 a:hover { text-decoration:underline; }
  .code { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
  .ranks { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin:12px 0 8px; }
  .r { border:1px solid var(--line); border-radius:8px; padding:6px 8px; font-size:13px; color:var(--muted); }
  .r b { display:block; color:var(--ink); font-size:20px; font-variant-numeric:tabular-nums; }
  .r.first { border-color:var(--brand); box-shadow:0 0 0 1px var(--brand) inset; }
  .meta { margin:2px 0; color:var(--muted); font-size:13px; }
  .dl { margin:12px 0 0; font-size:13px; } .dl a { color:var(--brand); }
  .btn { display:inline-block; background:var(--brand); color:#fff !important; text-decoration:none; padding:5px 12px; border-radius:999px; margin-right:6px; }
  footer { max-width:960px; margin:0 auto; padding:0 16px 40px; color:var(--muted); font-size:13px; }
</style></head>
<body>
<header><div class="wrap"><small>스마트도시계획(캡스톤디자인) · 6주차 · 444팀</small><h1>대상지 적합도 보고서</h1>
<p>주거·상업·공업 적합도와 지표 ①~⑥ · 보고서를 열어 지도·매트릭스·역전점을 확인하고 의견은 PR에 남겨 주세요.</p></div></header>
<main class="wrap">${rows.length ? rows.map(card).join('\n') : '<p>아직 보고서가 없습니다.</p>'}</main>
<footer>새 주소 분석은 각자 PC에서 <code>node --env-file=.env server.mjs</code>로 실행 → <code>node publish.mjs</code> → 커밋·푸시하면 여기에 추가됩니다. 사용법: vworld/README.md</footer>
</body></html>`);
console.log(`✓ ${DEST}\\index.html (${rows.length}곳)`);
