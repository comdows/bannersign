# youni 플랫폼 개발 기획서 (Product Spec)

> 관련 문서: [사업계획서](business-plan.md) · [상용화 로드맵](roadmap.md) · [배포 가이드](deploy.md) · [DB 마이그레이션 현황](migration-status.md) · [지자체 디렉토리](site-research.md)
>
> 이 문서는 "다음에 무엇을 개발할지"의 단일 기준이다. 모든 기능은 `SPEC-<도메인>-<번호>` ID로
> 관리하고, 로드맵의 Phase와 연결한다. 상태: ✅ 완료 / 🟡 부분 / ⬜ 미착수.
> 최종 갱신: 2026-08-05.

---

## 1. 현재 빌드 상태 기준선

2026-08-05에 기본 브랜치 코드, 병합 PR, 공개 배포 상태를 다시 대조한 결과다. 문서가 아닌
코드와 검증 기록이 진실이며, 어긋나면 이 표를 갱신한다.

| 컴포넌트 | 상태 | 근거 (파일) |
|---|---|---|
| 모노레포/CI (pnpm+Turbo) | ✅ | 현재 기본 브랜치에서 PR은 `verify`·`sql-regression`, 수동 `workflow_dispatch`는 `verify`만 실행하고 PR별 이전 실행을 취소. PR #6에서 중복 post-merge push 실행 제거; 별도 `main`은 동기화 전 기존 workflow 유지 |
| DB 스키마+RLS 멀티테넌시 (18테이블) | 🟡 운영 적용 보고·부분 검증 | `0001`~`0006` 순차 적용 보고, 2026-08-03 `0006` 핵심 컬럼 3개 확인. 제약·함수·9인자 RPC·권한 검증은 `docs/migration-status.md` 참조 |
| 게시대 시드 (화성 197곳) | ✅ | `supabase/seed_boards_hwaseong.sql` |
| 지자체 디렉토리 시드 (21곳 disabled) | ✅ | `supabase/seed_directory.sql` |
| 스케줄러 (마스터 틱: 창구 생성→상태 전이→D-3 잡 생성→오픈 큐잉→D-1 점검→결과 큐잉) | 🟡 1차 코드 완료 | 창구 시각 변경 시 기존 queued/BullMQ 잡 재예약 보완 대기. `apps/worker/src/scheduler.ts` |
| 자동 제출 프로세서 (dry-run·감사증적·재시도 포함) | 🟡 코드 준비 완료 | S05 전용 완료 상태·5단계 증적·최종 요청 안전 차단 구현. 성공 precheck 강제·원자적 claim·성공 판정·제출 후 상태 보존 P1과 Fly·실계정 리허설 대기 |
| 크롤 프로세서 (게시대/일정) | 🟡 1차 코드 완료 | 좌표 유효성 방어와 실사이트 일정 crawl 검증 대기. `apps/worker/src/processors/crawl.ts` |
| 결과 수집 프로세서 | 🟡 1차 코드 완료 | credential별 로그인·마이페이지 파싱·exact/fuzzy 매칭 구현. 부정 결과 판정·기간 필터·전체 credential 종료 조건·fuzzy 알림 게이트 보완과 실측 대기. → SPEC-RESULT-01 |
| 알림 프로세서 (이메일 Resend) | 🟡 1차 코드 완료 | RESEND_API_KEY 설정 시 발송, 미설정 시 스텁 폴백. 실수신·dry-run 템플릿·전달 메타데이터 보완 대기. → SPEC-NOTIFY-01 |
| 캡차 수동 릴레이 (worker↔web) | ✅ | `apps/worker/src/captcha.ts`, `apps/web/app/(dashboard)/captcha/` |
| 화성 어댑터 (로그인→규약동의→게시대선택→시안첨부→제출 직전) | 🟡 코드 준비 완료 | 신청 흐름 셀렉터 실측·최종 요청 안전 차단 구현, 본인 실계정 dry-run 대기. `packages/adapters/src/hwaseong/`, `src/uriad/factory.ts` |
| 오산·시흥 어댑터 (uriad 팩토리, beta·autoSubmit=false) | 🟡 | `packages/adapters/src/{osan,siheung}/` — 실측 dry-run 미통과. → SPEC-ADAPT-02 |
| AI 시안 검증 (Claude vision structured output) | ✅ 코드 완성 | `packages/ai/src/designValidation.ts` — 실전 튜닝 전. → SPEC-AI-01 |
| AI 규격 파싱 | ✅ 코드 완성 | `packages/ai/src/specParsing.ts` |
| web 대시보드 (로그인·설정·프로필·계정등록·시안·자동신청·캡차) | ✅ 골격+동작 | 화성 beta 선택 시 실제 신청 대신 `1회 리허설 예약`과 최종 제출 없음 경고 제공. → SPEC-WEB-01 |
| 어댑터 계약/픽스처 테스트 | ✅ | `packages/adapters/src/contract.test.ts`, `hwaseong/adapter.test.ts` |
| **인프라: Supabase·Vercel web·Upstash Redis** | 🟡 부분 검증 | 공개 web HTTP 200, DB 적용 보고, Redis 생성 기존 운영 기록. 2026-08-05 기록상 최신 Production은 `b393e06`, S05 기능 기준선 `65dc642`는 Preview만 성공; 운영 env·Redis 연결 미확인 |
| **인프라: Fly 워커** | 🟡 외부 차단 | 앱 `pending`, release·IP 없음. 2026-08-05 Fly 무료 체험 종료로 VM 조회·배포 차단. → SPEC-INFRA-01 |
| 관리자 콘솔 / 결제 / 알림톡 / 랜딩·SEO | ⬜ | 미구현 — Phase 2~3 스펙 참조 |

---

## 2. 기능 스펙 (에픽별)

각 스펙: **목적 / 수용 기준(AC) / 상태 / 관련 파일 / Phase**.

### INFRA — 인프라·운영

**SPEC-INFRA-01 Fly 워커 실가동** — Phase 0 · 🟡
- 목적: 스케줄러·큐가 상시 구동되는 워커 배포.
- AC: S05 기능 기준선의 Vercel Production 배포와 필수 web 환경변수를 먼저 확인한다.
  worker는 `https://youni-worker.fly.dev/healthz` 200(HTTP 프로세스 생존),
  `SUBMIT_DRY_RUN_DEFAULT=true`를 확인한다. 이어 안전한 S05 dry-run 요청을 하나 예약해 시작 로그와
  해당 요청의 다음 scheduler tick DB/queue side effect를 확인한다. 현재 web은
  DB polling 경로이므로 worker 연결 env는 필수가 아니다. 성공 tick heartbeat 로그도 없으므로
  `/healthz`만으로 Supabase·Redis·scheduler 정상 여부를 판정하지 않는다.
- 현재 차단: 2026-08-05 앱은 release·IP 없이 `pending`이고 Fly 무료 체험 종료로 VM 조회·배포가
  막혀 있다. `healthz` DNS도 생성되지 않았다. 결제수단 등록은 운영자 액션이며, 완료 후
  `fly deploy`부터 재개한다.
- 파일: `apps/worker/fly.toml`, `apps/worker/Dockerfile`, `docs/deploy.md` 4단계.

**SPEC-INFRA-02 관측성** — Phase 1 · ⬜
- 목적: 장애를 사용자보다 먼저 안다.
- AC: Sentry(무료) 연동, 잡 실패 시 운영자 알림, 주간 healthCheck 결과 확인 루틴.
- 파일: `apps/worker/src/logger.ts` 확장.

**SPEC-INFRA-03 창구 기간 신뢰성** — Phase 3 · ⬜
- AC: 워커 자동 재시작/이중화, 백업·복구 절차 문서화, 창구 기간(1~5일) 무중단.

### SUBMIT — 자동 제출

**SPEC-SUBMIT-01 화성 dry-run 리허설** — Phase 0 · 🟡 코드 준비 완료, 실측 대기
- 목적: 실창구에서 로그인→게시대선택→시안첨부→제출 직전 중단까지 검증.
- 구현: 대시보드 1회 리허설, beta live 차단, 열린 창구 dry-run catch-up, OR 방식 dry-run
  모드 합성, `reserved_save.jsp` 요청 차단, `dry_run_completed` 상태와 5단계 구조화 증적.
- 비차단 S07 후속: `dry_run_completed` 전용 이메일 템플릿이 없어 현재 기본 템플릿으로 폴백한다.
  외부 제출 성공 뒤 상태 보존 문제는 live 경로를 여는 S06에서 해결한다.
- 남은 AC: Fly 워커 실가동 후 본인 hsdr 계정으로 실행해 audit 증적을 검수하고, 실제 사이트
  마이페이지에 신청이 생기지 않았음을 확인한다. 통과 전 S06 실제 제출은 차단한다.
- 파일: `apps/worker/src/processors/submit.ts`, `packages/adapters/src/uriad/factory.ts`,
  `apps/web/app/(dashboard)/requests/`.

**SPEC-SUBMIT-02 실제 제출 1건 (본인 계정)** — Phase 1 · ⬜
- 선행 코드 게이트(S06): 성공 precheck 강제, queued 잡 원자적 claim, 성공/오류 신호 판정,
  허용 상태 CAS, 외부 제출 뒤 attempt 저장 실패에도 `submitted` 상태 보존을 구현·테스트한다.
- AC: S05와 위 코드 게이트를 통과한 뒤 `dry_run=false` 본인 신청 1건 → 접수번호 확인 → 감사 증적 검수.
  이 통과 없이 타인 계정 제출 금지.

**SPEC-SUBMIT-03 실패·재시도 매트릭스 실전 검증** — Phase 1 · ⬜
- AC: 네트워크/로그인 실패/기간 아님 각 케이스가 설계된 재시도·알림 경로로 동작(로그 근거).

### ADAPT — 지자체 어댑터

**SPEC-ADAPT-01 화성 (레퍼런스)** — Phase 0 · 🟡 흐름 실측·안전 코드 완료, 실계정 dry-run만 남음(=SPEC-SUBMIT-01).

**SPEC-ADAPT-02 오산 어댑터 활성화** — Phase 2 · 🟡
- AC: [확장 런북](#3-어댑터-확장-런북-uriad-템플릿) 5단계 통과 → `autoSubmit=true`, status `active`. sub03 추첨 경로 상이 가능성 실측.
- 파일: `packages/adapters/src/osan/`, `docs/site-research.md`.

**SPEC-ADAPT-03 경기남부 5~7곳 확장** — Phase 3 · ⬜
- 대상 우선순위: 시흥(구조 확인됨) → 안양·군포·의왕 → 안산(경로 상이)·용인·평택(접속 이슈 재확인). uriad 템플릿 위주로 "1주 1지자체" 프로세스 확립.
- AC: 지자체별 런북 체크리스트 통과 기록이 site-research.md에 남을 것.

**SPEC-ADAPT-04 비(非)uriad 템플릿 1호** — Phase 4 · ⬜
- newkoaa(PHP: 부천·하남·광주) 또는 수원 직영. uriad 의존을 벗어나는 두 번째 어댑터 베이스.

### RESULT — 결과 수집·피드백

**SPEC-RESULT-01 uriad 인증 결과 수집** — Phase 1 · 🟡 1차 코드 완료 (정확성·실측 보완 전)
- 목적: uriad 계열은 결과가 개인 마이페이지에 있으므로, 창구별 submitted 잡을 credential별로 묶어 로그인 후 `top_mypage.jsp` 파싱.
- 구현: `AdapterMeta.resultsRequireLogin` 분기, 접수번호 exact + 잡1·행1 fuzzy 매칭(fuzzy는 `reviewed=false` 관리자 확인 큐), 사용자별 실패 격리, `login_failed`시 credential 무효 마킹.
- 남은 코드 게이트: 부정 결과를 긍정 부분문자열보다 먼저 판정하고 대상 창구 기간만 수집하며,
  모든 credential이 확정되기 전에는 창구를 닫지 않는다. fuzzy 결과는 운영자 검토 전 알림하지 않는다.
- 남은 AC: S06에서 실제 제출한 본인 신청의 발표 후 선정/탈락이 `results`에 저장·매칭되는지 실측.
- 파일: `apps/worker/src/processors/results.ts`, `packages/adapters/src/uriad/parsers.ts`의 `parseMypageResults`.

**SPEC-RESULT-02 매칭·확인 큐** — Phase 3 · ⬜
- AC: 접수번호 exact 자동 매칭, fuzzy는 관리자 확인 큐 경유, 미매칭 행 보관(경쟁률 데이터 원료).

### NOTIFY — 알림

**SPEC-NOTIFY-01 이메일 실연동 (Resend)** — Phase 1 · 🟡 1차 코드 완료 (실수신·내구성 보완 전)
- 목적: 창구 오픈 예정/제출 성공·실패/캡차 요청/결과를 이메일로.
- 구현: Resend REST 발송, 수신자 해석(user_id 지정 또는 테넌트 멤버 전체), 유형별 한글 템플릿 8종, 5xx/429·네트워크 오류는 pending 유지 재시도·4xx는 failed. `RESEND_API_KEY` 미설정이면 스텁 폴백(부팅 안 막음).
- 남은 코드 게이트: `dry_run_completed` 전용 템플릿과 `0007` provider ID·attempt·error·backoff/dead-letter.
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

**SPEC-MAP-01 크롤 upsert lat/lng 유실 수정** — Phase 1 · 🟡 1차 구현
- uriad 파서가 추출한 좌표를 worker upsert가 버리던 버그. 좌표 없는 행은 기존 값 보존(컬럼 생략).
- 남은 AC: 빈 문자열·비수치·범위 밖 좌표가 기존 정상 좌표를 `(0,0)` 또는 비정상 값으로 덮지 않도록 검증한다.
- 파일: `apps/worker/src/processors/crawl.ts`.

**SPEC-MAP-02 우선순위=선택순서 수정** — Phase 1 · ✅
- "선택 순서=우선순위" 안내와 달리 DOM 순서로 저장되던 버그 → `selectedIds` 상태 + ↑/↓ 재정렬. 저장 shape `[{boardSiteId, priority}]` 불변.
- 파일: `apps/web/app/(dashboard)/requests/ui.tsx`.

**SPEC-MAP-03/04 Kakao SDK 로더 + BoardMap 컴포넌트** — Phase 1 · 🟡 1차 구현 (키·근접 그룹 보완 대기)
- `NEXT_PUBLIC_KAKAO_MAP_APP_KEY`(turbo env 선언 포함), autoload=false 로더, 키 미설정/로드 실패 시 목록 폴백. 마커 클릭 선택, 우선순위 뱃지(CustomOverlay), 근접(소수4자리≈11m) 그룹 뱃지+하단 패널 개별 선택, bounds 자동 fit.
- 남은 AC: **사용자 액션 — developers.kakao.com JS 키 발급 + 도메인 등록(localhost:3000, youni-web.vercel.app) + Vercel env 주입.** 소수점 반올림 셀 대신 실제 거리로 근접 게시대를 묶는다.
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

- 도메인 타입·잡 페이로드·상태 머신: `packages/core/src/` (`submission_jobs` 상태: pending→queued→running→awaiting_captcha→submitted/dry_run_completed/failed/needs_manual/cancelled)
- 어댑터 인터페이스: `packages/adapters/src/types.ts` (`MunicipalityAdapter`)
- 스케줄 원천: DB `application_windows` ← `municipality_specs.window_rule` (worker 마스터 틱이 인스턴스 생성)
- web↔worker: 현재 web은 DB에 intent를 기록하고 worker scheduler가 DB를 polling한다. worker의
  `POST /enqueue`(`WORKER_SHARED_SECRET`) 엔드포인트는 구현돼 있지만 web runtime 호출은 아직 없다.
- 자격증명: AES-256-GCM 앱 레이어 암호화(`CREDENTIALS_ENC_KEY`), 복호화는 worker 제출 직전만
- 감사 증적: `audit/{tenant}/{job}/{attempt}/` 스크린샷 (`apps/worker/src/audit.ts`)

## 5. 우선순위 백로그 (지금 → 다음)

로드맵 Phase와 정합하는 실행 순서. 위에서부터 순서대로 진행한다.

| # | 작업 | 스펙 | Phase | 비고 |
|---|---|---|---|---|
| 1 | S05 기능 기준선 Vercel Production 배포·env 확인 | SPEC-INFRA-01 | 0 | 2026-08-05 기록은 `b393e06` Production, `65dc642` Preview까지 |
| 2 | Fly 워커 배포 마무리 | SPEC-INFRA-01 | 0 | Fly 결제수단 등록 → 시크릿 확인 → `fly deploy` — 무료 체험 종료로 차단 중 |
| 3 | 화성 실계정 dry-run 리허설 | SPEC-SUBMIT-01 | 0 | 🟡 코드 준비 완료(PR #7) — web/Fly 배포·본인 계정 실행·마이페이지 미신청 확인 대기 |
| 4 | S06 실제 제출 안전성 구현·테스트 | SPEC-SUBMIT-02 | 1 | precheck·원자적 claim·성공 판정·상태 CAS/보존을 고친 뒤에만 live 경로 승인 |
| 5 | 이메일 알림 실연동 | SPEC-NOTIFY-01 | 1 | 🟡 1차 코드 완료 — dry-run 템플릿·`0007` 내구성 보완, API 키·실수신 남음 |
| 6 | uriad 인증 결과 수집 | SPEC-RESULT-01 | 1 | 🟡 1차 코드 완료 — 정확성 보완 후 S06 실제 제출 건 발표 때 실측 |
| 7 | 실제 제출 1건(본인) | SPEC-SUBMIT-02 | 1 | S05·S06 코드 게이트 통과 후 다음 열린 창구 |
| 8 | 시안 검증 실전 튜닝 | SPEC-AI-01 | 1 | 실제 시안으로 |
| 9 | 게시대 위치 지도 | SPEC-MAP-01~06 | 1~2 | 🟡 1차 구현 — 좌표 유효성·실거리 그룹 보완, 카카오 JS 키·도메인 등록 남음 |
| 9.5 | Sentry·운영 루틴 | SPEC-INFRA-02 | 1 | |
| 10 | 온보딩 다듬기 + 제출 타임라인 | SPEC-WEB-01/02 | 2 | WEB-02 ✅ 완료(dry-run 검수 화면 선행 구축) — WEB-01 남음 |
| 11 | 약관·계정위임 동의 + 수동 과금 | SPEC-BIZ-01/02 | 2 | 첫 유료 전환 |
| 12 | 오산 어댑터 활성화 | SPEC-ADAPT-02 | 2 | "지자체 추가 1주" 프로세스 검증 |

이후(Phase 3~): SPEC-ADAPT-03(5~7곳) → SPEC-NOTIFY-02(알림톡) → SPEC-BIZ-03(정기결제) → SPEC-WEB-03/04(콘솔·랜딩) → SPEC-INFRA-03(신뢰성) — 상세는 [roadmap.md](roadmap.md).
