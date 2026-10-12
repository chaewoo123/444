#!/usr/bin/env node
// 주소 검색 화면 — 브라우저에서 주소를 넣으면 analyze.mjs로 전 과정을 돌리고 보고서를 보여 줌
//
// 사용: node --env-file=.env server.mjs   → http://localhost:8787
//   인증키는 이 서버 프로세스 안에만 있고 브라우저로 보내지 않음(강의 6주차 36번: 화면 노출 금지).
//   이 컴퓨터(127.0.0.1)에서만 열림. 한 번에 한 주소씩 처리.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out');
const HOST = '127.0.0.1', PORT = Number(process.env.PORT) || 8787;
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
if (!process.env.VWORLD_KEY) { console.error('✗ VWORLD_KEY가 없습니다. node --env-file=.env server.mjs 로 실행하세요.'); process.exitCode = 1; }

let busy = false;
const urlOf = (file) => '/out/' + relative(OUT, file).split(sep).map(encodeURIComponent).join('/');

async function list() {
  const rows = [];
  for (const d of await readdir(OUT).catch(() => [])) {
    const f = join(OUT, d, 'suitability', 'summary.json');
    const s = await readFile(f, 'utf8').then(JSON.parse, () => null);
    if (s) rows.push({ dir: d, site: s.site, runAt: s.runAt, first: s.ranking[0], second: s.ranking[1], target: s.target?.label ?? null, url: urlOf(join(OUT, d, 'suitability', 'report.html')) });
  }
  return rows.sort((a, b) => b.runAt.localeCompare(a.runAt));
}

function runAnalyze(req, res, address) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (busy) { send('fail', '다른 주소를 분석하는 중입니다. 끝난 뒤 다시 시도하세요.'); return res.end(); }
  busy = true;
  const args = [join(HERE, 'analyze.mjs'), address];
  const ch = spawn(process.execPath, args, { cwd: HERE, env: process.env });
  let report = null, buf = '';
  const onData = (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const l of lines) {
      if (l.startsWith('REPORT ')) report = l.slice(7).trim();
      else if (l.trim()) send('log', l);
    }
  };
  ch.stdout.on('data', onData);
  ch.stderr.on('data', onData);
  ch.on('close', (code) => {
    busy = false;
    if (buf.trim()) send('log', buf);
    if (code === 0 && report) send('done', { url: urlOf(report) });
    else send('fail', '분석에 실패했습니다. 위 로그의 ✗ 줄을 확인하세요.');
    res.end();
  });
  req.on('close', () => { if (ch.exitCode == null) { /* 창을 닫아도 분석은 끝까지 진행 */ } });
}

async function serveFile(res, pathname) {
  const file = resolve(OUT, decodeURIComponent(pathname.slice('/out/'.length)));
  if (!file.startsWith(OUT + sep)) { res.writeHead(403); return res.end(); }
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) { res.writeHead(404); return res.end('없음'); }
  res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' });
  res.end(await readFile(file));
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    if (u.pathname === '/api/list') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(await list())); }
    if (u.pathname === '/run') {
      const address = (u.searchParams.get('address') ?? '').trim().slice(0, 200);
      if (!address) { res.writeHead(400); return res.end('주소 없음'); }
      return runAnalyze(req, res, address);
    }
    if (u.pathname.startsWith('/out/')) return serveFile(res, u.pathname);
    res.writeHead(404); res.end('없음');
  } catch (e) { res.writeHead(500); res.end(String(e.message)); }
}).listen(PORT, HOST, () => console.log(`주소 검색 화면: http://localhost:${PORT}  (종료: Ctrl+C)`));

const PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>대상지 적합도 검색</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --ink:#1d2433; --muted:#5f6b7a; --line:#e3e7ee; --brand:#0b4a8f; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.6 "Pretendard","Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",system-ui,sans-serif; }
  header { background:var(--brand); color:#fff; padding:28px 16px 22px; }
  .wrap { max-width:880px; margin:0 auto; }
  header small { opacity:.8; } header h1 { margin:6px 0 4px; font-size:24px; } header p { margin:0; opacity:.9; font-size:14px; }
  main { padding:20px 16px 48px; display:grid; gap:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px; }
  form { display:flex; gap:8px; flex-wrap:wrap; }
  input { flex:1 1 360px; font:inherit; padding:10px 12px; border:1px solid var(--line); border-radius:8px; }
  button { font:inherit; padding:10px 18px; border:0; border-radius:8px; background:var(--brand); color:#fff; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  .ex { font-size:13px; color:var(--muted); margin-top:8px; } .ex a { color:var(--brand); cursor:pointer; text-decoration:underline; }
  pre { background:#0f1623; color:#d7e0ee; border-radius:8px; padding:12px; margin:0; max-height:360px; overflow:auto; font:12.5px/1.5 ui-monospace,Consolas,monospace; white-space:pre-wrap; }
  .status { font-weight:600; margin-bottom:8px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { padding:8px; border-bottom:1px solid var(--line); text-align:left; } th { background:#f1f3f6; }
  a { color:var(--brand); }
  .muted { color:var(--muted); font-size:13px; }
</style></head>
<body>
<header><div class="wrap"><small>스마트도시계획(캡스톤디자인) · 6주차</small><h1>주소로 대상지 적합도 판정</h1>
<p>주소가 속한 법정동(읍·면은 리) 전체를 받아 주거·상업·공업 적합도와 지표 ①~⑥을 계산합니다. 보통 15~60초 걸립니다.</p></div></header>
<main class="wrap">
  <section class="card">
    <form id="f"><input id="q" placeholder="예: 충청남도 천안시 동남구 상명대길 31" autocomplete="off" required><button id="go">분석</button></form>
    <div class="ex">예시 <a data-q="충청남도 천안시 동남구 안서동 300">안서동 300</a> · <a data-q="충청남도 천안시 동남구 목천읍 서리 93-1">목천읍 서리 93-1</a> — 도로명(건물번호까지) 또는 지번 주소</div>
  </section>
  <section class="card" id="runCard" hidden><div class="status" id="st"></div><pre id="log"></pre></section>
  <section class="card"><h2 style="font-size:17px;margin:0 0 8px">지난 분석</h2><div id="list" class="muted">불러오는 중…</div></section>
  <p class="muted">인증키는 이 컴퓨터의 서버에만 있고 화면으로 보내지 않습니다. 주소 좌표(지오코더 결과)는 저장하지 않습니다.</p>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
async function loadList() {
  const rows = await (await fetch('/api/list')).json();
  $('list').innerHTML = rows.length ? '<table><tr><th>대상지</th><th>1위</th><th>검색 주소</th><th>계산</th></tr>' + rows.map((r) =>
    '<tr><td><a href="' + r.url + '">' + esc(r.site) + '</a></td><td>' + esc(r.first.use) + ' ' + r.first.score.toFixed(2) + ' <span class="muted">(2위 ' + esc(r.second.use) + ' ' + r.second.score.toFixed(2) + ')</span></td><td class="muted">' + esc(r.target ?? '–') + '</td><td class="muted">' + esc(r.runAt.slice(0, 16).replace('T', ' ')) + '</td></tr>').join('') + '</table>' : '아직 없음';
}
loadList();
document.querySelectorAll('[data-q]').forEach((a) => a.onclick = () => { $('q').value = a.dataset.q; $('f').requestSubmit(); });
$('f').onsubmit = (e) => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  $('go').disabled = true; $('runCard').hidden = false; $('log').textContent = ''; $('st').textContent = '분석 중… ' + q;
  const es = new EventSource('/run?address=' + encodeURIComponent(q));
  es.addEventListener('log', (ev) => { $('log').textContent += JSON.parse(ev.data) + '\\n'; $('log').scrollTop = 1e9; });
  es.addEventListener('done', (ev) => { es.close(); const { url } = JSON.parse(ev.data); $('st').innerHTML = '완료 — <a href="' + url + '">보고서 열기</a>'; $('go').disabled = false; loadList(); location.href = url; });
  es.addEventListener('fail', (ev) => { es.close(); $('st').textContent = JSON.parse(ev.data); $('go').disabled = false; });
  es.onerror = () => { es.close(); if ($('go').disabled) { $('st').textContent = '연결이 끊겼습니다.'; $('go').disabled = false; } };
};
</script>
</body></html>`;
