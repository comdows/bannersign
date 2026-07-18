# Phase 0 배포 가이드 (실가동)

로드맵 Phase 0의 인프라 연결 절차. 순서대로 진행하면 화성 자동 신청이 실제로
돌아가는 상태가 된다. 예상 비용: 월 0~5만원(무료 티어 위주).

전제: 이 저장소가 GitHub에 있고(comdows/youni), 로컬에 pnpm이 있음.

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

---

## 1. Supabase (DB + Auth + Storage)

1. supabase.com 가입 → New project (Region: **Northeast Asia (Seoul/Tokyo)**, 무료 플랜)
2. 프로젝트 생성 후 값 3개 확보:
   - **Project URL**: Settings → API → Project URL
   - **anon key**: Settings → API → Project API keys → `anon` `public`
   - **service_role key**: 같은 화면 → `service_role` (비공개, worker 전용)
3. 스키마+시드 적용 — 둘 중 하나:
   - **psql 있으면**:
     ```bash
     export DATABASE_URL="postgresql://postgres:<DB비밀번호>@db.<ref>.supabase.co:5432/postgres"
     ./supabase/apply_all.sh
     ```
     (연결 문자열: Settings → Database → Connection string → URI)
   - **없으면**: SQL 에디터에 아래 순서로 파일 내용을 붙여넣어 실행
     1. `supabase/migrations/0001_init.sql`
     2. `supabase/seed.sql`
     3. `supabase/seed_boards_hwaseong.sql`
     4. `supabase/seed_directory.sql`
4. Storage 확인: 마이그레이션이 `designs`/`audit`/`captcha` private 버킷을 만든다.
   없으면 Storage에서 private 버킷 3개 수동 생성.
5. Auth: Authentication → Providers → Email 활성화(매직링크). Site URL과
   Redirect URL에 web 배포 도메인(아래 3단계) + `/auth/callback` 추가.

---

## 2. Redis (BullMQ 큐)

Upstash(upstash.com) 무료 Redis 생성 → **REDIS_URL**(rediss://... TLS) 확보.
Fly.io 자체 Redis(Upstash 연동)를 써도 된다: `fly redis create`.

---

## 3. web 배포 (Vercel)

1. vercel.com → Add New Project → comdows/youni import
2. **Root Directory: `apps/web`** 설정 (모노레포 — `apps/web/vercel.json`이 빌드/설치를
   루트에서 돌리도록 이미 구성됨)
3. Environment Variables (Production):
   ```
   NEXT_PUBLIC_SUPABASE_URL=<Project URL>
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   CREDENTIALS_ENC_KEY=<0단계 hex 32바이트>
   ANTHROPIC_API_KEY=<Anthropic 키>
   WORKER_URL=<worker 배포 URL, 4단계 후 입력>
   WORKER_SHARED_SECRET=<0단계 공유 시크릿>
   ```
4. Deploy → 도메인 확보 → Supabase Auth의 Site/Redirect URL에 반영(1-5).

---

## 4. worker 배포 (Fly.io)

Playwright 상시 구동. Dockerfile은 **저장소 루트를 빌드 컨텍스트**로 요구한다.
```bash
# 최초 1회 앱 생성 (배포는 아직)
fly launch --no-deploy --config apps/worker/fly.toml --name youni-worker

# 시크릿 주입 (0~2단계 값)
fly secrets set --app youni-worker \
  SUPABASE_URL="<Project URL>" \
  SUPABASE_SERVICE_ROLE_KEY="<service_role key>" \
  REDIS_URL="<Upstash rediss URL>" \
  WORKER_SHARED_SECRET="<공유 시크릿>" \
  CREDENTIALS_ENC_KEY="<web과 동일 hex>" \
  ANTHROPIC_API_KEY="<Anthropic 키>" \
  SUBMIT_DRY_RUN_DEFAULT="true"    # ★ 처음엔 반드시 true (실제 제출 방지)

# 저장소 루트에서 배포 (컨텍스트=루트, Dockerfile은 apps/worker)
fly deploy --config apps/worker/fly.toml --dockerfile apps/worker/Dockerfile .
```
배포 후 `https://youni-worker.fly.dev` 를 Vercel의 `WORKER_URL`에 넣고 web 재배포.
`GET /healthz`가 200이면 정상.

---

## 5. 검증 (첫 사이클)

1. web 도메인 접속 → 매직링크 로그인 → 설정에서 워크스페이스 생성
2. 사업자 프로필(주식회사 이음네트웍스) + 화성 사이트 계정(암호화 저장) 등록
3. 시안 JPG 업로드 → 화성 규격으로 AI 검증 (pass/warn/fail 확인)
4. 자동 신청 등록: 화성 + 프로필 + 계정 + 시안 + 희망 게시대
5. worker 로그에서 스케줄러가 8월 창구(application_windows)를 잡는지 확인
6. **dry-run 리허설**: 창구가 열리는 8월 1~5일에 worker가 로그인→게시대선택→
   시안첨부까지 진행하고 최종 제출 직전에 멈춘 감사 스크린샷을 남기는지 확인
   (audit 버킷 / 대시보드 신청 현황)
7. dry-run 증적이 정상이면 `SUBMIT_DRY_RUN_DEFAULT=false`로 실제 제출 활성화

---

## 비용 메모

- Supabase Free, Vercel Hobby, Upstash Free로 시작 가능(월 0원)
- Fly.io shared-cpu-1x/1gb 상시 1대 ≈ 월 3~5천원
- Claude API는 시안 검증/결과 파싱 종량 — 초기엔 미미
- 유료 고객이 생기면 Supabase Pro($25) 전환 시점 판단(로드맵 Phase 2)
