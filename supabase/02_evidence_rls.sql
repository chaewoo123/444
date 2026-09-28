-- 03 권한 — 행 단위 보안(RLS)
-- 01 을 실행한 뒤 SQL Editor 에서 Run
--
-- 규칙: 누구나(공개 키) 읽기·추가 가능, 수정·삭제는 불가
--       → 수정·삭제 정책을 만들지 않았으므로 RLS 가 자동으로 막음
-- 비밀 키(sb_secret_…)는 RLS 를 무시하므로 브라우저 코드·GitHub 에 절대 넣지 않음

alter table public.evidence enable row level security;

-- Data API 가 공개 키 역할(anon)·로그인 역할(authenticated)로 이 표에 닿을 수 있게 허용
grant select, insert on public.evidence to anon, authenticated;

drop policy if exists "evidence_select_all" on public.evidence;
create policy "evidence_select_all"
  on public.evidence for select
  to anon, authenticated
  using (true);

drop policy if exists "evidence_insert_all" on public.evidence;
create policy "evidence_insert_all"
  on public.evidence for insert
  to anon, authenticated
  with check (
    retrieved_on <= current_date          -- 미래 조회일 금지
    and length(source) between 5 and 300  -- 출처 없는 값 금지
    and length(label) <= 100
    and length(unit)  <= 30
  );

-- 확인: 정책 목록
select policyname, cmd, roles from pg_policies where tablename = 'evidence';
