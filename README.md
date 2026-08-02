# youni — 현수막 게시대 자동 신청 플랫폼

지자체(화성·오산 등 경기 남부)마다 제각각인 현수막 게시대 신청을 자동화하는 멀티테넌트 SaaS.

- 사업자 정보·시안을 **사전 등록**하면, 매월 신청 창구(예: 1일~5일)가 열릴 때 **자동으로 제출**
- 추첨/선정 **결과를 크롤링해 알림**으로 피드백
- 지자체별 규격(사이즈·색상·필수 문구)에 대해 **AI(Claude vision) 시안 적합성 검증**

## 구조 (pnpm + Turborepo 모노레포)

```
apps/
  web/        Next.js 대시보드 (Vercel) — 신청 예약, 시안 업로드/검증, 캡차 릴레이, 관리자 콘솔
  worker/     Node + Playwright + BullMQ — 크롤링, 자동 제출, 결과 수집 (Docker 상시 구동)
packages/
  core/       도메인 타입, 잡 페이로드 zod 스키마, 암호화 유틸, 제출 잡 상태 머신
  db/         Supabase 클라이언트 팩토리, DB row 타입
  adapters/   지자체별 어댑터 (MunicipalityAdapter 플러그인) + 공통 유틸 + 픽스처 테스트
  ai/         Claude 프롬프트/스키마 (시안 검증, 규격 파싱, 결과표 추출)
supabase/     마이그레이션(스키마+RLS), 시드
```

## 핵심 흐름

1. **상시 주문(standing order)**: 사용자가 `application_requests`에 "창구가 열리면 이 프로필+시안+게시대 우선순위로 신청" 등록
2. **스케줄러**: worker의 마스터 틱이 DB `application_windows`를 읽어 창구 오픈 시각에 맞춰 BullMQ delayed job 큐잉 (D-3 준비 점검, D-1 로그인 사전 점검 포함)
3. **자동 제출**: Playwright로 로그인→폼 입력→게시대 선택→시안 업로드→(캡차는 웹 UI로 사용자에게 실시간 릴레이)→제출. 매 단계 스크린샷 감사 증적 저장
4. **결과 피드백**: 결과 발표 예정일부터 크롤링, 접수번호/사업자명 매칭 후 선정/탈락 알림
5. **AI 시안 검증**: 사이즈/비율은 코드로 결정적 판정, 필수 문구·금지 콘텐츠·색상은 Claude vision structured output

## 개발

```bash
pnpm install
pnpm typecheck
pnpm test

# web
cd apps/web && cp .env.example .env.local && pnpm dev

# worker
cd apps/worker && cp .env.example .env && pnpm dev
```

Supabase 마이그레이션은 먼저 [운영 DB 마이그레이션 현황](docs/migration-status.md)을 확인한다.
빈 신규 DB만 전체 파일을 순서대로 적용하고, 기존 DB에는 아직 적용되지 않은 다음 번호만 적용한다.
적용 완료된 파일을 다시 실행하지 않는다.

## 문서 (docs/)

| 문서 | 역할 |
|---|---|
| [사업계획서](docs/business-plan.md) | **왜** — 문제·시장·수익모델·GTM·재무·리스크 |
| [상용화 로드맵](docs/roadmap.md) | **언제 무엇을** — Phase 0~4, Exit 기준, 비용 |
| [개발 기획서](docs/product-spec.md) | **어떻게** — 빌드 상태 기준선, `SPEC-*` 기능 스펙, 어댑터 런북, 우선순위 백로그 |
| [플랫폼 기획서](docs/platform-plan.md) | **무엇을 왜** — 고객, 제품 범위, 사용자 흐름, 운영·보안 원칙 |
| [세부 개발 계획서](docs/development-plan.md) | **어떤 순서로** — 개발 슬라이스, 의존성, 검증 기준, 남은 게이트 |
| [배포 가이드](docs/deploy.md) | Phase 0 인프라 연결 절차 |
| [DB 마이그레이션 현황](docs/migration-status.md) | 운영 DB 적용 완료 번호·검증 근거·다음 번호 |
| [지자체 디렉토리](docs/site-research.md) | 접수처 실측 데이터·템플릿 분류 |

새 기능 개발은 [개발 기획서의 백로그](docs/product-spec.md#5-우선순위-백로그-지금--다음) 순서를 따른다.

## 운영 주체 (수탁 구조)

현수막 게시대는 지자체가 직접 운영하지 않고 **수탁 기관에 위임**하는 경우가 대부분이다
(화성시: 장애인 단체 수탁, 타 지자체는 옥외광고협회 지회·민간 대행 등 제각각).
신청 사이트·회원가입·규정·문의처가 모두 이 수탁 기관 기준이므로:

- `municipalities.operator_type` (city / association / welfare_org / private) + `operator_name`, `operator_contact`로 관리
- 어댑터 조사 시 **지자체 홈페이지가 아니라 수탁 기관의 신청 사이트**를 기준으로 실측할 것
- 사용자 계정도 수탁 기관 사이트 계정임 (지자체 통합 로그인 아님)

## 신규 지자체 추가

1. `supabase` seed 또는 admin UI로 `municipalities` 레코드 추가 (`adapter_key` 지정)
2. `packages/adapters/src/<key>/` 에 어댑터 구현 (`adapter.ts`, `spec.ts`, `fixtures/`, `adapter.test.ts`)
3. `packages/adapters/src/registry.ts` 에 등록
4. 픽스처 테스트 + 실창구 dry-run 리허설 통과 후 `status: active` 전환

## 운영 원칙

- 사용자가 **본인 계정으로 본인 신청**을 자동화하는 대리 입력 도구. 다계정/중복 신청은 시스템이 차단(unique 제약, max_entries=1)
- 캡차 자동 해제 서비스 사용 안 함 — 사용자 수동 릴레이
- 사이트 계정 비밀번호는 AES-256-GCM 앱 레이어 암호화, worker에서 제출 직전에만 복호화
- 자동화가 금지된 사이트는 `capabilities.auto_submit=false`로 두고 수동 신청 안내(assisted manual)만 제공
