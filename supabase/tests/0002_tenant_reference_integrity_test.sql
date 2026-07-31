-- youni: 0002 테넌트·지자체 참조 무결성 회귀 테스트 (S01)
-- ===========================================================================
-- 목적: 0001_init.sql + 0002_tenant_reference_integrity.sql 이 적용된 DB 에서
--   교차 테넌트/교차 지자체 위조가 DB 계층에서 거부되고, 정상 조합과
--   nullable credential 은 성공하는지 검증한다.
--
-- 실행 방법 (택1). 0001 은 auth/storage 스키마를 요구하므로 "Supabase 호환" DB 가
-- 필요하다(순정 Postgres 로는 0001 적용이 실패한다).
--
--   A) 로컬 Supabase 스택 (Docker 필요) — 권장.
--      이 저장소에는 supabase/config.toml 이 없으므로 먼저 init 으로 생성한다.
--        supabase init          # supabase/config.toml 생성 (기존 migrations/ 는 보존).
--                               #   VS Code/Deno 설정 생성 여부를 물으면 N 로 답해도 됨.
--        supabase start         # 로컬 Postgres+Auth+Storage 컨테이너 기동.
--        supabase db reset      # supabase/migrations/0001,0002 를 순서대로 적용
--                               #   (seed 는 config 에 등록돼 있지 않으면 적용되지 않음 — 테스트엔 무관).
--        # 로컬 DB 기본 접속 문자열(포트/비밀번호는 supabase 기본값):
--        psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--          -v ON_ERROR_STOP=1 -f supabase/tests/0002_tenant_reference_integrity_test.sql
--        # (포트를 바꿨다면: supabase status 로 DB URL 확인)
--
--   B) 이미 0001+0002 가 적용된 Supabase 호환 DB(로컬/브랜치 등)에 직접 실행:
--        psql "<DB_URL>" -v ON_ERROR_STOP=1 \
--          -f supabase/tests/0002_tenant_reference_integrity_test.sql
--      아직 미적용이면 마이그레이션을 먼저 넣는다:
--        psql "<DB_URL>" -v ON_ERROR_STOP=1 \
--          -f supabase/migrations/0001_init.sql \
--          -f supabase/migrations/0002_tenant_reference_integrity.sql
--
--   ※ 외부/운영 DB 에는 실행하지 말 것. 로컬 스택 또는 일회용 테스트 DB 에서만.
--
-- 판정: 마지막에 'ALL INTEGRITY TESTS PASSED' NOTICE 가 출력되면 성공.
--   어떤 단언이라도 실패하면 EXCEPTION 으로 즉시 중단된다.
--   파일 전체가 트랜잭션 안에서 실행되고 마지막에 ROLLBACK 하므로 DB 상태는
--   변경되지 않는다.
-- ===========================================================================

begin;

-- ── 시드 데이터 ────────────────────────────────────────────────────────────
-- 테넌트 A / B, 지자체 M1 / M2.
-- code 는 seed.sql(hwaseong/osan/siheung) 및 seed_directory.sql(suwon 등)과
-- 절대 충돌하지 않도록 테스트 전용 접두사('s01test_')를 쓴다. 그래야 시드가
-- 이미 적용된 DB 에서도 이 테스트를 돌릴 수 있다.
insert into tenants (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'S01 Tenant A'),
  ('22222222-2222-2222-2222-222222222222', 'S01 Tenant B');

insert into municipalities (id, code, name, site_url, adapter_key) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 's01test_m1', 'S01 테스트시1', 'https://m1.example', 's01test_m1'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 's01test_m2', 'S01 테스트시2', 'https://m2.example', 's01test_m2');

insert into board_sites (id, municipality_id, external_id, name) values
  ('88888888-8888-8888-8888-888888888888', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'M1-1', 'M1 게시대'),
  ('99999999-9999-9999-9999-999999999999', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'M2-1', 'M2 게시대');

-- 두 창구의 opens_at 을 다르게 둔다: 부모측 UPDATE 테스트에서 window 의
-- municipality 를 바꿀 때 unique(municipality_id, opens_at) 우발 충돌을 피하기 위함.
insert into application_windows (id, municipality_id, opens_at, closes_at, target_period_start, target_period_end) values
  ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     now(), now() + interval '5 days', current_date, current_date + 30),
  ('4d4d4d4d-4d4d-4d4d-4d4d-4d4d4d4d4d4d', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
     now() + interval '1 hour', now() + interval '5 days', current_date, current_date + 30);

-- 테넌트 A 자산 (화성)
insert into advertiser_profiles (id, tenant_id, business_name, phone) values
  ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'A상사', '010-0000-0001');
insert into designs (id, tenant_id, storage_path, file_name) values
  ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'a/x.jpg', 'x.jpg');
insert into site_credentials (id, tenant_id, municipality_id, username, password_enc, enc_iv) values
  ('77777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a-user', 'enc', 'iv'),
  -- 테넌트 A 의 수원 계정 (교차 지자체 테스트용)
  ('7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a7a7a', '11111111-1111-1111-1111-111111111111',
     'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'a-user-suwon', 'enc', 'iv');

-- 테넌트 B 자산 (위조 소스)
insert into advertiser_profiles (id, tenant_id, business_name, phone) values
  ('5b5b5b5b-5b5b-5b5b-5b5b-5b5b5b5b5b5b', '22222222-2222-2222-2222-222222222222', 'B상사', '010-0000-0002');
insert into designs (id, tenant_id, storage_path, file_name) values
  ('6b6b6b6b-6b6b-6b6b-6b6b-6b6b6b6b6b6b', '22222222-2222-2222-2222-222222222222', 'b/y.jpg', 'y.jpg');
insert into site_credentials (id, tenant_id, municipality_id, username, password_enc, enc_iv) values
  ('7b7b7b7b-7b7b-7b7b-7b7b-7b7b7b7b7b7b', '22222222-2222-2222-2222-222222222222',
     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'b-user', 'enc', 'iv');

-- ── S02 준비도 트리거와의 격리 ──────────────────────────────────────────────
-- 이 테스트는 S01(참조 무결성) 만 검증한다. 0003_request_readiness.sql 이 적용된
-- DB(예: supabase db reset)에서는 application_requests 준비도 트리거가 active
-- 요청 insert 를 가로채므로, 트랜잭션 동안만 해당 트리거를 비활성화한다(ROLLBACK
-- 시 자동 복원). 0003 미적용 DB 에서는 트리거가 없으므로 조건부로 처리한다.
-- (S02 준비도 게이트 자체는 supabase/tests/0003_request_readiness_test.sql 에서 검증.)
do $$
begin
  if exists (select 1 from pg_trigger where tgname = 'trg_requests_aa_readiness') then
    execute 'alter table application_requests disable trigger trg_requests_aa_readiness';
  end if;
end $$;

-- ── 단언 헬퍼 & 테스트 본문 ────────────────────────────────────────────────
do $$
declare
  v_req uuid;
  v_req2 uuid;
  v_failed boolean;
begin
  ------------------------------------------------------------------
  -- 정상 케이스 1: 같은 테넌트 A + 화성, 계정/게시대 모두 화성
  ------------------------------------------------------------------
  insert into application_requests
    (id, tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
  values
    ('33333333-3333-3333-3333-333333333333',
     '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     '55555555-5555-5555-5555-555555555555', '77777777-7777-7777-7777-777777777777',
     '66666666-6666-6666-6666-666666666666',
     '[{"boardSiteId":"88888888-8888-8888-8888-888888888888","priority":1}]'::jsonb)
  returning id into v_req;
  raise notice 'PASS: 정상 요청 생성됨';

  ------------------------------------------------------------------
  -- 정상 케이스 2: nullable credential (계정 없이 등록)
  ------------------------------------------------------------------
  insert into application_requests
    (tenant_id, municipality_id, profile_id, credential_id, design_id, board_preferences)
  values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     '55555555-5555-5555-5555-555555555555', null,
     '66666666-6666-6666-6666-666666666666', '[]'::jsonb);
  raise notice 'PASS: nullable credential 요청 생성됨';

  ------------------------------------------------------------------
  -- 위조 1: 사용자 B 의 profile 을 A 요청에 끼움 → 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    insert into application_requests
      (tenant_id, municipality_id, profile_id, design_id)
    values
      ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       '5b5b5b5b-5b5b-5b5b-5b5b-5b5b5b5b5b5b',  -- B 의 profile
       '66666666-6666-6666-6666-666666666666');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: 교차 테넌트 profile 이 거부되지 않음'; end if;
  raise notice 'PASS: 교차 테넌트 profile 거부됨';

  ------------------------------------------------------------------
  -- 위조 2: 사용자 B 의 design 을 A 요청에 끼움 → 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    insert into application_requests
      (tenant_id, municipality_id, profile_id, design_id)
    values
      ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       '55555555-5555-5555-5555-555555555555',
       '6b6b6b6b-6b6b-6b6b-6b6b-6b6b6b6b6b6b');  -- B 의 design
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: 교차 테넌트 design 이 거부되지 않음'; end if;
  raise notice 'PASS: 교차 테넌트 design 거부됨';

  ------------------------------------------------------------------
  -- 위조 3: 사용자 B 의 credential 을 A 요청에 끼움 → 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    insert into application_requests
      (tenant_id, municipality_id, profile_id, credential_id, design_id)
    values
      ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       '55555555-5555-5555-5555-555555555555',
       '7b7b7b7b-7b7b-7b7b-7b7b-7b7b7b7b7b7b',  -- B 의 credential
       '66666666-6666-6666-6666-666666666666');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: 교차 테넌트 credential 이 거부되지 않음'; end if;
  raise notice 'PASS: 교차 테넌트 credential 거부됨';

  ------------------------------------------------------------------
  -- 위조 4: 다른 지자체(수원) credential 을 화성 요청에 결합 → 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    insert into application_requests
      (tenant_id, municipality_id, profile_id, credential_id, design_id)
    values
      ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       '55555555-5555-5555-5555-555555555555',
       '7a7a7a7a-7a7a-7a7a-7a7a-7a7a7a7a7a7a',  -- A 의 수원 계정
       '66666666-6666-6666-6666-666666666666');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: 교차 지자체 credential 이 거부되지 않음'; end if;
  raise notice 'PASS: 교차 지자체 credential 거부됨';

  ------------------------------------------------------------------
  -- 위조 5: 다른 지자체(수원) 게시대를 화성 요청 board_preferences 에 포함 → 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    insert into application_requests
      (tenant_id, municipality_id, profile_id, design_id, board_preferences)
    values
      ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       '55555555-5555-5555-5555-555555555555',
       '66666666-6666-6666-6666-666666666666',
       '[{"boardSiteId":"99999999-9999-9999-9999-999999999999","priority":1}]'::jsonb); -- 수원 게시대
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: 교차 지자체 board 가 거부되지 않음'; end if;
  raise notice 'PASS: 교차 지자체 board 거부됨';

  ------------------------------------------------------------------
  -- 위조 6: submission_jobs 의 window 가 request 와 다른 지자체 → 거부
  --   (v_req = 정상 화성 요청; 수원 window 를 결합)
  ------------------------------------------------------------------
  v_failed := false;
  begin
    insert into submission_jobs (request_id, window_id, tenant_id)
    values (v_req, '4d4d4d4d-4d4d-4d4d-4d4d-4d4d4d4d4d4d',   -- 수원 window
            '11111111-1111-1111-1111-111111111111');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: 교차 지자체 window 결합이 거부되지 않음'; end if;
  raise notice 'PASS: 교차 지자체 submission_jobs.window 거부됨';

  ------------------------------------------------------------------
  -- 위조 7: submission_jobs.tenant_id 가 request tenant 와 다름 → 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    insert into submission_jobs (request_id, window_id, tenant_id)
    values (v_req, '44444444-4444-4444-4444-444444444444',
            '22222222-2222-2222-2222-222222222222');  -- 잘못된 테넌트
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: 교차 테넌트 submission_jobs 가 거부되지 않음'; end if;
  raise notice 'PASS: 교차 테넌트 submission_jobs 거부됨';

  ------------------------------------------------------------------
  -- 정상 케이스 3: 올바른 화성 window + 화성 요청 submission_jobs
  ------------------------------------------------------------------
  insert into submission_jobs (request_id, window_id, tenant_id)
  values (v_req, '44444444-4444-4444-4444-444444444444',
          '11111111-1111-1111-1111-111111111111');
  raise notice 'PASS: 정상 submission_jobs 생성됨';

  ------------------------------------------------------------------
  -- 위조 8: design_validations 의 design 이 다른 테넌트 → 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    insert into design_validations
      (design_id, tenant_id, municipality_id, spec_version, verdict)
    values
      ('6b6b6b6b-6b6b-6b6b-6b6b-6b6b6b6b6b6b',  -- B 의 design
       '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       1, 'pass');
  exception when others then v_failed := true;
  end;
  if not v_failed then raise exception 'FAIL: 교차 테넌트 design_validation 이 거부되지 않음'; end if;
  raise notice 'PASS: 교차 테넌트 design_validation 거부됨';

  ------------------------------------------------------------------
  -- 정상 케이스 4: 같은 테넌트 design_validation
  ------------------------------------------------------------------
  insert into design_validations
    (design_id, tenant_id, municipality_id, spec_version, verdict)
  values
    ('66666666-6666-6666-6666-666666666666',
     '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     1, 'pass');
  raise notice 'PASS: 정상 design_validation 생성됨';

  ------------------------------------------------------------------
  -- RPC 방어: 인증 컨텍스트(auth.uid) 없이 호출 시 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    perform create_application_request(
      '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666');
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'FAIL: 미인증 RPC 호출이 거부되지 않음';
  end if;
  raise notice 'PASS: 미인증 create_application_request 거부됨';

  -- ================================================================
  -- PARENT-SIDE 우회(부모 UPDATE) 방어 테스트
  --   자식(잡/요청)이 이미 있는 상태에서 부모의 지자체를 바꿔 사후
  --   불일치를 만드는 3가지 경로가 거부되는지 확인한다.
  -- ================================================================

  -- 준비: 계정/게시대 없는 M1 요청(v_req2) + M1 window 잡 생성.
  --   (credential=null, board=[] 이라 복합 FK/보드 트리거가 개입하지 않으므로
  --    부모측 잡 트리거만 단독 검증된다.)
  insert into application_requests
    (tenant_id, municipality_id, profile_id, design_id, board_preferences)
  values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
     '55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666', '[]'::jsonb)
  returning id into v_req2;
  insert into submission_jobs (request_id, window_id, tenant_id)
  values (v_req2, '44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111');

  ------------------------------------------------------------------
  -- UPDATE 우회 1: 잡이 있는 요청의 municipality_id 를 M2 로 변경 → 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    update application_requests
      set municipality_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      where id = v_req2;
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'FAIL: 잡 존재 상태에서 요청 지자체 변경이 거부되지 않음';
  end if;
  raise notice 'PASS: 부모측 application_requests.municipality_id 변경 거부됨';

  ------------------------------------------------------------------
  -- UPDATE 우회 2: 잡이 참조하는 window(M1)의 municipality_id 를 M2 로 변경 → 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    update application_windows
      set municipality_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      where id = '44444444-4444-4444-4444-444444444444';
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'FAIL: 잡 존재 상태에서 창구 지자체 변경이 거부되지 않음';
  end if;
  raise notice 'PASS: 부모측 application_windows.municipality_id 변경 거부됨';

  ------------------------------------------------------------------
  -- UPDATE 우회 3: v_req 의 board_preferences 가 참조하는 게시대(M1-1)의
  --   municipality_id 를 M2 로 변경 → 거부
  ------------------------------------------------------------------
  v_failed := false;
  begin
    update board_sites
      set municipality_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
      where id = '88888888-8888-8888-8888-888888888888';
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'FAIL: 참조된 게시대의 지자체 변경이 거부되지 않음';
  end if;
  raise notice 'PASS: 부모측 board_sites.municipality_id 변경 거부됨';

  ------------------------------------------------------------------
  -- 정상 케이스 5: 동일 값/무관 행 부모 UPDATE 는 허용
  ------------------------------------------------------------------
  -- (a) 요청 지자체를 같은 값으로 UPDATE → 허용 (변화 없음)
  update application_requests
    set municipality_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    where id = v_req2;
  -- (b) 어떤 요청도 참조하지 않는 M2 게시대(M2-1)의 지자체를 M1 으로 변경 → 허용
  update board_sites
    set municipality_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    where id = '99999999-9999-9999-9999-999999999999';
  raise notice 'PASS: 동일 값/무관 행 부모 UPDATE 허용됨';

  raise notice '=====================================';
  raise notice 'ALL INTEGRITY TESTS PASSED';
  raise notice '=====================================';
end $$;

rollback;
