# youni 플랫폼 개발 기획서 (Product Spec)

> 관련 문서: [사업계획서](business-plan.md) · [상용화 로드맵](roadmap.md) · [배포 가이드](deploy.md) · [지자체 디렉토리](site-research.md)
>
> 이 문서는 "다음에 무엇을 개발할지"의 단일 기준이다. 모든 기능은 `SPEC-<도메인>-<번호>` ID로
> 관리하고, 로드맵의 Phase와 연결한다. 상태: ✅ 완료 / 🟡 부분 / ⬜ 미착수.
> 최종 갱신: 2026-08-02.

---

## 1. 현재 빌드 상태 기준선 (2026-07-26 실측)

코드를 직접 확인한 결과다. 문서가 아닌 코드가 진실이며, 어긋나면 이 표를 갱신한다.

| 컴포넌트 | 상태 | 근거 (파일) |
|---|---|---|
| 모노레포/CI (pnpm+Turbo) | ✅ | `turbo.json`, `.github/workflows` |
| DB 스키마+RLS 멀티테넌시 (17테이블) | 🟡 운영 갱신 대기 | 운영에는 0001 적용 완료. S05 dry-run 전용 필드·상태·증적을 추가하는 `0006`은 이 슬라이스 병합·배포 후 적용 |
| 게시대 시드 (화성 197곳) | ✅ | `supabase/seed_boards_hwaseong.sql` |
| 지자체 디렉토리 시드 (21곳 disabled) | ✅ | `supabase/seed_directory.sql` |
| 스케줄러 (마스터 틱: 창구 생성→상태 전이→D-3 잡 생성→오픈 큐잉→D-1 점검→결과 큐잉) | ✅ | `apps/worker/src/scheduler.ts` |
| 자동 제출 프로세서 (dry-run·감사증적·재시도 포함) | 🟡 코드 준비 완료 | S05 전용 완료 상태·5단계 증적·최종 요청 안전 차단 구현, Fly·실계정 리허설 대기 |
| 크롤 프로세서 (게시대/일정) | ✅ | `apps/worker/src/processors/crawl.ts` |
| 결과 수집 프로세서 | ✅ 코드 완성 | `apps/worker/src/processors/results.ts` — uriad 계열은 credential별 로그인 후 마이페이지 파싱(exact/1:1 fuzzy 매칭). 실측 검증은 8월 발표 때. → SPEC-RESULT-01 |
| 알림 프로세서 (이메일 Resend) | ✅ 코드 완성 | `apps/worker/src/processors/notify.ts` — RESEND_API_KEY 설정 시 발송, 미설정 시 스텁 폴백. 실수신 확인 남음. → SPEC-NOTIFY-01 |
| 캡차 수동 릴레이 (worker↔web) | ✅ | `apps/worker/src/captcha.ts`, `apps/web/app/(dashboard)/captcha/` |
| 화성 어댑터 (로그인→규약동의→게시대선택→시안첨부→제출, 실측 완료) | ✅ | `packages/adapters/src/hwaseong/`, `src/uriad/factory.ts` |
| 오산·시흥 어댑터 (uriad 팩토리, beta·autoSubmit=false) | 🟡 | `packages/adapters/src/{osan,siheung}/` — 실측 dry-run 미통과. → SPEC-ADAPT-02 |
| AI 시안 검증 (Claude vision structured output) | ✅ 코드 완성 | `packages/ai/src/designValidation.ts` — 실전 튜닝 전. → SPEC-AI-01 |
| AI 규격 파싱 | ✅ 코드 완성 | `packages/ai/src/specParsing.ts` |
| web 대시보드 (로그인·설정·프로필·계정등록·시안·자동신청·캡차) | ✅ 골격+동작 | 화성 beta 선택 시 실제 신청 대신 `1회 리허설 예약`과 최종 제출 없음 경고 제공. → SPEC-WEB-01 |
| 어댑터 계약/픽스처 테스트 | ✅ | `packages/adapters/src/contract.test.ts`, `hwaseong/adapter.test.ts` |
| **인프라: Supabase(운영)·Vercel web(운영)·Upstash Redis(생성)** | ✅ | youni-web.vercel.app 가동 |
| **인프라: Fly 워커** | 🟡 진행 중 | 앱 `youni-worker` 생성·시크릿 주입 단계, `fly deploy` 남음. → SPEC-INFRA-01 |
| 관리자 콘솔 / 결제 / 이메일·알림톡 / 랜딩·SEO | ⬜ | 미구현 — Phase 2~3 스펙 참조 |

---

## 2. 기능 스펙 (에픽별)

각 스펙: **목적 / 수용 기준(AC) / 상태 / 관련 파일 / Phase**.

### INFRA — 인프라·운영

**SPEC-INFRA-01 Fly 워커 실가동** — Phase 0 · 🟡
- 목적: 스케줄러·큐가 상시 구동되는 워커 배포.
- AC: `https://youni-worker.fly.dev/healthz` 200, `SUBMIT_DRY_RUN_DEFAULT=true`, Vercel `WORKER_URL` 반영, 워커 로그에 마스터 틱 1분 주기 확인.
- 파일: `apps/worker/fly.toml`, `apps/worker/Dockerfile`, `docs/deploy.md` 4단계.

**SPEC-INFRA-02 관측성** — Phase 1 · ⬜
- 목적: 장애를 사용자보다 먼저 안다.
- AC: Sentry(무료) 연동, 잡 실패 시 운영자 알림, 주간 healthCheck 결과 확인 루틴.
- 파일: `apps/worker/src/logger.ts` 확장.

**SPEC-INFRA-03 창구 기간 신뢰성** — Phase 3 · ⬜
- AC: 워커 자동 재시작/이중화, 백업·복구 절차 문서화, 창구 기간(1~5일) 무중단.

### SUBMIT — 자동 제출

**SPEC-SUBMIT-01 화성 dry-run 리허설** — Phase 0 · 🟡 코드 준비 완료(병합 시), 실측 대기
- 목적: 실창구에서 로그인→게시대선택→시안첨부→제출 직전 중단까지 검증.
- 구현: 대시보드 1회 리허설, beta live 차단, 열린 창구 dry-run catch-up, OR 방식 dry-run
  모드 합성, `reserved_save.jsp` 요청 차단, `dry_run_completed` 상태와 5단계 구조화 증적.
- 남은 AC: Fly 워커 실가동 후 본인 hsdr 계정으로 실행해 audit 증적을 검수하고, 실제 사이트
  마이페이지에 신청이 생기지 않았음을 확인한다. 통과 전 S06 실제 제출은 차단한다.
- 파일: `apps/worker/src/processors/submit.ts`, `packages/adapters/src/uriad/factory.ts`,
  `apps/web/app/(dashboard)/requests/`.

**SPEC-SUBMIT-02 실제 제출 1건 (본인 계정)** — Phase 1 · ⬜
- AC: `dry_run=false` 본인 신청 1건 → 접수번호 확인 → 감사 증적 검수. 이 통과 없이 타인 계정 제출 금지.

**SPEC-SUBMIT-03 실패·재시도 매트릭스 실전 검증** — Phase 1 · ⬜
- AC: 네트워크/로그인 실패/기간 아님 각 케이스가 설계된 재시도·알림 경로로 동작(로그 근거).

### ADAPT — 지자체 어댑터

**SPEC-ADAPT-01 화성 (레퍼런스)** — Phase 0 · 🟡 흐름 실측·안전 코드 완료, 실계정 dry-run만 남음(=SPEC-SUBMIT-01).

**SPEC-ADAPT-02 오산 어댑터 활성화** — Phase 2 · 🟡
- AC: [확장 런북](#3-어댑터-확장-런북) 5단계 통과 → `autoSubmit=true`, status `active`. sub03 추첨 경로 상이 가능성 실측.
- 파일: `packages/adapters/src/osan/`, `docs/site-research.md`.

**SPEC-ADAPT-03 경기남부 5~7곳 확장** — Phase 3 · ⬜
- 대상 우선순위: 시흥(구조 확인됨) → 안양·군포·의왕 → 안산(경로 상이)·용인·평택(접속 이슈 재확인). uriad 템플릿 위주로 "1주 1지자체" 프로세스 확립.
- AC: 지자체별 런북 체크리스트 통과 기록이 site-research.md에 남을 것.

**SPEC-ADAPT-04 비(非)uriad 템플릿 1호** — Phase 4 · ⬜
- newkoaa(PHP: 부천·하남·광주) 또는 수원 직영. uriad 의존을 벗어나는 두 번째 어댑터 베이스.

### RESULT — 결과 수집·피드백

**SPEC-RESULT-01 uriad 인증 결과 수집** — Phase 1 · 🟡 코드 완성 (실측 검증 전)
- 목적: uriad 계열은 결과가 개인 마이페이지에 있으므로, 창구별 submitted 잡을 credential별로 묶어 로그인 후 `top_mypage.jsp` 파싱.
- 구현: `AdapterMeta.resultsRequireLogin` 분기, 접수번호 exact + 잡1·행1 fuzzy 매칭(fuzzy는 `reviewed=false` 관리자 확인 큐), 사용자별 실패 격리, `login_failed`시 credential 무효 마킹.
- 남은 AC: 화성 8월 추첨 발표 후 본인 계정의 선정/탈락이 `results`에 저장·매칭되는지 실측.
- 파일: `apps/worker/src/processors/results.ts`, `packages/adapters/src/uriad/parsers.ts`의 `parseMypageResults`.

**SPEC-RESULT-02 매칭·확인 큐** — Phase 3 · ⬜
- AC: 접수번호 exact 자동 매칭, fuzzy는 관리자 확인 큐 경유, 미매칭 행 보관(경쟁률 데이터 원료).

### NOTIFY — 알림

**SPEC-NOTIFY-01 이메일 실연동 (Resend)** — Phase 1 · 🟡 코드 완성 (실수신 확인 전)
- 목적: 창구 오픈 예정/제출 성공·실패/캡차 요청/결과를 이메일로.
- 구현: Resend REST 발송, 수신자 해석(user_id 지정 또는 테넌트 멤버 전체), 유형별 한글 템플릿 8종, 5xx/429·네트워크 오류는 pending 유지 재시도·4xx는 failed. `RESEND_API_KEY` 미설정이면 스텁 폴백(부팅 안 막음).
- 남은 AC: resend.com 가입 → API 키 발급 → Fly 시크릿 `RESEND_API_KEY` 주입 → 본인 메일 수신 확인. (자체 도메인 발신은 Phase 2에 도메인 인증 후)
- 파일: `apps/worker/src/processors/notify.ts`, `apps/worker/src/env.ts`.

**SPEC-NOTIFY-02 카카오 알림톡** — Phase 3 · ⬜
- 솔라피 연동. 템플릿 사전 승인 2~4주 → Phase 2 말에 신청 시작.

### AI — 시안 검증

**SPEC-AI-01 실전 튜닝** — Phase 1 · 🟡 (코드 완성, 실측 전)
- AC: 화성 실규격(PDF 확보분) 기준 실제 시안 3건+ 검증, 반려 사례로 프롬프트/규칙 보정, 동일 design×spec_version 캐시 동작 확인.
- 파일: `packages/ai/src/designValidation.ts`, `municipality_specs` 시드.

### WEB — 대시보드·온보딩

**SPEC-WEB-01 온보딩 플로우 다듬기** — Phase 2 · 🟡 1차 완료
- 구현: 대시보드 상단 온보딩 체크리스트(5단계 진행표시, 다음 단계 유도, 완료 시 자동 숨김), 자동신청 페이지 선행조건 안내(프로필/계정/시안 미비 시 폼 대신 준비 안내), 시안 페이지 빈 상태·워크스페이스 가드, "당첨 보장 아님" 문구. 화성 `beta` 선택 시에는 실제 자동 신청 버튼을 숨기고 `1회 리허설 예약`과 최종 제출 없음 경고를 표시한다.
- 남은 AC: 베타 사용자 1명이 안내 없이 완주하는 실관찰 후 마찰 보정.
- 파일: `apps/web/lib/onboarding.ts`, `app/(dashboard)/checklist.tsx`, `dashboard/`, `designs/`, `requests/`.

**SPEC-WEB-02 제출 타임라인(감사 증적 열람)** — Phase 2 · ✅ 구현 완료
- 구현: `/jobs/[id]` — 잡 요약(접수번호·게시기간·창구·오류) + 시도별 단계 스크린샷 갤러리(서명 URL 1시간, RLS 테넌트 경로 제한). S05의 리허설 완료 상태·시각과 구조화 증적을 우선 표시하고 기존 스크린샷 경로 배열을 폴백으로 사용한다.
- 파일: `apps/web/app/(dashboard)/jobs/[id]/page.tsx`. 실제 S05 dry-run 증적 검수를 이 화면으로 진행.

**SPEC-WEB-03 관리자 콘솔** — Phase 3 · ⬜
- AC: broken 어댑터 현황, 결과 매칭 확인 큐, 지자체별 성공률.

**SPEC-WEB-04 랜딩·SEO** — Phase 3 · ⬜
- AC: "○○시 현수막 게시대 신청" 검색 유입용 지자체별 공개 페이지(일정·수수료·규격 무료 공개→가입 유도).

### MAP — 게시대 위치 지도

**SPEC-MAP-01 크롤 upsert lat/lng 유실 수정** — Phase 1 · ✅
- uriad 파서가 추출한 좌표를 worker upsert가 버리던 버그. 좌표 없는 행은 기존 값 보존(컬럼 생략).
- 파일: `apps/worker/src/processors/crawl.ts`.

**SPEC-MAP-02 우선순위=선택순서 수정** — Phase 1 · ✅
- "선택 순서=우선순위" 안내와 달리 DOM 순서로 저장되던 버그 → `selectedIds` 상태 + ↑/↓ 재정렬. 저장 shape `[{boardSiteId, priority}]` 불변.
- 파일: `apps/web/app/(dashboard)/requests/ui.tsx`.

**SPEC-MAP-03/04 Kakao SDK 로더 + BoardMap 컴포넌트** — Phase 1 · ✅ (키 주입 대기)
- `NEXT_PUBLIC_KAKAO_MAP_APP_KEY`(turbo env 선언 포함), autoload=false 로더, 키 미설정/로드 실패 시 목록 폴백. 마커 클릭 선택, 우선순위 뱃지(CustomOverlay), 근접(소수4자리≈11m) 그룹 뱃지+하단 패널 개별 선택, bounds 자동 fit.
- 남은 AC: **사용자 액션 — developers.kakao.com JS 키 발급 + 도메인 등록(localhost:3000, youni-web.vercel.app) + Vercel env 주입.**
- 파일: `apps/web/lib/kakao-loader.ts`, `app/(dashboard)/requests/board-map.tsx`.

**SPEC-MAP-05 /requests 지도 picker 통합** — Phase 1 · ✅
- 지도+동기화 우선순위 목록(재정렬·삭제), 전체 목록 폴백(좌표 없는 게시대 포함), max_entries=1 안내 문구, 지자체 변경 시 선택 초기화.
- 파일: `app/(dashboard)/requests/{page,ui}.tsx`.

**SPEC-MAP-06 /boards 지역 게시대 지도 페이지** — Phase 2 · ✅ 선행 구현
- 지자체 선택 → 읽기 전용 지도 + 읍/면/동 필터 + 표(주소·면수·규격·요금), 네비 "게시대 지도".
- 파일: `app/(dashboard)/boards/{page,ui}.tsx`.

**SPEC-MAP-07 마커 클러스터링** — 조건부 후순위 · ⬜
- 게시대 >500 시 Kakao MarkerClusterer 도입(현재 197개는 무보정 렌더로 충분 — 결정만 기록).

### BIZ — 과금·사업 기반

**SPEC-BIZ-01 약관·개인정보·계정위임 동의** — Phase 2 · ⬜
- AC: 이용약관·개인정보처리방침 초안 + **사이트 계정 위임(암호화 저장·본인 계정 대리 입력) 동의 조항**, 가입 시 동의 수집.

**SPEC-BIZ-02 수동 과금** — Phase 2 · ⬜
- AC: 계좌이체 기반 월 이용료 청구(결제 개발보다 가격 검증 우선).

**SPEC-BIZ-03 토스페이먼츠 정기결제** — Phase 3 · ⬜
- AC: 빌링 연동 + 통신판매업 신고.

---

## 3. 어댑터 확장 런북 (uriad 템플릿)

신규 지자체 추가는 이 체크리스트를 통과해야 `active`가 된다. (상세: [site-research.md](site-research.md))

1. **구조 확인**: `sub02.jsp`(게시대현황)·`sub03.jsp`(신청) 존재와 `r_STARTDAY` hidden 확인 — healthCheck와 동일 검사
2. **어댑터 등록**: `createUriadAdapter({key, nameKo, baseUrl, ...})` + `registry.ts` 추가 (**autoSubmit=false로 시작**)
3. **시드**: `seed_directory.sql` status → `beta`, `sub02` 크롤로 게시대 시드 생성
4. **규격/일정**: 공고문 확보 → `municipality_specs` 입력 (AI 규격 파싱 활용 가능)
5. **실측 리허설**: 실계정 dry-run(제출 직전까지) 통과 → `autoSubmit=true`, status `active`

비고: 남양주처럼 **다중 수탁**(권역별 3곳)은 게시대→수탁처 매핑이 선행돼야 한다.

## 4. 데이터·계약 참조 (코드 포인터)

- 도메인 타입·잡 페이로드·상태 머신: `packages/core/src/` (`submission_jobs` 상태: pending→queued→running→awaiting_captcha→submitted/failed/needs_manual)
- 어댑터 인터페이스: `packages/adapters/src/types.ts` (`MunicipalityAdapter`)
- 스케줄 원천: DB `application_windows` ← `municipality_specs.window_rule` (worker 마스터 틱이 인스턴스 생성)
- web↔worker: web은 DB intent + `POST /enqueue`(`WORKER_SHARED_SECRET`), 역방향은 DB 업데이트(`apps/worker/src/server.ts`)
- 자격증명: AES-256-GCM 앱 레이어 암호화(`CREDENTIALS_ENC_KEY`), 복호화는 worker 제출 직전만
- 감사 증적: `audit/{tenant}/{job}/{attempt}/` 스크린샷 (`apps/worker/src/audit.ts`)

## 5. 우선순위 백로그 (지금 → 다음)

로드맵 Phase와 정합하는 실행 순서. 위에서부터 순서대로 진행한다.

| # | 작업 | 스펙 | Phase | 비고 |
|---|---|---|---|---|
| 1 | Fly 워커 배포 마무리 | SPEC-INFRA-01 | 0 | 시크릿 주입 후 `fly deploy` — 진행 중 |
| 2 | 화성 실계정 dry-run 리허설 | SPEC-SUBMIT-01 | 0 | 🟡 코드 준비 완료(병합 시) — Fly 배포·본인 계정 실행·마이페이지 미신청 확인 대기 |
| 3 | 이메일 알림 실연동 | SPEC-NOTIFY-01 | 1 | ✅ 코드 완료 — RESEND_API_KEY 주입+실수신 확인만 남음 |
| 4 | uriad 인증 결과 수집 | SPEC-RESULT-01 | 1 | ✅ 코드 완료 — 8월 발표 때 실측 검증 |
| 5 | 실제 제출 1건(본인) | SPEC-SUBMIT-02 | 1 | dry-run 검수 후 9월 창구 |
| 6 | 시안 검증 실전 튜닝 | SPEC-AI-01 | 1 | 실제 시안으로 |
| 7 | 게시대 위치 지도 | SPEC-MAP-01~06 | 1~2 | ✅ 코드 완료 — 카카오 JS 키 발급·도메인 등록만 남음 |
| 7.5 | Sentry·운영 루틴 | SPEC-INFRA-02 | 1 | |
| 8 | 온보딩 다듬기 + 제출 타임라인 | SPEC-WEB-01/02 | 2 | WEB-02 ✅ 완료(dry-run 검수 화면 선행 구축) — WEB-01 남음 |
| 9 | 약관·계정위임 동의 + 수동 과금 | SPEC-BIZ-01/02 | 2 | 첫 유료 전환 |
| 10 | 오산 어댑터 활성화 | SPEC-ADAPT-02 | 2 | "지자체 추가 1주" 프로세스 검증 |

이후(Phase 3~): SPEC-ADAPT-03(5~7곳) → SPEC-NOTIFY-02(알림톡) → SPEC-BIZ-03(정기결제) → SPEC-WEB-03/04(콘솔·랜딩) → SPEC-INFRA-03(신뢰성) — 상세는 [roadmap.md](roadmap.md).
