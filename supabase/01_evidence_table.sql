-- 01 표 — evidence (3주차 데이터 카드의 네 칸을 그대로 열로 옮김)
-- Supabase 대시보드 > SQL Editor 에 붙여 넣고 Run
--
--   카드 칸     열 이름        자료형
--   (항목)      label          text     무엇의 값인지 (예: 용적률 · 준주거지역)
--   값          value          numeric  숫자만 (400)
--   단위        unit           text     퍼센트 이하
--   출처        source         text     조례 조문·시행일
--   조회일      retrieved_on   date     2026-09-21

create table if not exists public.evidence (
  id           bigint generated always as identity primary key,
  label        text        not null check (length(trim(label)) > 0),
  value        numeric     not null,
  unit         text        not null check (length(trim(unit)) > 0),
  source       text        not null check (length(trim(source)) > 0),
  retrieved_on date        not null,
  created_at   timestamptz not null default now()
);

comment on table  public.evidence is '대상지 데이터 카드 근거값 (값·단위·출처·조회일)';
comment on column public.evidence.value is '값 — 숫자만. 단위는 unit 열에';
comment on column public.evidence.retrieved_on is '조회일 — 출처를 직접 확인한 날';

-- 첫 행: 3주차 카드 (Table Editor 에서 직접 입력했다면 이 문장은 건너뜀)
insert into public.evidence (label, value, unit, source, retrieved_on)
values (
  '용적률 · 준주거지역',
  400,
  '퍼센트 이하',
  '「화성시 도시계획 조례」 제57조제1항제6호 · 시행 2026-03-10',
  '2026-09-21'
);

select * from public.evidence;
