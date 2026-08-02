-- youni: 0006 S05 dry-run 리허설 DB 계약 회귀 테스트
-- ===========================================================================
-- 0001~0006 적용 후 로컬 Supabase DB에서 실행한다.
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0006_s05_dry_run_rehearsal_test.sql
-- 전체 테스트는 트랜잭션 안에서 실행되고 마지막에 ROLLBACK 한다.

begin;

insert into tenants (id, name) values
  ('e0000000-0000-0000-0000-000000000001', 'S05 Tenant');

insert into auth.users
  (id, email, encrypted_password, email_confirmed_at, aud, role, created_at, updated_at)
values
  ('e0000000-0000-0000-0000-000000000002', 's05@example.test', '', now(),
   'authenticated', 'authenticated', now(), now());

insert into tenant_members (tenant_id, user_id, role) values
  ('e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'owner');

insert into municipalities
  (id, code, name, site_url, adapter_key, status, capabilities)
values
  ('e1000000-0000-0000-0000-000000000001', 's05_active', 'S05 Active',
   'https://active.example', 's05_active', 'active',
   '{"autoSubmit":true,"onlinePayment":false,"captchaType":"none"}'),
  ('e1000000-0000-0000-0000-000000000002', 's05_beta', 'S05 Beta',
   'https://beta.example', 's05_beta', 'beta',
   '{"autoSubmit":true,"onlinePayment":false,"captchaType":"none"}'),
  ('e1000000-0000-0000-0000-000000000003', 's05_broken', 'S05 Broken',
   'https://broken.example', 's05_broken', 'broken',
   '{"autoSubmit":true,"onlinePayment":false,"captchaType":"none"}'),
  ('e1000000-0000-0000-0000-000000000004', 's05_disabled', 'S05 Disabled',
   'https://disabled.example', 's05_disabled', 'disabled',
   '{"autoSubmit":true,"onlinePayment":false,"captchaType":"none"}'),
  ('e1000000-0000-0000-0000-000000000005', 's05_noauto', 'S05 NoAuto',
   'https://noauto.example', 's05_noauto', 'beta',
   '{"autoSubmit":false,"onlinePayment":false,"captchaType":"none"}');

insert into advertiser_profiles (id, tenant_id, business_name, phone) values
  ('e2000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000001', 'S05 광고주', '010-5555-0000');

insert into designs (id, tenant_id, storage_path, file_name) values
  ('e3000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000001', 's05/design.png', 'design.png');

insert into municipality_specs (municipality_id, version, spec)
select id, 1, '{}'::jsonb
from municipalities
where code like 's05_%';

insert into design_validations
  (design_id, tenant_id, municipality_id, spec_version, verdict)
select
  'e3000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000001', id, 1, 'pass'
from municipalities
where code like 's05_%';

insert into board_sites (id, municipality_id, external_id, name)
values
  ('e4000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'ACTIVE-1', 'Active 게시대'),
  ('e4000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000002', 'BETA-1', 'Beta 게시대'),
  ('e4000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000003', 'BROKEN-1', 'Broken 게시대'),
  ('e4000000-0000-0000-0000-000000000004', 'e1000000-0000-0000-0000-000000000004', 'DISABLED-1', 'Disabled 게시대'),
  ('e4000000-0000-0000-0000-000000000005', 'e1000000-0000-0000-0000-000000000005', 'NOAUTO-1', 'NoAuto 게시대');

insert into site_credentials
  (id, tenant_id, municipality_id, username, password_enc, enc_iv, status)
values
  ('e5000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'active-user', 'enc', 'iv', 'ok'),
  ('e5000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000002', 'beta-user', 'enc', 'iv', 'ok'),
  ('e5000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000003', 'broken-user', 'enc', 'iv', 'ok'),
  ('e5000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000004', 'disabled-user', 'enc', 'iv', 'ok'),
  ('e5000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000005', 'noauto-user', 'enc', 'iv', 'ok');

insert into application_windows
  (id, municipality_id, opens_at, closes_at, target_period_start, target_period_end)
values
  ('e6000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001',
   now(), now() + interval '5 days', date '2026-09-01', date '2026-09-30');

do $$
declare
  T constant uuid := 'e0000000-0000-0000-0000-000000000001';
  U constant uuid := 'e0000000-0000-0000-0000-000000000002';
  P constant uuid := 'e2000000-0000-0000-0000-000000000001';
  D constant uuid := 'e3000000-0000-0000-0000-000000000001';
  MA constant uuid := 'e1000000-0000-0000-0000-000000000001';
  MB constant uuid := 'e1000000-0000-0000-0000-000000000002';
  MK constant uuid := 'e1000000-0000-0000-0000-000000000003';
  MD constant uuid := 'e1000000-0000-0000-0000-000000000004';
  MN constant uuid := 'e1000000-0000-0000-0000-000000000005';
  CA constant uuid := 'e5000000-0000-0000-0000-000000000001';
  CB constant uuid := 'e5000000-0000-0000-0000-000000000002';
  CK constant uuid := 'e5000000-0000-0000-0000-000000000003';
  CD constant uuid := 'e5000000-0000-0000-0000-000000000004';
  CN constant uuid := 'e5000000-0000-0000-0000-000000000005';
  BA constant jsonb := '[{"boardSiteId":"e4000000-0000-0000-0000-000000000001","priority":1}]';
  BB constant jsonb := '[{"boardSiteId":"e4000000-0000-0000-0000-000000000002","priority":1}]';
  BK constant jsonb := '[{"boardSiteId":"e4000000-0000-0000-0000-000000000003","priority":1}]';
  BD constant jsonb := '[{"boardSiteId":"e4000000-0000-0000-0000-000000000004","priority":1}]';
  BN constant jsonb := '[{"boardSiteId":"e4000000-0000-0000-0000-000000000005","priority":1}]';
  W constant uuid := 'e6000000-0000-0000-0000-000000000001';
  v_live uuid;
  v_beta uuid;
  v_job uuid;
  v_attempt uuid;
  v_failed boolean;
  v_text text;
  v_bool boolean;
  v_count int;
  v_pronargs int;
  v_defaults int;
  v_audit jsonb;
begin
  -- 기본값은 기존 live/monthly 동작을 보존한다.
  insert into application_requests
    (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
  values (T, MA, P, CA, D, BA)
  returning id, dry_run_only into v_live, v_bool;
  if v_bool then raise exception 'FAIL: dry_run_only 기본값이 false가 아님'; end if;

  -- live 요청은 beta 에서 거부된다.
  v_failed := false;
  begin
    insert into application_requests
      (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences, recurrence)
    values (T, MB, P, CB, D, BB, 'once');
  exception when others then
    v_failed := true;
    v_text := sqlerrm;
  end;
  if not v_failed or v_text not like '%READINESS:municipality_inactive%' then
    raise exception 'FAIL: beta live 요청 차단 결과가 다름 (%)', coalesce(v_text, '성공');
  end if;

  -- beta 는 명시적 1회 dry-run 만 허용한다.
  insert into application_requests
    (tenant_id, municipality_id, profile_id, credential_id, design_id,
     board_preferences, recurrence, dry_run_only)
  values (T, MB, P, CB, D, BB, 'once', true)
  returning id into v_beta;

  v_failed := false;
  begin
    insert into application_requests
      (tenant_id, municipality_id, profile_id, credential_id, design_id,
       board_preferences, recurrence, dry_run_only)
    values (T, MB, P, CB, D, BB, 'monthly', true);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: monthly dry-run 요청이 허용됨'; end if;

  -- broken/disabled/no-auto 는 dry-run 에서도 fail-closed다.
  v_failed := false;
  begin
    insert into application_requests
      (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences, recurrence, dry_run_only)
    values (T, MK, P, CK, D, BK, 'once', true);
  exception when others then v_failed := sqlerrm like '%READINESS:municipality_inactive%'; end;
  if not v_failed then raise exception 'FAIL: broken dry-run 이 정확히 차단되지 않음'; end if;

  v_failed := false;
  begin
    insert into application_requests
      (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences, recurrence, dry_run_only)
    values (T, MD, P, CD, D, BD, 'once', true);
  exception when others then v_failed := sqlerrm like '%READINESS:municipality_inactive%'; end;
  if not v_failed then raise exception 'FAIL: disabled dry-run 이 정확히 차단되지 않음'; end if;

  v_failed := false;
  begin
    insert into application_requests
      (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences, recurrence, dry_run_only)
    values (T, MN, P, CN, D, BN, 'once', true);
  exception when others then v_failed := sqlerrm like '%READINESS:autosubmit_unavailable%'; end;
  if not v_failed then raise exception 'FAIL: no-auto dry-run 이 정확히 차단되지 않음'; end if;

  -- RPC는 단일 9인자 함수이고 기존 인자 호출 및 기본값을 유지한다.
  select count(*), max(pronargs), max(pronargdefaults)
    into v_count, v_pronargs, v_defaults
  from pg_proc
  where pronamespace = 'public'::regnamespace
    and proname = 'create_application_request';
  if v_count <> 1 or v_pronargs <> 9 or v_defaults <> 5 then
    raise exception 'FAIL: RPC 시그니처/오버로드가 잘못됨 (count %, args %, defaults %)',
      v_count, v_pronargs, v_defaults;
  end if;
  select count(*) into v_count
  from information_schema.routine_privileges
  where routine_schema = 'public'
    and routine_name = 'create_application_request'
    and grantee = 'PUBLIC'
    and privilege_type = 'EXECUTE';
  if v_count <> 0 then
    raise exception 'FAIL: public 이 RPC execute 권한을 가짐';
  end if;
  if not has_function_privilege('authenticated',
       'create_application_request(uuid,uuid,uuid,uuid,uuid,jsonb,text,integer,boolean)', 'EXECUTE') then
    raise exception 'FAIL: authenticated RPC execute 권한이 없음';
  end if;

  perform set_config('request.jwt.claim.sub', U::text, true);
  v_live := create_application_request(T, MA, P, D, CA, BA, 'monthly', 1);
  select dry_run_only, recurrence into v_bool, v_text
  from application_requests where id = v_live;
  if v_bool or v_text <> 'monthly' then
    raise exception 'FAIL: 기존 8인자 RPC 호출 계약이 바뀜';
  end if;

  v_beta := create_application_request(T, MB, P, D, CB, BB, 'monthly', 2, true);
  select dry_run_only, recurrence into v_bool, v_text
  from application_requests where id = v_beta;
  if not v_bool or v_text <> 'once' then
    raise exception 'FAIL: RPC가 dry-run 요청을 once로 강제하지 않음';
  end if;

  -- dry_run_completed 상태/시각/실접수 흔적 일관성.
  insert into submission_jobs (request_id, window_id, tenant_id, status, dry_run)
  values (v_live, W, T, 'running', false)
  returning id into v_job;

  v_failed := false;
  begin
    update submission_jobs
    set status = 'dry_run_completed', dry_run_completed_at = now()
    where id = v_job;
  exception when check_violation then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: dry_run=false 완료가 허용됨'; end if;

  update submission_jobs set dry_run = true where id = v_job;
  v_failed := false;
  begin
    update submission_jobs set status = 'dry_run_completed' where id = v_job;
  exception when check_violation then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: 완료시각 없는 dry_run_completed가 허용됨'; end if;

  v_failed := false;
  begin
    update submission_jobs
    set status = 'dry_run_completed', dry_run_completed_at = now()
    where id = v_job;
  exception when check_violation then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: 선택 게시대 없는 dry_run_completed가 허용됨'; end if;

  update submission_jobs
  set status = 'dry_run_completed',
      dry_run_completed_at = now(),
      selected_board_site_id = 'e4000000-0000-0000-0000-000000000001'
  where id = v_job;

  v_failed := false;
  begin
    update submission_jobs set receipt_no = 'SHOULD-NOT-EXIST' where id = v_job;
  exception when check_violation then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: dry-run 완료에 receipt_no가 허용됨'; end if;

  v_failed := false;
  begin
    update submission_jobs set status = 'running' where id = v_job;
  exception when check_violation then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: 완료시각을 둔 채 다른 상태로 변경됨'; end if;

  -- audit_events 기본값은 배열이며 객체 저장을 거부한다.
  insert into submission_attempts (job_id, tenant_id, attempt_no)
  values (v_job, T, 1)
  returning id into v_attempt;
  select audit_events into v_audit from submission_attempts where id = v_attempt;
  if v_audit <> '[]'::jsonb then raise exception 'FAIL: audit_events 기본값이 []가 아님'; end if;

  update submission_attempts
  set audit_events = '[{"step":"login_success","url":"https://example.test/path","capturedAt":"2026-08-02T00:00:00.000Z","screenshotPath":"audit/01.png","htmlPath":"audit/01.html"}]'
  where id = v_attempt;

  v_failed := false;
  begin
    update submission_attempts set audit_events = '{}'::jsonb where id = v_attempt;
  exception when check_violation then v_failed := true; end;
  if not v_failed then raise exception 'FAIL: audit_events 객체가 허용됨'; end if;

  raise notice '=====================================';
  raise notice 'ALL S05 DRY-RUN DB TESTS PASSED';
  raise notice '=====================================';
end $$;

rollback;
