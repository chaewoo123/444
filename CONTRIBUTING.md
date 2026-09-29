# 팀 작업 규칙 — 역할 · 브랜치

지역을 고르면 그 지역의 **용적률·건폐율**과 **CBD·부도심**을 함께 보고, 그 지역에 대해 글을 남길 수 있는 **게시판**을 만든다.

## 1. 역할 (4명)

| 역할 | 담당 | 맡는 파일·폴더 | 브랜치 앞머리 |
|---|---|---|---|
| **Backend** (API · DB) | 채우 | `api/` · `supabase/` · `data/` | `backend/` |
| **Frontend** (게시판) | 제준 | `board.html` · `js/board/` | `frontend/` |
| **GIS** (지도 · 분석) | 재훈 | `index.html` · `density-dashboard.html` · `js/map/` | `gis/` |
| **Design** (UI · 통합) | 세진 (팀장) | `css/` · `assets/` · `README.md` | `design/` |

- 팀장(세진)은 PR 확인과 `develop` → `main` 배포도 맡는다.
- **맡은 파일만 고친다.** 남의 파일을 고쳐야 하면 그 담당자에게 먼저 말하고, PR에 담당자를 리뷰어로 넣는다.
- `index.html`, `density-dashboard.html`은 한 파일이 커서 두 명이 동시에 고치면 충돌이 난다. GIS 담당만 고친다.

## 2. 기능 브랜치

| 역할 | 브랜치 | 할 일 | 이슈 |
|---|---|---|---|
| Backend (채우) | `backend/board-schema` | 게시글·댓글 표와 RLS 정책 (`supabase/03_board.sql`) | #2 |
| | `backend/ordinance-api` | 지역별 조례 용적률·건폐율 조회 API (`api/ordinance.js`) — 지금은 천안 CSV만 있음 | #3 |
| | `backend/region-api` | 지역 검색·경계·통계 API 보강 (`api/sgis.js`) | #4 |
| Frontend (제준) | `frontend/board-list` | 글 목록 · 검색 · 지역 필터 · 페이지 넘김 | #5 |
| | `frontend/board-post` | 글쓰기 · 글 보기 · 수정 · 삭제 | #6 |
| | `frontend/board-comment` | 댓글 | #7 |
| | `frontend/region-card` | 글에 붙인 지역의 용적률 · CBD 요약 카드 | #8 |
| GIS (재훈) | `gis/far-lookup` | 지역을 고르면 용도지역별 용적률·건폐율 표시 | #9 |
| | `gis/cbd-detect` | 인구·사업체 밀도로 CBD·부도심 추정해 지도에 표시 | #10 |
| | `gis/board-link` | 지도에서 고른 지역으로 게시판 열기 / 글에서 지도 열기 | #11 |
| Design (세진) | `design/tokens` | 색 · 글꼴 · 간격 공통 CSS (`css/tokens.css`) | #12 |
| | `design/layout` | 공통 헤더 · 메뉴 · 모바일 화면 | #13 |
| | `design/components` | 버튼 · 카드 · 표 · 입력칸 공통 스타일 | #14 |

새 기능이 생기면 `역할/기능-이름` 형식으로 브랜치를 더 만든다 (예: `frontend/board-like`). 영어 소문자와 `-`만 쓴다.

할 일은 [Issues](../../issues)에 기능마다 하나씩 있다. 커밋 메시지에 이슈 번호를 적고(예: `게시글 목록 화면 추가 #5`), PR 본문에 `Closes #5`라고 적으면 합쳐질 때 이슈가 닫힌다.

## 3. 브랜치 구조

```
main        ← 배포본. 직접 push 금지, develop 에서만 합침
└─ develop  ← 통합본. 기능 브랜치는 여기로 PR
   ├─ backend/…
   ├─ frontend/…
   ├─ gis/…
   └─ design/…
```

- 기능 브랜치는 **항상 `develop`에서** 만들고 **`develop`으로** PR을 올린다.
- `develop`이 안정되면 팀장이 `develop` → `main` PR로 배포한다.
- `week3`은 과제 제출본이라 건드리지 않는다.

## 4. 작업 순서

```bash
# 처음 한 번
git clone https://github.com/chaewoo123/444.git
cd 444

# 작업 시작 — 내 기능 브랜치로 이동
git fetch origin
git switch frontend/board-list          # 이미 있는 브랜치
# git switch -c gis/new-thing origin/develop   # 새 브랜치를 만들 때

# 작업 전 develop 최신 내용 받기
git pull origin develop

# 저장
git add 고친파일
git commit -m "게시글 목록에 지역 필터 추가"
git push origin frontend/board-list
```

그다음 GitHub에서 **Pull request → base: `develop`** 으로 올리고, 한 명 이상 확인받은 뒤 합친다.

## 5. 새 파일을 만들 때

`.gitignore`가 **적힌 파일·폴더만 올라가게** 되어 있다. 새 파일이나 폴더가 `git status`에 안 보이면 `.gitignore`에 `!/파일이름`을 한 줄 추가한다.

## 6. 비밀 값

SGIS 키, Supabase 비밀 키(`sb_secret_…`)는 코드와 GitHub에 절대 넣지 않는다. 서버 키는 Vercel 환경변수에만 넣는다. 브라우저 코드에는 Supabase 공개 키(publishable)만 쓴다.
