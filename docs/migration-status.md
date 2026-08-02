# 운영 DB 마이그레이션 현황

이 문서는 **실제 Supabase DB에 적용됐다고 확인된 마이그레이션**의 기준 기록이다.
마이그레이션 파일의 병합이나 PR의 로컬 SQL 회귀 테스트만으로는 적용 완료로 표시하지 않는다.

## 현재 기준선

- 대상: 현재 youni 배포에 사용하는 Supabase 프로젝트
- 마지막 확인: **2026-08-03 (KST)**
- 적용 완료: **`0001` ~ `0006`**
- 다음 마이그레이션 번호: **`0007`**
- 재실행 금지: 현재 DB에 `0001` ~ `0006`을 다시 적용하지 않는다.

| 번호 | 파일 | 현재 DB 상태 |
|---|---|---|
| `0001` | `0001_init.sql` | 적용 완료 |
| `0002` | `0002_tenant_reference_integrity.sql` | 적용 완료 |
| `0003` | `0003_request_readiness.sql` | 적용 완료 |
| `0004` | `0004_window_schedule_identity.sql` | 적용 완료 |
| `0005` | `0005_credential_precheck.sql` | 적용 완료 |
| `0006` | `0006_s05_dry_run_rehearsal.sql` | 적용 완료·스키마 확인 |

## 확인 기록

| 확인일 (KST) | 적용/확인 내용 | 근거 |
|---|---|---|
| 2026-08-03 | 사용자가 `0001`부터 `0006`까지 순서대로 적용 | `0006`의 필수 컬럼 3개를 현재 Supabase DB에서 조회해 모두 확인 |

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

## 앞으로의 적용·기록 규칙

1. **빈 신규 DB**에만 `0001`부터 전체 파일을 순서대로 적용한다.
2. **기존 DB**에는 이 문서 다음 번호의 미적용 파일만 적용한다. 현재 기준 다음 파일은 `0007`이다.
3. 기존 번호를 다시 실행하지 않는다. 현재 마이그레이션은 중복 실행을 보장하지 않는다.
4. 운영 적용 전 백업과 대상 프로젝트를 확인하고, 적용 후에는 해당 스키마/RPC/제약 검증 쿼리를 실행한다.
5. 실제 DB 검증이 끝난 같은 작업에서 이 문서에 적용 파일, 대상, KST 시각, 검증 근거와 다음 번호를 갱신한다.
6. CI의 로컬 Supabase 성공은 회귀 검증일 뿐 운영 적용 기록으로 간주하지 않는다.
