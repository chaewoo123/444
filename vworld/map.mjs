import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
// 사용: node map.mjs <a.geojson> [b.geojson ...] <map.html>  — 저장된 GeoJSON(여러 개 가능)을 지도 HTML로 만든다
//   레이어 이름은 같은 폴더의 .meta.json에 있는 dataName, 없으면 파일 이름
const args = process.argv.slice(2);
const dst = args.find((a) => a.endsWith('.html'));
const srcs = args.filter((a) => a.endsWith('.geojson'));
if (!dst || !srcs.length) { console.error('사용: node map.mjs a.geojson [b.geojson ...] map.html'); process.exit(1); }

const layers = srcs.map((src) => {
  let name = basename(src, '.geojson');
  try { name = JSON.parse(readFileSync(src.replace(/\.geojson$/, '.meta.json'), 'utf8')).dataName ?? name; } catch {}
  return `{ name: ${JSON.stringify(name)}, data: ${readFileSync(src, 'utf8')} }`;
});

writeFileSync(dst, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>VWorld 결과 지도</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>html,body,#map{margin:0;height:100%}</style></head><body><div id="map"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
const layers = [${layers.join(',\n')}];
const map = L.map('map');
// 배경: 키 없이 file://에서도 열리는 Esri 타일. 일반지도는 한국에서 13단계까지만 있어 그 이상은 확대해 보여 준다
const esri = (svc, o) => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/' + svc + '/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles © Esri', ...o });
const bases = { '위성': esri('World_Imagery').addTo(map), '일반지도': esri('World_Street_Map', { maxNativeZoom: 13 }) };
const colors = ['#1f5fa8', '#d9480f', '#2b8a3e', '#7048e8', '#c2255c', '#0c8599', '#e67700', '#5f3dc4', '#495057'];
const overlays = {};
let bounds = null;
layers.forEach(({ name, data }, i) => {
  const color = i === 0 ? '#ffd43b' : colors[(i - 1) % colors.length];
  const layer = L.geoJSON(data, {
    style: i === 0 ? { color: '#ffd43b', weight: 4, dashArray: '8 6', fillOpacity: 0 } : { color, weight: 1.5, fillOpacity: 0.3 },
    onEachFeature: (f, l) => l.bindTooltip('<b>' + name + '</b><br>' + Object.entries(f.properties).map(([k, v]) => k + ': ' + v).join('<br>'), { sticky: true }),
  }).addTo(map);
  overlays['<span style="color:' + color + '">■</span> ' + name + ' (' + data.features.length + ')'] = layer;
  if (i === 0 && layer.getLayers().length) bounds = layer.getBounds();
});
Object.values(overlays)[0].bringToFront(); // 첫 레이어(대상지 경계)를 맨 위에
L.control.layers(bases, overlays, { collapsed: false }).addTo(map);
map.fitBounds(bounds ?? L.featureGroup(Object.values(overlays)).getBounds());
</script></body></html>`);
console.log(`✓ ${srcs.length}개 레이어 → ${dst}`);
