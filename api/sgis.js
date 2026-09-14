// SGIS OpenAPI 중계 서버 (Vercel Function)
// 브라우저에 SGIS 키가 드러나지 않도록 서버에서 토큰을 받아 대신 호출한다.
// 필요한 환경변수: SGIS_KEY(서비스 ID), SGIS_SECRET(보안 Key)
//
// GET /api/sgis?op=stage&cd=          시·도(빈 값) / 시·군·구(2자리) / 읍·면·동(5자리) 목록
// GET /api/sgis?op=search&q=천안 안서동  지역 검색
// GET /api/sgis?op=region&adm_cd=11110&year=2024  지도에 필요한 경계·격자·통계 한 번에

const SGIS_BASE = "https://sgisapi.mods.go.kr/OpenAPI3";
const YEARS = ["2020", "2021", "2022", "2023", "2024"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// 따뜻한(재사용되는) 서버 인스턴스에서는 토큰과 목록을 메모리에 보관
let tokenCache = null; // { token, expires(ms) }
const stageCache = new Map(); // cd -> Promise<{ items }>
let sggListPromise = null;

async function getJson(ctx, path, params) {
  const url = new URL(`${ctx.base}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await ctx.fetch(url.toString());
  if (!res.ok) throw new HttpError(502, `SGIS 서버 응답 오류 (${res.status})`);
  try {
    return await res.json();
  } catch {
    throw new HttpError(502, "SGIS 응답을 읽지 못했어요.");
  }
}

async function getToken(ctx, force = false) {
  if (!force && tokenCache && Date.now() < tokenCache.expires - 5 * 60 * 1000) return tokenCache.token;
  if (ctx.base === SGIS_BASE && (!ctx.env.SGIS_KEY || !ctx.env.SGIS_SECRET)) {
    throw new HttpError(500, "서버에 SGIS_KEY / SGIS_SECRET 환경변수가 설정되지 않았어요.");
  }
  const j = await getJson(ctx, "auth/authentication.json", {
    consumer_key: ctx.env.SGIS_KEY || "",
    consumer_secret: ctx.env.SGIS_SECRET || "",
  });
  if (String(j.errCd) !== "0") throw new HttpError(500, `SGIS 인증 실패: ${j.errMsg}`);
  let expires = Number(j.result.accessTimeout);
  if (!Number.isFinite(expires)) expires = Date.now() + 60 * 60 * 1000;
  else if (expires < 1e11) expires *= 1000; // 초 단위로 오면 ms로
  tokenCache = { token: j.result.accessToken, expires };
  return tokenCache.token;
}

// 토큰 만료(-401)면 한 번 새로 받아 재시도. allowError면 SGIS 오류 응답도 그대로 돌려준다.
async function sgis(ctx, path, params = {}, { allowError = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const accessToken = await getToken(ctx, attempt === 1);
    const j = await getJson(ctx, path, { ...params, accessToken });
    const code = String(j.errCd ?? "0");
    if (code === "-401" && attempt === 0) continue;
    if (code !== "0" && !allowError) throw new HttpError(502, `SGIS 오류: ${j.errMsg} (${code})`);
    return j;
  }
}

const isOk = (j) => j && String(j.errCd) === "0";
const num = (v) => {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) ? n : null;
};

// ---------- 목록 ----------
function stage(ctx, cd) {
  const key = cd || "root";
  if (!stageCache.has(key)) {
    const p = sgis(ctx, "addr/stage.json", cd ? { cd } : {}).then((j) => ({
      items: (j.result || [])
        .map((r) => ({ cd: String(r.cd), name: r.addr_name }))
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    }));
    p.catch(() => stageCache.delete(key));
    stageCache.set(key, p);
  }
  return stageCache.get(key);
}

function sggList(ctx) {
  if (!sggListPromise) {
    sggListPromise = (async () => {
      const root = await stage(ctx, "");
      const lists = await Promise.all(
        root.items.map(async (s) =>
          (await stage(ctx, s.cd)).items.map((g) => ({ cd: g.cd, name: g.name, sidoCd: s.cd, sidoName: s.name }))
        )
      );
      return { sidos: root.items, sggs: lists.flat() };
    })();
    sggListPromise.catch(() => (sggListPromise = null));
  }
  return sggListPromise;
}

// ---------- 검색 ----------
// 충청북도 -> 충북, 서울특별시 -> 서울, 경기도 -> 경기
const sidoAbbr = (name) => (name.length >= 4 && name.endsWith("도") && !name.includes("특별") ? name[0] + name[2] : name.slice(0, 2));
const sidoMatches = (token, sido) => token === sido.name || token === sidoAbbr(sido.name) || (token.length >= 2 && sido.name.startsWith(token));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// "상계동" -> 상계1동, 상계3·4동 도 찾기
const emdMatches = (name, token) => {
  if (name.includes(token)) return true;
  const base = token.replace(/(동|읍|면)$/, "");
  return base.length >= 1 && base !== token && new RegExp(`^${escapeRe(base)}[0-9·.,]*(동|읍|면)$`).test(name);
};

function findSggs(sggs, tokens, sidoCd) {
  for (let k = Math.min(2, tokens.length); k >= 1; k--) {
    const pref = tokens.slice(0, k);
    const cands = sggs.filter((s) => (!sidoCd || s.sidoCd === sidoCd) && pref.every((t) => s.name.includes(t)));
    if (cands.length) return { cands: cands.slice(0, 6), rest: tokens.slice(k) };
  }
  return { cands: [], rest: tokens };
}

async function search(ctx, rawQ) {
  const q = String(rawQ).replace(/[^0-9A-Za-z가-힣·\-\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!q) throw new HttpError(400, "검색어를 입력해주세요.");
  if (q.length > 50) throw new HttpError(400, "검색어가 너무 길어요.");

  const results = new Map();
  const add = (r) => {
    if (r && !results.has(r.adm_cd)) results.set(r.adm_cd, r);
  };
  const fromGeocode = (j, sggCd) => {
    if (!isOk(j)) return;
    for (const r of j.result?.resultdata || []) {
      if (sggCd && r.sgg_cd !== sggCd) continue;
      if (/^\d{8}$/.test(r.adm_cd)) {
        const note = r.leg_nm && r.leg_nm !== "null" && r.leg_nm !== r.adm_nm ? `${r.leg_nm}(법정동) → 행정동 ${r.adm_nm}` : "";
        add({ level: "emd", adm_cd: r.adm_cd, label: `${r.sido_nm} ${r.sgg_nm} ${r.adm_nm}`, note });
      } else if (/^\d{5}$/.test(r.sgg_cd)) {
        add({ level: "sgg", adm_cd: r.sgg_cd, label: `${r.sido_nm} ${r.sgg_nm}`, note: "" });
      }
    }
  };

  const tokens = q.split(" ");
  const { sidos, sggs } = await sggList(ctx);

  // 1) 입력 그대로 주소 검색 (시·도부터 적은 경우)
  if (tokens.length >= 2) fromGeocode(await sgis(ctx, "addr/geocode.json", { address: q, resultcount: "5" }, { allowError: true }));

  // 2) 시·도를 빼먹어도 되도록 시·군·구 이름으로 후보를 찾고 시·도를 붙여 다시 검색
  const sido = sidos.find((s) => sidoMatches(tokens[0], s));
  const tries = [];
  if (sido && tokens.length > 1) tries.push(findSggs(sggs, tokens.slice(1), sido.cd));
  tries.push(findSggs(sggs, tokens, null));

  for (const { cands, rest } of tries) {
    if (!cands.length) continue;
    if (!rest.length) {
      cands.forEach((c) => add({ level: "sgg", adm_cd: c.cd, label: `${c.sidoName} ${c.name}`, note: "" }));
      continue;
    }
    const restText = rest.join(" ");
    await Promise.all(
      cands.slice(0, 4).map(async (c) => {
        const [geo, emds] = await Promise.all([
          sgis(ctx, "addr/geocode.json", { address: `${c.sidoName} ${c.name} ${restText}`, resultcount: "5" }, { allowError: true }),
          stage(ctx, c.cd).catch(() => ({ items: [] })),
        ]);
        fromGeocode(geo, c.cd);
        emds.items
          .filter((e) => emdMatches(e.name, rest[0]))
          .forEach((e) => add({ level: "emd", adm_cd: e.cd, label: `${c.sidoName} ${c.name} ${e.name}`, note: "" }));
      })
    );
  }

  // 주소 검색은 법정동 이름(예: 안서동)을 돌려주기도 해서, 코드로 실제 행정동 이름을 다시 확인
  await Promise.all(
    [...results.values()]
      .filter((r) => r.level === "emd")
      .map(async (r) => {
        const emds = await stage(ctx, r.adm_cd.slice(0, 5)).catch(() => null);
        const real = emds?.items.find((e) => e.cd === r.adm_cd);
        const parts = r.label.split(" ");
        const shown = parts.pop();
        if (real && shown !== real.name) {
          r.label = [...parts, real.name].join(" ");
          r.note = `${shown}은(는) 행정동 ${real.name}에 속해요`;
        }
      })
  );

  const list = [...results.values()].slice(0, 12);
  return {
    results: list,
    hint: list.length ? "" : sido && tokens.length === 1 ? "시·군·구까지 입력하거나 아래 목록에서 골라주세요." : "검색 결과가 없어요. '충남 천안시 안서동'처럼 시·도부터 적어보세요.",
  };
}

// ---------- 지역 데이터 ----------
const roundCoords = (c) => (typeof c[0] === "number" ? [Math.round(c[0]), Math.round(c[1])] : c.map(roundCoords));

async function region(ctx, admCd, year) {
  const isSgg = admCd.length === 5;
  const statParams = { year, adm_cd: admCd, low_search: "1" };
  await getToken(ctx); // 병렬 호출 전에 토큰을 먼저 받아둠

  const [boundary, grid, population, household, house] = await Promise.all([
    isSgg
      ? sgis(ctx, "boundary/hadmarea.geojson", { year, adm_cd: admCd, low_search: "1" }, { allowError: true })
      : sgis(ctx, "boundary/statsarea.geojson", { adm_cd: admCd }, { allowError: true }),
    sgis(ctx, "grid/data.geojson", { adm_cd: admCd, grid_level_div: isSgg ? "1km" : "500m" }, { allowError: true }),
    sgis(ctx, "stats/population.json", statParams, { allowError: true }),
    sgis(ctx, "stats/household.json", statParams, { allowError: true }),
    sgis(ctx, "stats/house.json", statParams, { allowError: true }),
  ]);

  if (!isOk(boundary) || !boundary.features?.length) {
    throw new HttpError(404, `경계 자료를 불러오지 못했어요: ${boundary?.errMsg || "자료 없음"}`);
  }

  // 시·군·구: 경계는 7자리, 통계는 8자리 코드 → 앞 7자리로 맞춤 / 읍·면·동: 집계구 14자리 그대로
  const key = (cd) => (isSgg ? String(cd).slice(0, 7) : String(cd));
  const areas = {
    type: "FeatureCollection",
    features: boundary.features.map((f) => {
      const p = f.properties;
      const code = key(p.adm_cd);
      return {
        type: "Feature",
        geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
        properties: {
          code,
          name: isSgg ? String(p.adm_nm).split(" ").pop() : `${p.adm_nm} ${String(p.adm_cd).slice(8)}`,
          x: Number(p.x),
          y: Number(p.y),
        },
      };
    }),
  };

  const notes = [];
  const stats = {};
  const put = (cd, obj) => Object.assign((stats[key(cd)] ||= {}), obj);
  if (isOk(population) && Array.isArray(population.result)) {
    population.result.forEach((r) =>
      put(r.adm_cd, { name: r.adm_nm, pop: num(r.tot_ppltn), density: num(r.ppltn_dnsty), age: num(r.avg_age), aged: num(r.aged_child_idx) })
    );
  } else notes.push(`인구 통계 없음(${population?.errMsg || "오류"})`);
  if (isOk(household) && Array.isArray(household.result)) {
    household.result.forEach((r) => put(r.adm_cd, { household: num(r.household_cnt), members: num(r.avg_family_member_cnt) }));
  } else notes.push(`가구 통계 없음(${household?.errMsg || "오류"})`);
  if (isOk(house) && Array.isArray(house.result)) {
    house.result.forEach((r) => put(r.adm_cd, { house: num(r.house_cnt) }));
  } else notes.push(`주택 통계 없음(${house?.errMsg || "오류"})`);

  const gridFeatures = isOk(grid) ? grid.features || [] : [];
  if (!isOk(grid)) notes.push(`격자 없음(${grid?.errMsg || "오류"})`);

  const p0 = boundary.features[0].properties;
  const name = isSgg ? String(p0.adm_nm).split(" ").slice(0, -1).join(" ") : `${p0.sido_nm} ${p0.sgg_nm} ${p0.adm_nm}`;

  return {
    adm_cd: admCd,
    year,
    level: isSgg ? "sgg" : "emd",
    name,
    unitName: isSgg ? "읍면동" : "집계구",
    gridLevel: isSgg ? "1km" : "500m",
    areas,
    grid: {
      type: "FeatureCollection",
      features: gridFeatures.map((f) => ({
        type: "Feature",
        geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
        properties: { id: f.properties.adm_cd },
      })),
    },
    stats,
    notes,
  };
}

// ---------- 요청 처리 ----------
async function runOp(query, ctx) {
  try {
    const op = String(query.op || "");
    if (op === "stage") {
      const cd = String(query.cd || "");
      if (!/^(\d{2}|\d{5})?$/.test(cd)) throw new HttpError(400, "잘못된 지역 코드예요.");
      return { status: 200, body: await stage(ctx, cd), cache: 7 * 86400 };
    }
    if (op === "search") {
      return { status: 200, body: await search(ctx, query.q || ""), cache: 86400 };
    }
    if (op === "region") {
      const admCd = String(query.adm_cd || "");
      const year = String(query.year || "2024");
      if (!/^(\d{5}|\d{8})$/.test(admCd)) throw new HttpError(400, "시·군·구(5자리) 또는 읍·면·동(8자리) 코드가 필요해요.");
      if (!YEARS.includes(year)) throw new HttpError(400, `연도는 ${YEARS[0]}~${YEARS.at(-1)} 중에서 골라주세요.`);
      return { status: 200, body: await region(ctx, admCd, year), cache: 7 * 86400 };
    }
    throw new HttpError(400, "지원하지 않는 요청이에요.");
  } catch (e) {
    return { status: e.status || 500, body: { error: e.message || "알 수 없는 오류가 발생했어요." }, cache: 0 };
  }
}

module.exports = async function handler(req, res) {
  const out = await runOp(req.query || {}, { fetch: globalThis.fetch, env: process.env, base: SGIS_BASE });
  res.setHeader("Cache-Control", out.cache ? `public, s-maxage=${out.cache}, stale-while-revalidate=86400` : "no-store");
  res.status(out.status).json(out.body);
};
module.exports.runOp = runOp;
