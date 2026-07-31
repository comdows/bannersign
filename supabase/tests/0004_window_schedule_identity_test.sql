-- youni: 0004 창구 논리 식별자 회귀 테스트 (S03)
-- ===========================================================================
-- 목적: 0001~0004 가 적용된 DB 에서 (municipality_id, target_period_start) 논리 키의
--   이중 행이 거부되고(중복 차단), 다른 논리 키/정상 삽입은 허용됨을 검증한다.
--
-- 실행 방법 (Docker 필요; 저장소에 config.toml 없으므로 먼저 init):
--   supabase init && supabase start && supabase db reset   # 0001~0004 적용
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0004_window_schedule_identity_test.sql
--   # 외부/운영 DB 에는 실행 금지. 판정: 'ALL WINDOW IDENTITY TESTS PASSED'.
--   전체가 트랜잭션 안에서 실행되고 마지막에 ROLLBACK 하므로 DB 상태 불변.
-- ===========================================================================

begin;

insert into municipalities (id, code, name, site_url, adapter_key) values
  ('c0000000-0000-0000-0000-000000000001', 's04t_m1', 'S03 M1', 'https://m1.example', 's04t_m1');

do $$
declare
  M1 constant uuid := 'c0000000-0000-0000-0000-000000000001';
  TPS constant date := date '2026-08-01';
  TPE constant date := date '2026-08-31';
  v_failed boolean;
begin
  -- 정상: 첫 rule 창구 삽입
  insert into application_windows
    (municipality_id, opens_at, closes_at, target_period_start, target_period_end, source)
  values (M1, '2026-07-01T00:00:00+09', '2026-07-05T23:59:00+09', TPS, TPE, 'rule');
  raise notice 'PASS: 첫 창구(rule) 삽입';

  -- 중복 차단: 같은 (muni, target_period_start), opens_at 만 다른 crawled 이중 행 → 거부
  v_failed := false;
  begin
    insert into application_windows
      (municipality_id, opens_at, closes_at, target_period_start, target_period_end, source)
    values (M1, '2026-07-02T00:00:00+09', '2026-07-06T23:59:00+09', TPS, TPE, 'crawled');
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'FAIL: 같은 논리 키(opens_at 만 다른) 이중 행이 거부되지 않음';
  end if;
  raise notice 'PASS: 논리 키 중복(이중 행) 차단';

  -- 정상: 다른 target_period_start 는 허용
  insert into application_windows
    (municipality_id, opens_at, closes_at, target_period_start, target_period_end, source)
  values (M1, '2026-08-01T00:00:00+09', '2026-08-05T23:59:00+09', date '2026-09-01', date '2026-09-30', 'rule');
  raise notice 'PASS: 다른 논리 키(다음 대상월) 삽입 허용';

  raise notice '=====================================';
  raise notice 'ALL WINDOW IDENTITY TESTS PASSED';
  raise notice '=====================================';
end $$;

rollback;
