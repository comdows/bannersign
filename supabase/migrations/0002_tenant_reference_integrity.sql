-- youni: 테넌트·지자체 참조 무결성 강제 (S01)
-- ---------------------------------------------------------------------------
-- 목적:
--   application_requests / design_validations / submission_jobs 가
--   서로 다른 테넌트·지자체의 행을 조합하지 못하도록 DB 계층에서 강제한다.
--   RLS 는 "행의 tenant_id 가 내 테넌트인가" 만 검사하므로, 위조 UUID 로
--   남의 profile/design/credential 을 끼워 넣거나 다른 지자체의
--   board/window 를 섞는 조합은 RLS 만으로 막지 못한다. 이 마이그레이션은
--   복합 외래키 + BEFORE 트리거 조합으로 그 경로를 원천 차단한다.
--   (service_role 로 RLS 를 우회해도 제약/트리거는 우회되지 않는다.)
--
-- 강제 관계:
--   1. application_requests.profile_id      → 같은 tenant
--   2. application_requests.design_id       → 같은 tenant
--   3. application_requests.credential_id   → 같은 tenant + 같은 municipality
--                                             (nullable: credential 미등록 허용)
--   4. application_requests.board_preferences[].boardSiteId
--                                           → 모두 요청 municipality 소속
--   5. design_validations.design_id         → 같은 tenant
--   6. submission_jobs.request_id           → 같은 tenant
--   7. submission_jobs.window_id            → request 와 같은 municipality
--
--   PARENT-SIDE(부모측) 방어: 위 4·7 은 트리거로 강제하므로, 자식 행이 이미
--   생성된 뒤 "부모 행"의 지자체를 바꿔 사후에 어긋나게 만드는 우회가 가능하다.
--   이를 막기 위해 아래 부모 테이블 UPDATE 트리거를 추가한다(service_role 도 우회 불가):
--     - application_requests.municipality_id 변경 시 기존 submission_jobs 의 window 지자체와 어긋나면 거부
--     - application_windows.municipality_id 변경 시 기존 submission_jobs 의 request 지자체와 어긋나면 거부
--     - board_sites.municipality_id 변경 시 그 게시대를 board_preferences 로 참조하는 요청의 지자체와 어긋나면 거부
--   (복합 FK 로 강제되는 1·2·3·5·6 관계는 FK 의 ON UPDATE NO ACTION 이
--    부모측 변경도 자동으로 막으므로 별도 트리거가 불필요하다.)
--
-- ---------------------------------------------------------------------------
-- 사전검사 / forward-fix / 롤백 위험 (READ BEFORE APPLYING):
--
--   * FAIL-FAST 사전검사: 아래 0단계 DO 블록이 기존 데이터에서 위 7개 관계를
--     위반하는 행을 찾으면 즉시 EXCEPTION 을 던져 마이그레이션 전체를
--     롤백한다(마이그레이션은 단일 트랜잭션으로 적용됨). 이는 제약을 붙이다
--     실패해 나오는 모호한 오류 대신, 어떤 테이블의 몇 개 행이 왜 오염됐는지
--     명확히 보여주기 위함이다.
--   * FORWARD-FIX: 사전검사가 실패하면 데이터를 먼저 교정해야 한다.
--       - 오염 행을 삭제하거나(신뢰 불가 데이터),
--       - profile/design/credential 을 올바른 테넌트의 행으로 교체하거나,
--       - board_preferences 에서 타 지자체 boardSiteId 를 제거한다.
--     교정 SQL 예시는 각 검사 블록의 RAISE 메시지에 포함된 조회문을 참고.
--   * 롤백 위험: 이 마이그레이션은 되돌리기(down) 스크립트를 포함하지 않는다.
--     되돌리려면 아래 제약/트리거/함수/유니크키를 역순으로 DROP 하면 되며
--     데이터 손실은 없다(구조 변경만 있고 컬럼 추가/삭제 없음). 단,
--     0001 의 단일 컬럼 FK 는 그대로 두고 복합 FK 만 "추가"하므로,
--     기존 앱 동작에는 영향이 없다.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 0단계. FAIL-FAST 사전검사 — 기존 불일치 데이터 식별
-- ===========================================================================
do $$
declare
  v_bad int;
begin
  -- 1. profile ↔ tenant
  select count(*) into v_bad
  from application_requests ar
  join advertiser_profiles p on p.id = ar.profile_id
  where p.tenant_id <> ar.tenant_id;
  if v_bad > 0 then
    raise exception
      '[precheck 1/7] application_requests 중 profile 이 다른 테넌트인 행 % 건. 교정: select ar.id, ar.tenant_id, p.tenant_id from application_requests ar join advertiser_profiles p on p.id=ar.profile_id where p.tenant_id<>ar.tenant_id;',
      v_bad;
  end if;

  -- 2. design ↔ tenant
  select count(*) into v_bad
  from application_requests ar
  join designs d on d.id = ar.design_id
  where d.tenant_id <> ar.tenant_id;
  if v_bad > 0 then
    raise exception
      '[precheck 2/7] application_requests 중 design 이 다른 테넌트인 행 % 건. 교정: select ar.id from application_requests ar join designs d on d.id=ar.design_id where d.tenant_id<>ar.tenant_id;',
      v_bad;
  end if;

  -- 3. credential ↔ tenant + municipality (credential_id 가 있을 때만)
  select count(*) into v_bad
  from application_requests ar
  join site_credentials c on c.id = ar.credential_id
  where ar.credential_id is not null
    and (c.tenant_id <> ar.tenant_id or c.municipality_id <> ar.municipality_id);
  if v_bad > 0 then
    raise exception
      '[precheck 3/7] application_requests 중 credential 의 tenant/municipality 불일치 행 % 건. 교정: select ar.id from application_requests ar join site_credentials c on c.id=ar.credential_id where c.tenant_id<>ar.tenant_id or c.municipality_id<>ar.municipality_id;',
      v_bad;
  end if;

  -- 4. board_preferences[].boardSiteId ↔ request municipality
  select count(*) into v_bad
  from application_requests ar
  where exists (
    select 1
    from jsonb_array_elements(coalesce(ar.board_preferences, '[]'::jsonb)) bp
    where not exists (
      select 1 from board_sites bs
      where bs.id::text = (bp->>'boardSiteId')
        and bs.municipality_id = ar.municipality_id
    )
  );
  if v_bad > 0 then
    raise exception
      '[precheck 4/7] application_requests 중 board_preferences 에 타 지자체(또는 존재하지 않는) 게시대가 섞인 행 % 건. 교정 대상 조회 후 board_preferences 를 재작성하라.',
      v_bad;
  end if;

  -- 5. design_validations.design ↔ tenant
  select count(*) into v_bad
  from design_validations dv
  join designs d on d.id = dv.design_id
  where d.tenant_id <> dv.tenant_id;
  if v_bad > 0 then
    raise exception
      '[precheck 5/7] design_validations 중 design 이 다른 테넌트인 행 % 건.',
      v_bad;
  end if;

  -- 6. submission_jobs.request ↔ tenant
  select count(*) into v_bad
  from submission_jobs sj
  join application_requests ar on ar.id = sj.request_id
  where ar.tenant_id <> sj.tenant_id;
  if v_bad > 0 then
    raise exception
      '[precheck 6/7] submission_jobs 중 request 가 다른 테넌트인 행 % 건.',
      v_bad;
  end if;

  -- 7. submission_jobs.window municipality ↔ request municipality
  select count(*) into v_bad
  from submission_jobs sj
  join application_requests ar on ar.id = sj.request_id
  join application_windows w on w.id = sj.window_id
  where w.municipality_id <> ar.municipality_id;
  if v_bad > 0 then
    raise exception
      '[precheck 7/7] submission_jobs 중 window 지자체와 request 지자체가 다른 행 % 건.',
      v_bad;
  end if;

  raise notice '[precheck] 모든 사전검사 통과 — 제약을 추가한다.';
end $$;

-- ===========================================================================
-- 1단계. 복합 FK 가 참조할 유니크 키 (id 는 이미 PK 이므로 안전하게 추가 가능)
-- ===========================================================================
alter table advertiser_profiles
  add constraint advertiser_profiles_id_tenant_key unique (id, tenant_id);

alter table designs
  add constraint designs_id_tenant_key unique (id, tenant_id);

alter table site_credentials
  add constraint site_credentials_id_tenant_muni_key unique (id, tenant_id, municipality_id);

alter table application_requests
  add constraint application_requests_id_tenant_key unique (id, tenant_id);

-- ===========================================================================
-- 2단계. 복합 외래키 — 테넌트/지자체 일치를 쓰기 시점에 강제
--   * MATCH SIMPLE(기본): 복합 키 중 하나라도 NULL 이면 제약 미검사.
--     credential_id 가 NULL 인 요청은 tenant/municipality 값과 무관하게 허용된다.
-- ===========================================================================
alter table application_requests
  add constraint application_requests_profile_tenant_fk
  foreign key (profile_id, tenant_id)
  references advertiser_profiles (id, tenant_id);

alter table application_requests
  add constraint application_requests_design_tenant_fk
  foreign key (design_id, tenant_id)
  references designs (id, tenant_id);

alter table application_requests
  add constraint application_requests_credential_tenant_muni_fk
  foreign key (credential_id, tenant_id, municipality_id)
  references site_credentials (id, tenant_id, municipality_id);

alter table design_validations
  add constraint design_validations_design_tenant_fk
  foreign key (design_id, tenant_id)
  references designs (id, tenant_id);

alter table submission_jobs
  add constraint submission_jobs_request_tenant_fk
  foreign key (request_id, tenant_id)
  references application_requests (id, tenant_id);

-- ===========================================================================
-- 3단계. 트리거로 강제하는 관계
--   (jsonb 배열·교차 테이블 municipality 비교는 복합 FK 로 표현 불가)
-- ===========================================================================

-- 3-a. application_requests.board_preferences[].boardSiteId → 요청 municipality
create or replace function enforce_board_prefs_municipality()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if jsonb_typeof(coalesce(new.board_preferences, '[]'::jsonb)) <> 'array' then
    raise exception 'board_preferences 는 배열이어야 합니다.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(new.board_preferences, '[]'::jsonb)) bp
    where not exists (
      select 1 from board_sites bs
      where bs.id::text = (bp->>'boardSiteId')
        and bs.municipality_id = new.municipality_id
    )
  ) then
    raise exception '선택한 게시대 중 해당 지자체에 속하지 않은 항목이 있습니다.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger trg_requests_board_muni
  before insert or update of board_preferences, municipality_id on application_requests
  for each row execute function enforce_board_prefs_municipality();

-- 3-b. submission_jobs.window municipality == request municipality
create or replace function enforce_job_window_municipality()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_req_muni uuid;
  v_win_muni uuid;
begin
  select municipality_id into v_req_muni from application_requests where id = new.request_id;
  select municipality_id into v_win_muni from application_windows where id = new.window_id;

  if v_req_muni is null then
    raise exception 'submission_jobs.request_id(%) 에 해당하는 application_request 가 없습니다.', new.request_id
      using errcode = '23503';
  end if;
  if v_win_muni is null then
    raise exception 'submission_jobs.window_id(%) 에 해당하는 application_window 가 없습니다.', new.window_id
      using errcode = '23503';
  end if;
  if v_req_muni <> v_win_muni then
    raise exception '신청 창구(window)의 지자체가 요청의 지자체와 다릅니다.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger trg_jobs_window_muni
  before insert or update of request_id, window_id on submission_jobs
  for each row execute function enforce_job_window_municipality();

-- 3-c. PARENT-SIDE 방어 — 자식(submission_jobs / application_requests) 이 이미
--      존재하는 상태에서 부모의 지자체를 바꿔 사후 불일치를 만드는 우회 차단.
--      모두 값이 실제로 바뀔 때만(is distinct from) 검사하므로 동일 값/무관 행
--      변경은 허용된다. service_role 도 트리거를 우회하지 못한다.

-- (i) application_requests.municipality_id 변경 → 기존 잡의 window 지자체와 어긋나면 거부
create or replace function enforce_request_muni_vs_jobs()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.municipality_id is distinct from old.municipality_id
     and exists (
       select 1
       from submission_jobs sj
       join application_windows w on w.id = sj.window_id
       where sj.request_id = new.id
         and w.municipality_id <> new.municipality_id
     ) then
    raise exception '이미 생성된 신청 잡의 창구 지자체와 어긋나 요청 지자체를 변경할 수 없습니다.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger trg_requests_muni_vs_jobs
  before update of municipality_id on application_requests
  for each row execute function enforce_request_muni_vs_jobs();

-- (ii) application_windows.municipality_id 변경 → 기존 잡의 request 지자체와 어긋나면 거부
create or replace function enforce_window_muni_vs_jobs()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.municipality_id is distinct from old.municipality_id
     and exists (
       select 1
       from submission_jobs sj
       join application_requests ar on ar.id = sj.request_id
       where sj.window_id = new.id
         and ar.municipality_id <> new.municipality_id
     ) then
    raise exception '이미 생성된 신청 잡의 요청 지자체와 어긋나 창구 지자체를 변경할 수 없습니다.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger trg_windows_muni_vs_jobs
  before update of municipality_id on application_windows
  for each row execute function enforce_window_muni_vs_jobs();

-- (iii) board_sites.municipality_id 변경 → 그 게시대를 참조하는 요청 지자체와 어긋나면 거부
create or replace function enforce_board_muni_vs_requests()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.municipality_id is distinct from old.municipality_id
     and exists (
       select 1
       from application_requests ar
       where ar.municipality_id <> new.municipality_id
         and exists (
           select 1
           from jsonb_array_elements(coalesce(ar.board_preferences, '[]'::jsonb)) bp
           where (bp->>'boardSiteId') = new.id::text
         )
     ) then
    raise exception '이 게시대를 참조하는 자동 신청이 있어 게시대의 지자체를 변경할 수 없습니다.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger trg_boards_muni_vs_requests
  before update of municipality_id on board_sites
  for each row execute function enforce_board_muni_vs_requests();

-- ===========================================================================
-- 4단계. 인증 사용자용 보안 RPC — create_application_request
--   * auth.uid 멤버십을 검증한 뒤 insert (security definer 라 RLS 우회).
--   * 복합 FK/트리거 위반을 사용자 친화적 한국어 메시지로 변환(내부 SQL 비노출).
--   * search_path 고정 + public revoke / authenticated grant.
-- ===========================================================================
create or replace function create_application_request(
  p_tenant_id uuid,
  p_municipality_id uuid,
  p_profile_id uuid,
  p_design_id uuid,
  p_credential_id uuid default null,
  p_board_preferences jsonb default '[]'::jsonb,
  p_recurrence text default 'monthly',
  p_max_entries int default 1
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_constraint text;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.' using errcode = 'P0001';
  end if;

  -- 멤버십 검증: 요청 테넌트가 내 소속 테넌트인가
  if not exists (
    select 1 from tenant_members
    where tenant_id = p_tenant_id and user_id = auth.uid()
  ) then
    raise exception '해당 조직에 대한 권한이 없습니다.' using errcode = 'P0001';
  end if;

  if p_municipality_id is null or p_profile_id is null or p_design_id is null then
    raise exception '지자체·프로필·시안은 필수입니다.' using errcode = 'P0001';
  end if;

  insert into application_requests (
    tenant_id, municipality_id, profile_id, credential_id, design_id,
    board_preferences, recurrence, max_entries
  ) values (
    p_tenant_id, p_municipality_id, p_profile_id, p_credential_id,
    p_design_id, coalesce(p_board_preferences, '[]'::jsonb),
    coalesce(p_recurrence, 'monthly'), coalesce(p_max_entries, 1)
  )
  returning id into v_id;

  return v_id;

exception
  when foreign_key_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'application_requests_profile_tenant_fk' then
      raise exception '선택한 광고주 프로필이 현재 조직에 속하지 않습니다.' using errcode = 'P0001';
    elsif v_constraint = 'application_requests_design_tenant_fk' then
      raise exception '선택한 시안이 현재 조직에 속하지 않습니다.' using errcode = 'P0001';
    elsif v_constraint = 'application_requests_credential_tenant_muni_fk' then
      raise exception '선택한 사이트 계정이 현재 조직·지자체 조합에 속하지 않습니다.' using errcode = 'P0001';
    else
      raise exception '요청 항목의 소유권 검증에 실패했습니다.' using errcode = 'P0001';
    end if;
  when unique_violation then
    raise exception '이미 동일한 자동 신청이 등록되어 있습니다.' using errcode = 'P0001';
end;
$$;

revoke all on function create_application_request(uuid, uuid, uuid, uuid, uuid, jsonb, text, int) from public;
grant execute on function create_application_request(uuid, uuid, uuid, uuid, uuid, jsonb, text, int) to authenticated;
