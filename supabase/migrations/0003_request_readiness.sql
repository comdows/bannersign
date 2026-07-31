-- youni: 자동 신청 준비도(readiness) 게이트 (S02)
-- ---------------------------------------------------------------------------
-- 목적:
--   "자동 제출 조건이 하나라도 부족한 요청"이 active 자동 신청이 되거나
--   submission_job 으로 진입하지 못하게 DB 계층에서 강제한다. UI 나 server
--   action 을 우회한 직접 REST insert/update 도 이 게이트를 통과하지 못한다.
--
-- 준비 조건(= packages/core/src/readiness.ts checkRequestReadiness 와 1:1):
--   1. municipality.status = 'active'
--   2. municipality.capabilities.autoSubmit = true
--   3. credential 존재 + 동일 tenant/municipality(S01) + status 가 invalid/locked 아님
--   4. profile.business_name / phone 이 공백 아님
--   5. 해당 지자체 최신 municipality_specs.version 존재
--   6. 선택 design 에 그 최신 버전 design_validation 존재 + verdict != 'fail'
--   7. board_preferences 가 1개 이상 + 모두 존재·해당 지자체·is_active
--
-- 설계 선택(불완전 요청 취급):
--   불완전 요청은 "assisted-manual 기록" 으로 보존하지 않고 DB 행을 만들지 않는다.
--   (별도 mode 컬럼/scheduler 영구 제외를 두지 않는다.) UI 는 체크리스트로 무엇이
--   부족한지 안내만 한다. → 중간 상태의 unsafe job 이 생길 여지가 없다.
--
-- 강제 지점:
--   A) application_requests: status='active' 로 insert/update 되는 순간
--      request_readiness_issue() 가 검사 → 부족하면 예외로 거부.
--      (paused/expired 등 비활성 행은 게이트 대상 아님 — 스케줄러가 active 만 집는다.)
--   B) create_application_request RPC: 위 트리거 예외를 사용자 친화적 한국어로 변환.
--      (S01 의 멤버십/참조 무결성/ search_path / revoke·grant 유지.)
--   C) submission_jobs: recurrence='once' 요청은 첫 job insert 와 동일 트랜잭션에서
--      원자적으로 status='expired' 전이(멱등). monthly 는 유지.
--   ※ submission_jobs insert 자체의 준비도 재검증은 scheduler(prepareSubmissionJobs)
--      가 service-role 로 "명시적으로" 수행한다(RLS 에 의존하지 않음). DB 트리거로
--      중복 강제하지 않는 이유: 시간에 따라 변하는 조건이라 이미 생성된 요청도
--      실행 직전 재검증이 필요하고, 그 권위 지점을 scheduler 로 단일화한다.
--
-- ---------------------------------------------------------------------------
-- 사전검사 / 롤백 위험:
--   * 기존 active 요청 중 지금 기준으로 준비 부족인 행이 있으면 NOTICE 로
--     "몇 건" 인지 보고한다(HARD-FAIL 아님). 준비도는 시간에 따라 변하는 값이라
--     마이그레이션을 막기보다, scheduler 재검증이 런타임에 job 생성을 차단한다.
--     운영자는 필요 시 해당 요청을 정리/보완하면 된다.
--   * 롤백: down 스크립트 없음. 되돌리려면 아래 트리거/함수를 DROP 하면 되며
--     데이터 손실 없음(구조 변경·컬럼 추가 없음). RPC 는 0002 정의를 다시 적용해
--     복원한다.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1단계. 준비도 판정 함수 — 첫 실패 issue code 반환(없으면 null)
--   application_requests 행 하나를 받아 DB 를 조회해 판정한다.
-- ===========================================================================
create or replace function request_readiness_issue(r application_requests)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_muni municipalities;
  v_cred site_credentials;
  v_profile advertiser_profiles;
  v_latest int;
  v_verdict text;
  v_board_count int;
  v_bad_boards int;
begin
  -- 1·2. 지자체 active + autoSubmit
  select * into v_muni from municipalities where id = r.municipality_id;
  if v_muni.id is null or v_muni.status <> 'active' then
    return 'municipality_inactive';
  end if;
  if coalesce((v_muni.capabilities->>'autoSubmit')::boolean, false) is not true then
    return 'autosubmit_unavailable';
  end if;

  -- 3. credential 존재 + tenant/municipality 일치 + 사용 가능 상태
  if r.credential_id is null then
    return 'credential_missing';
  end if;
  select * into v_cred from site_credentials where id = r.credential_id;
  if v_cred.id is null then
    return 'credential_missing';
  end if;
  if v_cred.tenant_id <> r.tenant_id or v_cred.municipality_id <> r.municipality_id then
    return 'credential_mismatch';
  end if;
  if v_cred.status in ('invalid', 'locked') then
    return 'credential_unusable';
  end if;

  -- 4. profile 필수값
  select * into v_profile from advertiser_profiles where id = r.profile_id;
  if v_profile.id is null
     or coalesce(btrim(v_profile.business_name), '') = ''
     or coalesce(btrim(v_profile.phone), '') = '' then
    return 'profile_incomplete';
  end if;

  -- 5. 최신 spec 버전 존재
  select max(version) into v_latest from municipality_specs where municipality_id = r.municipality_id;
  if v_latest is null then
    return 'spec_missing';
  end if;

  -- 6. 최신 버전 검증 존재 + fail 아님
  select verdict into v_verdict
  from design_validations
  where design_id = r.design_id
    and municipality_id = r.municipality_id
    and spec_version = v_latest;
  if v_verdict is null then
    return 'validation_missing';
  end if;
  if v_verdict = 'fail' then
    return 'validation_failed';
  end if;

  -- 7. board 1개 이상 + 모두 존재·해당 지자체·활성
  select count(*) into v_board_count
  from jsonb_array_elements(coalesce(r.board_preferences, '[]'::jsonb)) bp;
  if v_board_count = 0 then
    return 'boards_missing';
  end if;
  select count(*) into v_bad_boards
  from jsonb_array_elements(coalesce(r.board_preferences, '[]'::jsonb)) bp
  where not exists (
    select 1 from board_sites bs
    where bs.id::text = (bp->>'boardSiteId')
      and bs.municipality_id = r.municipality_id
      and bs.is_active = true
  );
  if v_bad_boards > 0 then
    return 'board_invalid';
  end if;

  return null; -- 준비 완료
end;
$$;

-- ===========================================================================
-- 0단계. 사전검사 (NOTICE only) — 기존 active 요청 중 준비 부족 건수 보고
-- ===========================================================================
do $$
declare
  v_unready int;
begin
  select count(*) into v_unready
  from application_requests ar
  where ar.status = 'active'
    and request_readiness_issue(ar) is not null;
  if v_unready > 0 then
    raise notice '[readiness precheck] 기존 active 요청 중 준비 부족 % 건. scheduler 가 런타임에 job 생성을 차단하며, 필요 시 해당 요청을 보완/정리하라. 조회: select id, request_readiness_issue(application_requests) from application_requests where status=''active'';', v_unready;
  else
    raise notice '[readiness precheck] 준비 부족 active 요청 없음.';
  end if;
end $$;

-- ===========================================================================
-- A. application_requests 준비도 트리거 (status='active' 일 때만 강제)
--   트리거 이름을 'aa' 로 시작시켜 다른 application_requests 트리거보다 먼저
--   실행 → 친화적 READINESS 매핑이 우선 적용되도록.
-- ===========================================================================
create or replace function enforce_request_readiness()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_issue text;
begin
  if new.status = 'active' then
    v_issue := request_readiness_issue(new);
    if v_issue is not null then
      raise exception 'READINESS:%', v_issue using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_requests_aa_readiness
  before insert or update on application_requests
  for each row execute function enforce_request_readiness();

-- ===========================================================================
-- B. create_application_request RPC 교체 — S01 계약 유지 + 준비도 친화 매핑
--   (0002 정의를 안전하게 확장: 멤버십/참조무결성/ search_path / revoke·grant 유지)
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
  v_msg text;
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다.' using errcode = 'P0001';
  end if;

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
  when raise_exception then
    -- 준비도 트리거(READINESS:code) 를 한국어로 변환. 그 외 raise_exception
    -- (멤버십/필수값 등 이미 친화적 메시지)은 원본 그대로 재전파한다.
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'READINESS:%' then
      raise exception '%',
        case substr(v_msg, 11)
          when 'municipality_inactive' then '해당 지자체는 아직 자동 신청 대상이 아닙니다.'
          when 'autosubmit_unavailable' then '해당 지자체는 온라인 자동 제출을 지원하지 않습니다.'
          when 'credential_missing' then '자동 제출에는 해당 지자체 사이트 계정이 필요합니다.'
          when 'credential_mismatch' then '선택한 사이트 계정이 이 조직·지자체 조합에 속하지 않습니다.'
          when 'credential_unusable' then '사이트 계정 상태가 유효하지 않습니다. 재확인이 필요합니다.'
          when 'profile_incomplete' then '사업자 프로필의 상호명·연락처를 채워 주세요.'
          when 'spec_missing' then '지자체 규격 정보가 아직 수집되지 않았습니다.'
          when 'validation_missing' then '선택한 시안의 최신 규격 검증 결과가 없습니다.'
          when 'validation_failed' then '선택한 시안이 규격 검증에서 부적합 판정을 받았습니다.'
          when 'boards_missing' then '희망 게시대를 1개 이상 선택하세요.'
          when 'board_invalid' then '선택한 게시대 중 사용할 수 없는(타 지자체/비활성) 항목이 있습니다.'
          else '자동 신청 준비 조건을 충족하지 않습니다.'
        end
        using errcode = 'P0001';
    else
      raise;
    end if;
end;
$$;

revoke all on function create_application_request(uuid, uuid, uuid, uuid, uuid, jsonb, text, int) from public;
grant execute on function create_application_request(uuid, uuid, uuid, uuid, uuid, jsonb, text, int) to authenticated;

-- ===========================================================================
-- C. recurrence='once' → 첫 submission_job 생성과 동일 트랜잭션에서 expired 전이
--   AFTER INSERT 라 job 이 실제로 커밋되는 경로에서만 전이 → insert 성공 뒤
--   crash 나도 이미 원자적으로 expired. status<>'expired' 가드로 멱등.
--   unique(request_id,window_id) 중복 insert 는 실패해 트리거가 돌지 않지만,
--   최초 insert 트랜잭션에서 이미 expired 되었으므로 최종 상태는 항상 expired.
-- ===========================================================================
create or replace function expire_once_request_after_job()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update application_requests
     set status = 'expired'
   where id = new.request_id
     and recurrence = 'once'
     and status <> 'expired';
  return null; -- AFTER 트리거 반환값은 무시됨
end;
$$;

create trigger trg_jobs_expire_once
  after insert on submission_jobs
  for each row execute function expire_once_request_after_job();
