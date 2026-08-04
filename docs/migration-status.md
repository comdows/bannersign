# 운영 DB 마이그레이션 현황

이 문서는 실제 Supabase DB에 대한 **사용자 적용 보고와 직접 검증 범위**를 구분하는 기준 기록이다.
마이그레이션 파일의 병합이나 PR의 로컬 SQL 회귀 테스트만으로는 운영 적용 완료로 표시하지 않는다.

## 현재 기준선

- 대상: 현재 youni 배포에 사용하는 Supabase 프로젝트
- 마지막 확인: **2026-08-03 (KST)**
- 사용자 적용 보고: **`0001` ~ `0006` 순차 실행**
- 직접 확인 완료: **`0006` 핵심 컬럼 3개**
- 추가 확인 필요: **`0006` 제약·readiness 함수·9인자 RPC·실행 권한 메타데이터**
- 다음 마이그레이션 번호: **`0007`**
- 재실행 금지: 검증이 덜 됐다는 이유로 현재 DB에 `0001`~`0006`을 통째로 다시 적용하지 않는다.

| 번호 | 파일 | 현재 DB 상태 |
|---|---|---|
| `0001` | `0001_init.sql` | 사용자 적용 보고 |
| `0002` | `0002_tenant_reference_integrity.sql` | 사용자 적용 보고 |
| `0003` | `0003_request_readiness.sql` | 사용자 적용 보고 |
| `0004` | `0004_window_schedule_identity.sql` | 사용자 적용 보고 |
| `0005` | `0005_credential_precheck.sql` | 사용자 적용 보고 |
| `0006` | `0006_s05_dry_run_rehearsal.sql` | 사용자 적용 보고·핵심 컬럼 확인, 스키마·함수 메타데이터 추가 확인 대기 |

## 확인 기록

| 확인일 (KST) | 적용/확인 내용 | 근거 |
|---|---|---|
| 2026-08-03 | 사용자가 `0001`부터 `0006`까지 순서대로 적용했다고 보고 | `0006`의 핵심 컬럼 3개를 현재 Supabase DB에서 조회해 모두 확인. 후속 제약·함수·RPC·권한은 미확인 |

확인된 `0006` 컬럼:

- `application_requests.dry_run_only`
- `submission_attempts.audit_events`
- `submission_jobs.dry_run_completed_at`

사용한 확인 쿼리:

```sql
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (
    ('application_requests', 'dry_run_only'),
    ('submission_jobs', 'dry_run_completed_at'),
    ('submission_attempts', 'audit_events')
  )
order by table_name, column_name;
```

`0006` 스키마·함수 메타데이터 추가 확인 쿼리(운영 DB에서 아직 실행 기록 없음):

이 쿼리는 객체 정의와 권한을 읽기만 하며 실제 동작을 증명하지 않는다. 행동 계약은 로컬 SQL
회귀로 검증하고, 운영에서는 S05의 승인된 dry-run 흐름으로 확인한다.

```sql
-- 네 제약이 모두 보여야 한다. 특히 submission_jobs_status_check 정의에
-- dry_run_completed가 포함됐는지 확인한다.
select c.conrelid::regclass as table_name, c.conname, pg_get_constraintdef(c.oid) as definition
from pg_constraint c
join pg_namespace n on n.oid = c.connamespace
where n.nspname = 'public'
  and c.conname in (
  'application_requests_dry_run_once_check',
  'submission_jobs_status_check',
  'submission_jobs_dry_run_completed_consistency',
  'submission_attempts_audit_events_array_check'
)
order by c.conrelid::regclass::text, c.conname;

-- 결과가 정확히 한 행(overload_count=1), pronargs=9여야 하며 arguments의 마지막이
-- p_dry_run_only boolean, security_definer=true여야 한다.
-- authenticated_can_execute=true, anon_can_execute=false여야 한다.
select
  p.proname,
  count(*) over () as overload_count,
  p.pronargs,
  pg_get_function_identity_arguments(p.oid) as arguments,
  p.prosecdef as security_definer,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'create_application_request';

-- readiness 함수가 dry_run_only 분기를 포함해야 한다.
select
  p.oid::regprocedure as signature,
  position('dry_run_only' in pg_get_functiondef(p.oid)) > 0 as has_dry_run_branch
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'request_readiness_issue';
```

## 앞으로의 적용·기록 규칙

1. **빈 신규 DB**에만 `0001`부터 전체 파일을 순서대로 적용한다.
2. **기존 DB**에는 이 문서 다음 번호의 미적용 파일만 적용한다. 현재 번호 예약은 `0007`이며,
   새 migration 적용 전 위 `0006` 스키마·함수 메타데이터 확인을 먼저 끝낸다.
3. 기존 번호를 다시 실행하지 않는다. 현재 마이그레이션은 중복 실행을 보장하지 않는다.
4. 운영 적용 전 백업과 대상 프로젝트를 확인하고, 적용 후에는 해당 스키마/RPC/제약 검증 쿼리를 실행한다.
5. 실제 DB 검증이 끝난 같은 작업에서 이 문서에 적용 파일, 대상, KST 시각, 검증 근거와 다음 번호를 갱신한다.
6. CI의 로컬 Supabase 성공은 회귀 검증일 뿐 운영 적용 기록으로 간주하지 않는다.
