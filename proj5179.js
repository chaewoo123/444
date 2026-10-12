// EPSG:5179(KGD2002 통합좌표계, GRS80 횡단 메르카토르) → 경위도 → EPSG:3857
// 대시보드 지도는 배경지도와 맞추려고 모든 도형을 EPSG:3857 로 그린다.
const { lonLatToMerc } = require('./terrain_tiles.js');

const A = 6378137;
const F = 1 / 298.257222101;
const E2 = 2 * F - F * F;
const K0 = 0.9996;
const LAT0 = (38 * Math.PI) / 180;
const LON0 = (127.5 * Math.PI) / 180;
const FE = 1000000;
const FN = 2000000;

const arc = (phi) =>
  A *
  ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi -
    ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
    ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
    ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));
const M0 = arc(LAT0);

function toLonLat(x, y) {
  const mu = (M0 + (y - FN) / K0) / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const ep2 = E2 / (1 - E2);
  const sin = Math.sin(phi1);
  const cos = Math.cos(phi1);
  const T = Math.tan(phi1) ** 2;
  const C = ep2 * cos * cos;
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const R = (A * (1 - E2)) / (1 - E2 * sin * sin) ** 1.5;
  const D = (x - FE) / (N * K0);
  const phi =
    phi1 -
    ((N * Math.tan(phi1)) / R) *
      (D ** 2 / 2 - ((5 + 3 * T + 10 * C - 4 * C * C - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T + 298 * C + 45 * T * T - 252 * ep2 - 3 * C * C) * D ** 6) / 720);
  const lam = LON0 + (D - ((1 + 2 * T + C) * D ** 3) / 6 + ((5 - 2 * C + 28 * T - 3 * C * C + 8 * ep2 + 24 * T * T) * D ** 5) / 120) / cos;
  return [(lam * 180) / Math.PI, (phi * 180) / Math.PI];
}

const toMerc = (x, y) => lonLatToMerc(...toLonLat(x, y));

module.exports = { toLonLat, toMerc };
