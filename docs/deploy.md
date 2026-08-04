# Phase 0 배포 가이드 (실가동)

로드맵 Phase 0의 인프라 연결 절차. 순서대로 진행하면 화성 자동 신청이 실제로
돌아가는 상태가 된다. 예상 비용: 월 0~5만원(무료 티어 위주).

S05는 코드 준비와 자동 회귀 검증까지만 완료된 상태다. 아래 Fly 배포와 본인 hsdr 계정의
실사이트 리허설을 통과하기 전에는 S05 완료 또는 실제 제출 가능 상태로 간주하지 않는다.

전제: 이 저장소가 GitHub에 있고(comdows/bannersign), 로컬에 pnpm이 있음.

> 아래 명령 블록은 Bash 기준이다. Windows에서는 Git Bash/WSL을 사용하거나, PowerShell에서
> `export NAME=value`를 `$env:NAME='value'`로, 줄 연속 `\`를 백틱으로 바꾼다.

## 현재 배포 스냅샷 (2026-08-05 KST)

- 공개 web `https://youni-web.vercel.app/login`은 HTTP 200이다. 2026-08-05 GitHub 배포 기록상
  최신 Production은 `b393e06`이고 S05 기능 기준선 `65dc642`는 Preview까지만 성공했다. 승격 여부와
  Production 환경변수는 이번 점검에서 확인하지 못했다.
- Supabase는 사용자가 `0001`~`0006`을 순차 적용했다고 보고했고 `0006` 핵심 컬럼 3개를 확인했다.
  제약·readiness 함수·9인자 RPC·권한 메타데이터는 [현황 문서](migration-status.md)의 읽기 전용
  쿼리로 추가 확인해야 하며, 실제 동작은 S05 dry-run으로 별도 검증한다.
- Fly 앱 `youni-worker`는 `pending`이며 release·IP가 없다. 무료 체험 종료로 VM 조회·배포가
  차단돼 결제수단 등록 후 첫 배포가 필요하고, worker DNS와 `/healthz`도 아직 사용할 수 없다.
- 따라서 S05 실계정 dry-run은 미완료다. `SUBMIT_DRY_RUN_DEFAULT=false`로 바꾸지 않는다.

---

## 0. 공통 키 생성 (1회)

사이트 계정 비밀번호 암호화 키. web과 worker가 **같은 값**을 써야 한다.
```bash
openssl rand -hex 32   # 출력값을 CREDENTIALS_ENC_KEY로 저장 (64 hex chars)
```
web↔worker 인증용 공유 시크릿:
```bash
openssl rand -hex 24   # WORKER_SHARED_SECRET
```
Anthropic API 키는 console.anthropic.com에서 발급 (ANTHROPIC_API_KEY).

기존 배포와 저장된 계정이 있으면 위 키를 새로 만들지 않는다. Vercel Production의 기존
`CREDENTIALS_ENC_KEY`를 worker에도 그대로 사용한다. 이 키를 바꾸면 기존 `site_credentials`를
재암호화하기 전까지 복호화할 수 없다. `WORKER_SHARED_SECRET`은 worker에 필요하고, 향후 web의
직접 enqueue 경로를 연결할 때 양쪽에 같은 값을 쓴다. `SUPABASE_SERVICE_ROLE_KEY`는 worker에만
두고 Vercel/client 환경에 넣지 않는다.

---

## 1. Supabase (DB + Auth + Storage)

운영 적용 전 [DB 마이그레이션 현황](migration-status.md)을 먼저 확인한다. 2026-08-03 기준
`0001`~`0006` 순차 적용 보고와 `0006` 핵심 컬럼 3개 확인 기록이 있다. 다음 번호 예약은
`0007`이지만 새 migration 적용 전 `0006` 스키마·함수 메타데이터 확인을 먼저 끝낸다.

1. supabase.com 가입 → New project (Region: **Northeast Asia (Seoul/Tokyo)**, 무료 플랜)
2. 프로젝트 생성 후 값 3개 확보:
   - **Project URL**: Settings → API → Project URL
   - **anon key**: Settings → API → Project API keys → `anon` `public`
   - **service_role key**: 같은 화면 → `service_role` (비공개, worker 전용)
3. 스키마+시드 적용:
   - **기존 DB**: 현황 문서보다 큰 미적용 번호만 적용한다. `apply_all.sh`나 `0001`부터의 전체
     재실행은 금지한다. 현재 기준으로 추가 적용할 파일은 없다.
   - **빈 신규 DB + psql**: 전체 스키마와 시드를 처음 한 번만 적용한다.
     ```bash
     export DATABASE_URL="postgresql://postgres:<DB비밀번호>@db.<ref>.supabase.co:5432/postgres"
     ./supabase/apply_all.sh
     ```
     (연결 문자열: Settings → Database → Connection string → URI)
   - **빈 신규 DB + SQL 에디터**: 아래 순서로 파일 내용을 붙여넣어 실행
      1. `supabase/migrations/0001_init.sql`
      2. `supabase/migrations/0002_tenant_reference_integrity.sql`
      3. `supabase/migrations/0003_request_readiness.sql`
      4. `supabase/migrations/0004_window_schedule_identity.sql`
      5. `supabase/migrations/0005_credential_precheck.sql`
      6. `supabase/migrations/0006_s05_dry_run_rehearsal.sql`
      7. `supabase/seed.sql`
      8. `supabase/seed_boards_hwaseong.sql`
      9. `supabase/seed_directory.sql`
4. Storage 확인: 마이그레이션이 `designs`/`audit`/`captcha` private 버킷을 만든다.
   없으면 Storage에서 private 버킷 3개 수동 생성.
5. Auth: Authentication → Providers → Email 활성화(매직링크). Site URL과
   Redirect URL에 web 배포 도메인(아래 3단계) + `/auth/callback` 추가.

PR에서는 별도 `sql-regression` job이 Supabase CLI 2.111.0으로 로컬 DB를 시작하고 위
migration·seed와 `supabase/tests/*.sql` 전체를 실행한다. 이 검증에는 운영 DB나 시크릿을
사용하지 않으며 [운영 적용 현황](migration-status.md)을 자동으로 변경하지 않는다.

---

## 2. Redis (BullMQ 큐)

Upstash(upstash.com) 무료 Redis 생성 → **REDIS_URL**(rediss://... TLS) 확보.
Fly.io 자체 Redis(Upstash 연동)를 써도 된다: `fly redis create`.

---

## 3. web 배포 (Vercel)

1. vercel.com → Add New Project → comdows/bannersign import
2. **Root Directory: `apps/web`** 설정. `apps/web/vercel.json`의 install/build 명령이 `../..`의
   workspace 루트를 참조하므로 Project Settings → Build & Deployment에서 **Root Directory 밖의
   소스 파일을 빌드에 포함하는 옵션**도 켠다. 새 프로젝트에서는 이 옵션 없이 재현됐다고 가정하지 않는다.
3. Environment Variables (Production):
   ```
   NEXT_PUBLIC_SUPABASE_URL=<Project URL>
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   CREDENTIALS_ENC_KEY=<0단계 hex 32바이트>
   ANTHROPIC_API_KEY=<Anthropic 키>
   ```
   현재 web runtime은 worker의 `/enqueue`를 호출하지 않고 DB intent를 worker scheduler가 polling한다.
   따라서 S05에는 Vercel의 `WORKER_URL`·`WORKER_SHARED_SECRET`이 필요하지 않다. 향후 직접 enqueue
   경로를 연결할 때만 worker와 같은 `WORKER_SHARED_SECRET` 및 배포 URL을 Vercel server env에 넣는다.
4. Deploy → 도메인 확보 → Supabase Auth의 Site/Redirect URL에 반영(1-5).

---

## 4. worker 배포 (Fly.io)

Playwright 상시 구동. Dockerfile은 **저장소 루트를 빌드 컨텍스트**로 요구한다.
```bash
# 앱이 없을 때만 최초 1회 생성 (현재 youni-worker는 이미 있으므로 재실행하지 않음)
fly launch --no-deploy --config apps/worker/fly.toml --name youni-worker

# 시크릿 주입 (0~2단계 값)
fly secrets set --app youni-worker \
  SUPABASE_URL="<Project URL>" \
  SUPABASE_SERVICE_ROLE_KEY="<service_role key>" \
  REDIS_URL="<Upstash rediss URL>" \
  WORKER_SHARED_SECRET="<공유 시크릿>" \
  CREDENTIALS_ENC_KEY="<web과 동일 hex>" \
  SUBMIT_DRY_RUN_DEFAULT="true"    # ★ 처음엔 반드시 true (실제 제출 방지)

# 실제 Resend 키가 있을 때만 선택적으로 설정. placeholder 값은 넣지 않는다.
fly secrets set --app youni-worker RESEND_API_KEY="<실제 Resend API 키>"

# 저장소 루트에서 기존 앱에 머신 1대로 첫 배포
fly deploy --app youni-worker --ha=false \
  --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile .
```
배포 후 현재 S05 경로는 DB polling으로 동작하므로 Vercel 재배포 없이 worker를 검증한다. 향후 web의
`POST /enqueue` 호출을 구현할 때 `https://youni-worker.fly.dev`와 공유 시크릿을 Vercel에 설정한다.
`GET /healthz` 200은 HTTP 프로세스 생존만 뜻한다. `fly machine list --app youni-worker`에서 머신이
정확히 1대인지 확인한다. 이어 5단계에서 안전한 S05 요청을 만든 뒤 worker 시작 로그와 그 요청의
다음 scheduler tick DB/queue side effect를 함께 확인한다. 현재 scheduler는 성공 heartbeat를 매분
기록하지 않으므로 로그가 조용하다는 이유만으로 tick 성공을 판정하지 않는다.
`ANTHROPIC_API_KEY`는 현재 web의 시안 검증용이며 worker 필수 env가 아니다.

---

## 5. 검증 (첫 사이클)

1. web 도메인 접속 → 매직링크 로그인 → 설정에서 워크스페이스 생성
2. 사업자 프로필(주식회사 이음네트웍스) + 화성 사이트 계정(암호화 저장) 등록
3. 시안 JPG 업로드 → 화성 규격으로 AI 검증 (pass/warn/fail 확인)
4. 자동 신청 화면에서 화성(`beta`) + 프로필 + 계정 + 시안 + 희망 게시대를 고른다.
   실제 신청 버튼 대신 **`1회 리허설 예약`**과 “최종 제출 없음” 경고가 보이는지 확인한다.
5. `1회 리허설 예약`을 실행하고 생성된 요청이 `dry_run_only=true`, `recurrence=once`인지 확인한다.
6. worker 로그에서 스케줄러가 현재 열린 창구(`application_windows`)를 dry-run catch-up으로
   잡는지 확인한다.
7. worker가 로그인→규약동의→게시대선택→시안첨부→최종 제출 직전까지 진행하고,
   `reserved_save.jsp` 최종 저장 요청 없이 멈추는지 확인한다.
8. 잡이 `dry_run_completed`이고 `submitted_at`·`receipt_no`가 비어 있는지, 잡 상세 화면에서
   다섯 단계 각각의 URL·표시 시각·스크린샷을 확인한다. HTML은 선택 증적이므로 `htmlPath`가 기록된
   경우 `submission_attempts.audit_events`와 private `audit` Storage에서 별도로 확인한다.
9. 본인 hsdr 마이페이지에 실제 신청이 생기지 않았는지 직접 확인한다.
10. 7~9가 모두 통과하기 전에는 S05를 완료 처리하지 않고 S06 실제 제출을 시작하지 않는다.
    `SUBMIT_DRY_RUN_DEFAULT=false` 전환도 별도의 승인된 S06 절차에서만 수행한다.

---

## 비용 메모

- Supabase Free, Vercel Hobby, Upstash Free로 시작 가능(월 0원)
- Fly.io shared-cpu-1x/1gb 상시 1대 ≈ 월 3~5천원
- Claude API는 시안 검증/결과 파싱 종량 — 초기엔 미미
- 유료 고객이 생기면 Supabase Pro($25) 전환 시점 판단(로드맵 Phase 2)
