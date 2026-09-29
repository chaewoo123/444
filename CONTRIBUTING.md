# 팀 작업 규칙 — 역할 · 브랜치

지역을 고르면 그 지역의 **용적률·건폐율**과 **CBD·부도심**을 함께 보고, 그 지역에 대해 글을 남길 수 있는 **게시판**을 만든다.

## 1. 역할과 브랜치 (4명 · 사람당 브랜치 1개)

| 담당 | 역할 | 맡는 파일·폴더 | 브랜치 |
|---|---|---|---|
| 채우 | **Backend** (API · DB) | `api/` · `supabase/` · `data/` | `chaewoo` |
| 제준 | **Frontend** (게시판) | `board.html` · `js/board/` | `jejun` |
| 재훈 | **GIS** (지도 · 분석) | `index.html` · `density-dashboard.html` · `js/map/` | `jaehoon` |
| 세진 (팀장) | **Design** (UI · 통합) | `css/` · `assets/` · `README.md` | `sejin` |

- 각자 **자기 이름 브랜치 하나에서만** 작업한다.
- 팀장(세진)은 PR 확인과 `develop` → `main` 배포도 맡는다.
- **맡은 파일만 고친다.** 남의 파일을 고쳐야 하면 그 담당자에게 먼저 말하고, PR에 담당자를 리뷰어로 넣는다.
- `index.html`, `density-dashboard.html`은 한 파일이 커서 두 명이 동시에 고치면 충돌이 난다. GIS 담당만 고친다.

## 2. 할 일 (GitHub Issues)

기능 하나 = 이슈 하나. [Issues](../../issues) 탭에서 담당자 라벨로 걸러 보면 자기 할 일만 보인다.

| 담당 | 이슈 |
|---|---|
| 채우 | #2 게시글·댓글 표와 RLS 정책 · #3 조례 용적률·건폐율 조회 API · #4 지역 검색·경계·통계 API 보강 |
| 제준 | #5 글 목록·검색·필터 · #6 글쓰기·보기·수정·삭제 · #7 댓글 · #8 지역 요약 카드 |
| 재훈 | #9 용적률·건폐율 지도 표시 · #10 CBD·부도심 추정 · #11 지도 ↔ 게시판 연결 |
| 세진 | #12 디자인 토큰 · #13 공통 헤더·메뉴·모바일 · #14 공통 컴포넌트 스타일 |

- 새 할 일이 생기면 이슈를 만들고 자기 이름 라벨을 붙인다.
- 커밋 메시지에 이슈 번호를 적으면 이슈에 기록이 남는다 (예: `게시글 목록 화면 추가 #5`).
- PR 본문에 `Closes #5`라고 적으면 합쳐질 때 이슈가 자동으로 닫힌다.

## 3. 브랜치 구조

```
main        ← 배포본. 직접 push 금지, develop 에서만 합침
└─ develop  ← 통합본. 각자 브랜치는 여기로 PR
   ├─ chaewoo   (채우 · Backend)
   ├─ jejun     (제준 · Frontend)
   ├─ jaehoon   (재훈 · GIS)
   └─ sejin     (세진 · Design)
```

- 기능 하나가 끝날 때마다 자기 브랜치 → **`develop`** 으로 PR을 올린다.
- PR이 합쳐진 뒤에도 같은 브랜치를 계속 쓴다. 다음 작업 전에 `develop`을 받아 온다.
- `develop`이 안정되면 팀장이 `develop` → `main` PR로 배포한다.
- `week3`은 과제 제출본이라 건드리지 않는다.

## 4. 작업 순서

```bash
# 처음 한 번
git clone https://github.com/chaewoo123/444.git
cd 444
git switch jejun                 # 자기 이름 브랜치

# 작업 시작할 때마다 — develop 최신 내용 받기
git pull origin develop

# 저장
git add 고친파일
git commit -m "게시글 목록 화면 추가 #5"
git push origin jejun
```

그다음 GitHub에서 **Pull request → base: `develop` ← compare: 내 브랜치** 로 올리고, 한 명 이상 확인받은 뒤 합친다.

## 5. 새 파일을 만들 때

`.gitignore`가 **적힌 파일·폴더만 올라가게** 되어 있다. 새 파일이나 폴더가 `git status`에 안 보이면 `.gitignore`에 `!/파일이름`을 한 줄 추가한다.

## 6. 비밀 값

SGIS 키, Supabase 비밀 키(`sb_secret_…`)는 코드와 GitHub에 절대 넣지 않는다. 서버 키는 Vercel 환경변수에만 넣는다. 브라우저 코드에는 Supabase 공개 키(publishable)만 쓴다.
