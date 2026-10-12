# 브이월드 대상지 분석 하네스

스마트도시계획(캡스톤디자인) 6주차 — 요청 네 단계 → 적합도 판정 → 지표 대시보드 ①~⑥.
Node.js 18 이상만 있으면 됨(설치할 패키지 없음). 인증키는 `.env`에만 두고 공유·캡처 금지.

## 처음 한 번

`.env.example`을 `.env`로 복사해 `VWORLD_KEY`와 `VWORLD_DOMAIN`(키 발급 때 등록한 서비스 URL)을 채운다.

## 주소로 분석 (가장 쉬움)

```
node --env-file=.env server.mjs
```

브라우저에서 http://localhost:8787 을 열고 주소를 넣는다. 15~60초 뒤 보고서가 열린다.
명령줄로만 하려면:

```
node --env-file=.env analyze.mjs "충청남도 천안시 동남구 상명대길 31"
```

주소가 속한 법정동(읍·면은 리) 전체를 `out/<코드>_<이름>/`에 받고 `suitability/report.html`을 만든다.
같은 동·리를 다시 검색하면 받은 자료를 재사용한다(`--refresh`로 새로 받기).

## 결과 파일 (`out/<대상지>/suitability/`)

| 파일 | 내용 |
|---|---|
| `report.html` | 판정·대시보드·지도 보고서 |
| `matrix.csv` | 대안 비교 매트릭스 (과제 ④) |
| `reversal.csv` | 가중치 역전점 (과제 ⑤) |
| `indicators.csv` | 지표 ①~⑥, ⑥ 카탈로그 한 행, ③×⑥ 중첩, ④ 고시 이력, ⑤ 소요면적 |
| `indicator6.csv` | 지표 ⑥ 상세 (과제 ②) |
| `parcels.csv` | 필지별 점수 |

## 바꿀 수 있는 것

- `criteria.json` — 요건 문장·임계값·가중치. **가중치는 승인 후** `approval`을 채우고 다시 실행.
- `indicators.json` — 팀이 확보한 값(① 기상청 기온·강수, ② 격자 인구밀도, 목표인구). 키는 법정동·리 코드 10자리.

판정만 다시 하려면: `node --env-file=.env suitability.mjs out/<대상지>`

## 개별 스크립트

| 스크립트 | 하는 일 |
|---|---|
| `vworld.mjs` | 2D 데이터 API 2.0 레이어 1개 받기(요청 네 단계, 면적 제한 시 자동 분할) |
| `dem.mjs` | 90m 고도 격자(임시: AWS Terrain Tiles, `--source openmeteo` 가능) |
| `climate.mjs` | ① 기온·강수 참고값(ERA5) |
| `suitability.mjs` | 적합도 판정 + 지표 대시보드 + 보고서 |
| `map.mjs` | GeoJSON 여러 개를 지도 HTML로 |

## 한계

- DEM은 국토지리정보원 자료가 아니다(임시). 받으면 교체할 것.
- 기반시설 축은 건축물 수 대리지표. 가스·전기·상하수도·폐수 자료 없음.
- 지오코더 결과(좌표)는 저장하지 않는다(이용조건). 저장되는 것은 검색어와 PNU.
