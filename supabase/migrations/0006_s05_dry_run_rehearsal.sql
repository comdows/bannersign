-- youni: 화성 dry-run 리허설의 DB 계약 (S05)
-- ---------------------------------------------------------------------------
-- live 제출과 리허설을 요청 단계부터 구분하고, beta 지자체에서는 최종 제출로
-- 승격될 수 없는 1회성 dry-run 만 허용한다. 리허설 성공은 submitted 와 분리된
-- terminal 상태 및 시각으로 기록하며 단계별 audit 증적을 attempt 에 보존한다.

-- 1. 요청은 명시적으로 dry-run 전용일 수 있다. 반복 리허설은 허용하지 않는다.
alter table application_requests
  add column dry_run_only boolean not null default false;

alter table application_requests
  add constraint application_requests_dry_run_once_check
  check (dry_run_only is not true or recurrence = 'once');

-- 2. 리허설 완료는 제출 완료와 별개의 terminal 상태다.
alter table submission_jobs
  add column dry_run_completed_at timestamptz;

alter table submission_jobs
  drop constraint submission_jobs_status_check;

alter table submission_jobs
  add constraint submission_jobs_status_check check (status in
    ('pending', 'queued', 'running', 'awaiting_captcha', 'needs_manual', 'submitted',
     'dry_run_completed', 'failed', 'cancelled'));

-- 완료 상태/시각은 항상 함께 존재한다. dry-run 완료 행에는 실접수 흔적이 없어야 한다.
alter table submission_jobs
  add constraint submission_jobs_dry_run_completed_consistency check (
    (
      status = 'dry_run_completed'
      and dry_run_completed_at is not null
      and dry_run = true
      and submitted_at is null
      and receipt_no is null
      and selected_board_site_id is not null
    )
    or
    (
      status <> 'dry_run_completed'
      and dry_run_completed_at is null
    )
  );

-- 3. 각 의미 단계의 URL/시각/스크린샷/HTML 경로를 구조화해 저장한다.
alter table submission_attempts
  add column audit_events jsonb not null default '[]'::jsonb;

alter table submission_attempts
  add constraint submission_attempts_audit_events_array_check
  check (jsonb_typeof(audit_events) = 'array');

-- 4. 준비도 권위 함수: live=active 전용, dry-run=active|beta. broken/disabled 및
--    autoSubmit=false 는 모드와 관계없이 차단한다. 나머지 준비 조건은 S02와 동일하다.
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
  select * into v_muni from municipalities where id = r.municipality_id;
  if v_muni.id is null
     or not (
       v_muni.status = 'active'
       or (r.dry_run_only = true and v_muni.status = 'beta')
     ) then
    return 'municipality_inactive';
  end if;
  if coalesce((v_muni.capabilities->>'autoSubmit')::boolean, false) is not true then
    return 'autosubmit_unavailable';
  end if;

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

  select * into v_profile from advertiser_profiles where id = r.profile_id;
  if v_profile.id is null
     or coalesce(btrim(v_profile.business_name), '') = ''
     or coalesce(btrim(v_profile.phone), '') = '' then
    return 'profile_incomplete';
  end if;

  select max(version) into v_latest
  from municipality_specs
  where municipality_id = r.municipality_id;
  if v_latest is null then
    return 'spec_missing';
  end if;

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

  return null;
end;
$$;

-- 5. 기존 RPC와 오버로드를 함께 남기면 PostgREST 호출 해석이 모호해진다.
--    8인자 함수를 제거하고, 마지막 기본 인자만 추가한 단일 함수로 교체한다.
drop function create_application_request(uuid, uuid, uuid, uuid, uuid, jsonb, text, int);

create function create_application_request(
  p_tenant_id uuid,
  p_municipality_id uuid,
  p_profile_id uuid,
  p_design_id uuid,
  p_credential_id uuid default null,
  p_board_preferences jsonb default '[]'::jsonb,
  p_recurrence text default 'monthly',
  p_max_entries int default 1,
  p_dry_run_only boolean default false
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
    board_preferences, recurrence, max_entries, dry_run_only
  ) values (
    p_tenant_id, p_municipality_id, p_profile_id, p_credential_id,
    p_design_id, coalesce(p_board_preferences, '[]'::jsonb),
    case
      when coalesce(p_dry_run_only, false) then 'once'
      else coalesce(p_recurrence, 'monthly')
    end,
    coalesce(p_max_entries, 1), coalesce(p_dry_run_only, false)
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
    get stacked diagnostics v_msg = message_text;
    if v_msg like 'READINESS:%' then
      raise exception '%',
        case substr(v_msg, 11)
          when 'municipality_inactive' then '해당 지자체는 이 신청 모드의 대상이 아닙니다.'
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

revoke all on function create_application_request(uuid, uuid, uuid, uuid, uuid, jsonb, text, int, boolean) from public;
grant execute on function create_application_request(uuid, uuid, uuid, uuid, uuid, jsonb, text, int, boolean) to authenticated;
