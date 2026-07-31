-- youni: 0003 자동 신청 준비도 게이트 회귀 테스트 (S02)
-- ===========================================================================
-- 목적: 0001+0002+0003 이 적용된 DB 에서
--   (1) 준비 부족 요청의 직접 insert/update(REST/서비스롤 포함)가 거부되고,
--   (2) 준비 완료 요청은 생성되며,
--   (3) recurrence='once' 는 첫 submission_job 후 즉시 expired, monthly 는 active
--   임을 검증한다. (준비도 항목별 로직은 packages/core readiness.test.ts 에서 검증.)
--
-- 실행 방법 (Docker 필요). 저장소에 supabase/config.toml 이 없으므로 먼저 init:
--   supabase init          # config.toml 생성 (기존 migrations/ 보존; 설정 생성 물으면 N)
--   supabase start         # 로컬 Postgres+Auth+Storage 컨테이너
--   supabase db reset      # migrations/0001,0002,0003 순서 적용
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0003_request_readiness_test.sql
--   # 포트를 바꿨다면 supabase status 로 DB URL 확인. 외부/운영 DB 에는 실행 금지.
--
-- 판정: 'ALL READINESS TESTS PASSED' NOTICE 출력 시 성공. 전체가 트랜잭션 안에서
--   실행되고 마지막에 ROLLBACK 하므로 DB 상태는 변하지 않는다.
-- ===========================================================================

begin;

-- ── 시드 ────────────────────────────────────────────────────────────────────
insert into tenants (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'S02 Tenant A');

-- 지자체: M1(자동 가능), M_beta(비활성), M_noauto(active 지만 autoSubmit=false)
insert into municipalities (id, code, name, site_url, adapter_key, status, capabilities) values
  ('10000000-0000-0000-0000-000000000001', 's03t_m1', 'S02 M1', 'https://m1.example', 's03t_m1',
     'active',  '{"autoSubmit": true,  "onlinePayment": false, "captchaType": "none"}'),
  ('10000000-0000-0000-0000-000000000004', 's03t_beta', 'S02 Beta', 'https://beta.example', 's03t_beta',
     'beta',    '{"autoSubmit": true,  "onlinePayment": false, "captchaType": "none"}'),
  ('10000000-0000-0000-0000-000000000005', 's03t_noauto', 'S02 NoAuto', 'https://na.example', 's03t_noauto',
     'active',  '{"autoSubmit": false, "onlinePayment": false, "captchaType": "none"}');

-- 게시대: 활성/비활성 (모두 M1)
insert into board_sites (id, municipality_id, external_id, name, is_active) values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'B-A', '활성 게시대', true),
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'B-I', '비활성 게시대', false);

-- 규격: M1 version 1
insert into municipality_specs (municipality_id, version, spec) values
  ('10000000-0000-0000-0000-000000000001', 1, '{}'::jsonb);

-- 창구: M1
insert into application_windows (id, municipality_id, opens_at, closes_at, target_period_start, target_period_end) values
  ('60000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
     now(), now() + interval '5 days', current_date, current_date + 30);

-- 프로필: 정상 / 연락처 공백
insert into advertiser_profiles (id, tenant_id, business_name, phone) values
  ('20000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '이음네트웍스', '010-1234-5678'),
  ('20000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '공백연락처', '   ');

-- 시안: 검증됨(pass) / 검증없음 / 검증fail
insert into designs (id, tenant_id, storage_path, file_name) values
  ('30000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'a/ok.jpg', 'ok.jpg'),
  ('30000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'a/noval.jpg', 'noval.jpg'),
  ('30000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'a/fail.jpg', 'fail.jpg');

insert into design_validations (design_id, tenant_id, municipality_id, spec_version, verdict) values
  ('30000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     '10000000-0000-0000-0000-000000000001', 1, 'pass'),
  ('30000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
     '10000000-0000-0000-0000-000000000001', 1, 'fail');

-- 계정: 정상(ok) / 잠김(locked)  (모두 M1, tenant A)
insert into site_credentials (id, tenant_id, municipality_id, username, password_enc, enc_iv, status) values
  ('40000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     '10000000-0000-0000-0000-000000000001', 'ok-user', 'enc', 'iv', 'ok'),
  ('40000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
     '10000000-0000-0000-0000-000000000001', 'locked-user', 'enc', 'iv', 'locked');

-- ── 테스트 본문 ──────────────────────────────────────────────────────────────
do $$
declare
  v_req uuid;    -- 정상 monthly
  v_ronce uuid;  -- 정상 once
  v_paused uuid; -- 준비 부족 paused (update 우회 테스트)
  v_failed boolean;
  v_status text;
  A constant uuid := '11111111-1111-1111-1111-111111111111';
  M1 constant uuid := '10000000-0000-0000-0000-000000000001';
  MBETA constant uuid := '10000000-0000-0000-0000-000000000004';
  MNOAUTO constant uuid := '10000000-0000-0000-0000-000000000005';
  P_OK constant uuid := '20000000-0000-0000-0000-000000000001';
  P_BAD constant uuid := '20000000-0000-0000-0000-000000000002';
  D_OK constant uuid := '30000000-0000-0000-0000-000000000001';
  D_NOVAL constant uuid := '30000000-0000-0000-0000-000000000002';
  D_FAIL constant uuid := '30000000-0000-0000-0000-000000000003';
  C_OK constant uuid := '40000000-0000-0000-0000-000000000001';
  C_LOCKED constant uuid := '40000000-0000-0000-0000-000000000002';
  BOARD_A constant jsonb := '[{"boardSiteId":"50000000-0000-0000-0000-000000000001","priority":1}]';
  BOARD_I constant jsonb := '[{"boardSiteId":"50000000-0000-0000-0000-000000000002","priority":1}]';
  W1 constant uuid := '60000000-0000-0000-0000-000000000001';
begin
  ------------------------------------------------------------------
  -- 정상: 준비 완료 active 요청은 생성된다
  ------------------------------------------------------------------
  insert into application_requests
    (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
  values (A, M1, P_OK, C_OK, D_OK, BOARD_A)
  returning id into v_req;
  raise notice 'PASS: 준비 완료 요청 생성됨';

  ------------------------------------------------------------------
  -- 직접 insert 우회 거부 (각 준비 항목)
  ------------------------------------------------------------------
  -- (1) municipality_inactive (beta)
  v_failed := false;
  begin
    insert into application_requests (tenant_id, municipality_id, profile_id, design_id)
    values (A, MBETA, P_OK, D_OK);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: 비활성 지자체 active 요청이 생성됨'; end if;
  raise notice 'PASS: municipality_inactive 거부';

  -- (2) autosubmit_unavailable
  v_failed := false;
  begin
    insert into application_requests (tenant_id, municipality_id, profile_id, design_id)
    values (A, MNOAUTO, P_OK, D_OK);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: autoSubmit 미지원 지자체 요청이 생성됨'; end if;
  raise notice 'PASS: autosubmit_unavailable 거부';

  -- (3) credential_missing (null credential)
  v_failed := false;
  begin
    insert into application_requests (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
    values (A, M1, P_OK, null, D_OK, BOARD_A);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: credential 없는 active 요청이 생성됨'; end if;
  raise notice 'PASS: credential_missing 거부';

  -- (4) credential_unusable (locked)
  v_failed := false;
  begin
    insert into application_requests (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
    values (A, M1, P_OK, C_LOCKED, D_OK, BOARD_A);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: locked 계정 요청이 생성됨'; end if;
  raise notice 'PASS: credential_unusable 거부';

  -- (5) profile_incomplete (연락처 공백)
  v_failed := false;
  begin
    insert into application_requests (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
    values (A, M1, P_BAD, C_OK, D_OK, BOARD_A);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: 프로필 불완전 요청이 생성됨'; end if;
  raise notice 'PASS: profile_incomplete 거부';

  -- (6) validation_missing (검증 없는 시안)
  v_failed := false;
  begin
    insert into application_requests (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
    values (A, M1, P_OK, C_OK, D_NOVAL, BOARD_A);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: 미검증 시안 요청이 생성됨'; end if;
  raise notice 'PASS: validation_missing 거부';

  -- (7) validation_failed (fail 시안)
  v_failed := false;
  begin
    insert into application_requests (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
    values (A, M1, P_OK, C_OK, D_FAIL, BOARD_A);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: fail 판정 시안 요청이 생성됨'; end if;
  raise notice 'PASS: validation_failed 거부';

  -- (8) boards_missing (board 0개)
  v_failed := false;
  begin
    insert into application_requests (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
    values (A, M1, P_OK, C_OK, D_OK, '[]'::jsonb);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: board 없는 요청이 생성됨'; end if;
  raise notice 'PASS: boards_missing 거부';

  -- (9) board_invalid (비활성 board)
  v_failed := false;
  begin
    insert into application_requests (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
    values (A, M1, P_OK, C_OK, D_OK, BOARD_I);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: 비활성 board 요청이 생성됨'; end if;
  raise notice 'PASS: board_invalid(비활성) 거부';

  ------------------------------------------------------------------
  -- 직접 UPDATE 우회 거부
  ------------------------------------------------------------------
  -- paused 불완전 요청은 보존 목적상 생성 가능(비활성이라 스케줄 대상 아님)
  insert into application_requests
    (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences, status)
  values (A, M1, P_OK, null, D_OK, BOARD_A, 'paused')
  returning id into v_paused;
  raise notice 'PASS: 준비 부족 요청을 paused 로 보존(비활성)';

  -- paused → active 승격 시 준비도 트리거가 거부 (credential 없음)
  v_failed := false;
  begin
    update application_requests set status = 'active' where id = v_paused;
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: 준비 부족 요청의 active 승격이 허용됨'; end if;
  raise notice 'PASS: paused→active 승격 거부(UPDATE 우회 차단)';

  -- 정상 active 요청을 비활성 board 로 UPDATE → 거부
  v_failed := false;
  begin
    update application_requests set board_preferences = BOARD_I where id = v_req;
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: active 요청의 비활성 board UPDATE 가 허용됨'; end if;
  raise notice 'PASS: active 요청 board_invalid UPDATE 거부';

  ------------------------------------------------------------------
  -- recurrence: once → 첫 job 후 expired, monthly → active 유지
  ------------------------------------------------------------------
  insert into application_requests
    (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences, recurrence)
  values (A, M1, P_OK, C_OK, D_OK, BOARD_A, 'once')
  returning id into v_ronce;

  -- once 요청 첫 submission_job → 트리거가 즉시 expired
  insert into submission_jobs (request_id, window_id, tenant_id) values (v_ronce, W1, A);
  select status into v_status from application_requests where id = v_ronce;
  if v_status <> 'expired' then raise exception 'FAIL: once 요청이 첫 job 후 expired 아님 (%)', v_status; end if;
  raise notice 'PASS: once → 첫 job 후 expired';

  -- 중복 job insert(unique 위반) 경로에서도 최종 상태는 expired 유지
  v_failed := false;
  begin
    insert into submission_jobs (request_id, window_id, tenant_id) values (v_ronce, W1, A);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: 중복 job insert 가 거부되지 않음(unique 기대)'; end if;
  select status into v_status from application_requests where id = v_ronce;
  if v_status <> 'expired' then raise exception 'FAIL: 중복 경로 후 once 상태가 expired 아님'; end if;
  raise notice 'PASS: 중복 job 경로에서도 once 는 expired 유지(멱등)';

  -- monthly 요청은 job 생성 후에도 active 유지
  insert into submission_jobs (request_id, window_id, tenant_id) values (v_req, W1, A);
  select status into v_status from application_requests where id = v_req;
  if v_status <> 'active' then raise exception 'FAIL: monthly 요청이 job 후 active 아님 (%)', v_status; end if;
  raise notice 'PASS: monthly → job 후에도 active 유지';

  raise notice '=====================================';
  raise notice 'ALL READINESS TESTS PASSED';
  raise notice '=====================================';
end $$;

rollback;
