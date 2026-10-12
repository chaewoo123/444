// Vercel 서버 함수: /api/zoning?r=<기능>. 처리는 로컬 서버와 같은 dashboard_server.js 가 맡는다.
// 인증키는 Vercel 환경변수 VWORLD_KEY · VWORLD_DOMAIN 에서 읽는다.
module.exports = require('../dashboard_server.js').handler;
