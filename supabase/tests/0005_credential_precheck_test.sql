-- youni: 0005 계정 사전 점검 기록 회귀 테스트 (S04)
-- ===========================================================================
-- 목적: 0001~0005 가 적용된 DB 에서 credential_prechecks 가
--   (1) (window_id, credential_id) 당 한 행만 허용하고(중복 로그인 차단의 근거),
--   (2) 테넌트/지자체가 어긋난 (credential, window) 조합을 거부하며,
--   (3) status/attempts 체크 제약이 살아 있고,
--   (4) RLS 가 켜져 있고 쓰기 정책이 없는지(사용자 쓰기 불가) 를 검증한다.
--
-- 실행 방법 (Docker 필요; 저장소에 config.toml 없으므로 먼저 init):
--   supabase init && supabase start && supabase db reset   # 0001~0005 적용
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 \
--     -f supabase/tests/0005_credential_precheck_test.sql
--   # 외부/운영 DB 에는 실행 금지. 판정: 'ALL CREDENTIAL PRECHECK TESTS PASSED'.
--   전체가 트랜잭션 안에서 실행되고 마지막에 ROLLBACK 하므로 DB 상태 불변.
-- ===========================================================================

begin;

insert into tenants (id, name) values
  ('d0000000-0000-0000-0000-00000000000a', 'S04 T1'),
  ('d0000000-0000-0000-0000-00000000000b', 'S04 T2');

insert into municipalities (id, code, name, site_url, adapter_key) values
  ('d1000000-0000-0000-0000-000000000001', 's04p_m1', 'S04 M1', 'https://m1.example', 's04p_m1'),
  ('d1000000-0000-0000-0000-000000000002', 's04p_m2', 'S04 M2', 'https://m2.example', 's04p_m2');

insert into application_windows
  (id, municipality_id, opens_at, closes_at, target_period_start, target_period_end, source)
values
  ('d2000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001',
   '2026-09-01T00:00:00+09', '2026-09-05T23:59:00+09', date '2026-10-01', date '2026-10-31', 'rule'),
  ('d2000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000002',
   '2026-09-01T00:00:00+09', '2026-09-05T23:59:00+09', date '2026-10-01', date '2026-10-31', 'rule'),
  -- W3 는 W1 과 같은 지자체(M1)의 별도 창구. 불일치 테스트가 (window, credential)
  -- 중복 유니크에 걸려 "우연히" 통과하는 것을 막기 위해 쓴다.
  ('d2000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001',
   '2026-09-10T00:00:00+09', '2026-09-15T23:59:00+09', date '2026-11-01', date '2026-11-30', 'rule');

insert into site_credentials (id, tenant_id, municipality_id, username, password_enc, enc_iv) values
  ('d3000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-00000000000a',
   'd1000000-0000-0000-0000-000000000001', 's04user1', 'enc', 'iv'),
  ('d3000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-00000000000b',
   'd1000000-0000-0000-0000-000000000001', 's04user2', 'enc', 'iv');

do $$
declare
  T1 constant uuid := 'd0000000-0000-0000-0000-00000000000a';
  T2 constant uuid := 'd0000000-0000-0000-0000-00000000000b';
  M1 constant uuid := 'd1000000-0000-0000-0000-000000000001';
  M2 constant uuid := 'd1000000-0000-0000-0000-000000000002';
  W1 constant uuid := 'd2000000-0000-0000-0000-000000000001';
  W2 constant uuid := 'd2000000-0000-0000-0000-000000000002';
  W3 constant uuid := 'd2000000-0000-0000-0000-000000000003';
  C1 constant uuid := 'd3000000-0000-0000-0000-000000000001';
  v_failed boolean;
  v_constraint text;
  v_rls boolean;
  v_write_policies int;
begin
  -- 1. 정상: 창구 × 계정 점검 클레임
  insert into credential_prechecks (window_id, credential_id, tenant_id, municipality_id)
  values (W1, C1, T1, M1);
  raise notice 'PASS: 사전 점검 클레임 삽입';

  -- 2. 중복 차단: 같은 (window, credential) 두 번째 클레임 거부
  --    → 중복/재시도 precheck 잡이 같은 계정에 다시 로그인하지 못하는 DB 근거
  v_failed := false;
  v_constraint := null;
  begin
    insert into credential_prechecks (window_id, credential_id, tenant_id, municipality_id)
    values (W1, C1, T1, M1);
  exception when others then
    v_failed := true;
    get stacked diagnostics v_constraint = constraint_name;
  end;
  if not v_failed then
    raise exception 'FAIL: 같은 (window, credential) 중복 클레임이 거부되지 않음';
  end if;
  if v_constraint is distinct from 'credential_prechecks_window_id_credential_id_key' then
    raise exception 'FAIL: 중복 클레임이 (window, credential) 유니크가 아닌 %(으)로 거부됨', coalesce(v_constraint, '(이름 없음)');
  end if;
  raise notice 'PASS: (window, credential) 중복 클레임 차단';

  -- 2-1. 불일치 테스트의 대조군: (W3, C1) 조합 자체는 삽입 가능하다.
  --      이게 없으면 아래 3·4 번이 "복합 FK 가 막았다"가 아니라 "유니크 중복이
  --      막았다"로도 통과해 버린다(거짓 통과). 확인 후 되돌려 놓는다.
  insert into credential_prechecks (window_id, credential_id, tenant_id, municipality_id)
  values (W3, C1, T1, M1);
  delete from credential_prechecks where window_id = W3 and credential_id = C1;
  raise notice 'PASS: (W3, C1) 대조군 삽입 가능 — 이하 실패는 중복 탓이 아니다';

  -- 3. 테넌트 불일치만 어긋난 경우 거부: W3 는 C1 과 같은 지자체(M1) 창구이므로
  --    창구 복합 FK 는 성립하고, 오직 tenant 만 C1 의 소유 테넌트와 다르다.
  v_failed := false;
  v_constraint := null;
  begin
    insert into credential_prechecks (window_id, credential_id, tenant_id, municipality_id)
    values (W3, C1, T2, M1);
  exception when others then
    v_failed := true;
    get stacked diagnostics v_constraint = constraint_name;
  end;
  if not v_failed then
    raise exception 'FAIL: 테넌트 불일치 계정 점검 기록이 거부되지 않음';
  end if;
  if v_constraint is distinct from 'credential_prechecks_credential_fk' then
    raise exception 'FAIL: 테넌트 불일치가 계정 복합 FK 가 아닌 %(으)로 거부됨', coalesce(v_constraint, '(이름 없음)');
  end if;
  raise notice 'PASS: 테넌트 불일치 거부 (계정 복합 FK)';

  -- 4. 지자체 불일치만 어긋난 경우 거부: (C1, T1, M1) 은 실재하는 계정 조합이고,
  --    W2 만 다른 지자체(M2) 창구다.
  v_failed := false;
  v_constraint := null;
  begin
    insert into credential_prechecks (window_id, credential_id, tenant_id, municipality_id)
    values (W2, C1, T1, M1);
  exception when others then
    v_failed := true;
    get stacked diagnostics v_constraint = constraint_name;
  end;
  if not v_failed then
    raise exception 'FAIL: 창구-지자체 불일치 점검 기록이 거부되지 않음';
  end if;
  if v_constraint is distinct from 'credential_prechecks_window_fk' then
    raise exception 'FAIL: 지자체 불일치가 창구 복합 FK 가 아닌 %(으)로 거부됨', coalesce(v_constraint, '(이름 없음)');
  end if;
  raise notice 'PASS: 창구-지자체 불일치 거부 (창구 복합 FK)';

  -- 5. status 체크 제약
  v_failed := false;
  begin
    update credential_prechecks set status = 'bogus' where window_id = W1 and credential_id = C1;
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'FAIL: 허용되지 않은 status 가 통과됨';
  end if;
  raise notice 'PASS: status 체크 제약';

  -- 6. attempts >= 1 체크 제약
  v_failed := false;
  begin
    update credential_prechecks set attempts = 0 where window_id = W1 and credential_id = C1;
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'FAIL: attempts = 0 이 통과됨';
  end if;
  raise notice 'PASS: attempts 체크 제약';

  -- 7. terminal 결과 기록은 정상 동작
  update credential_prechecks
     set status = 'invalid', outcome_code = 'login_failed', checked_at = now()
   where window_id = W1 and credential_id = C1;
  raise notice 'PASS: terminal 결과 기록';

  -- 8. RLS 가 켜져 있고, 사용자 쓰기 정책이 없다(worker service_role 전용 쓰기)
  select relrowsecurity into v_rls from pg_class where relname = 'credential_prechecks';
  if not coalesce(v_rls, false) then
    raise exception 'FAIL: credential_prechecks 에 RLS 가 켜져 있지 않음';
  end if;
  select count(*) into v_write_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'credential_prechecks'
     and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  if v_write_policies > 0 then
    raise exception 'FAIL: 사용자 쓰기 정책이 % 건 존재 (service_role 전용이어야 함)', v_write_policies;
  end if;
  raise notice 'PASS: RLS 활성 + 사용자 쓰기 정책 없음';

  raise notice '=====================================';
  raise notice 'ALL CREDENTIAL PRECHECK TESTS PASSED';
  raise notice '=====================================';
end $$;

rollback;
