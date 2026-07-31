-- youni: D-1 사이트 계정 사전 점검 기록 — (window_id, credential_id) (S04)
-- ---------------------------------------------------------------------------
-- 목적:
--   창구 오픈 하루 전 사전 점검에서 "이 창구 × 이 사이트 계정" 조합의 로그인 점검이
--   이미 수행됐는지를 durable 하게 남긴다. 기존 스키마로는 부족하다:
--     * site_credentials.status/last_login_ok_at 은 계정 전역 상태라 "이 창구에서
--       이미 점검했다"를 표현하지 못한다(다른 창구/다른 시점 점검과 구분 불가).
--     * BullMQ jobId(precheck-<window>) 는 잡이 완료·제거되면 재사용 가능하고
--       attempts 재시도도 있어서, 그것만으로는 중복 로그인을 막지 못한다.
--   특히 invalid/locked 같은 terminal 실패 이후 재시도 잡이 같은 계정으로 반복
--   로그인하면 지자체 사이트의 로그인 시도 제한에 걸려 계정이 잠길 수 있다.
--
-- 모델:
--   unique (window_id, credential_id) 한 행이 "그 창구에서의 그 계정 점검"이다.
--     status='running'  점검 진행 중(클레임). 워커가 죽으면 stale 회수 대상.
--     status='ok'       로그인 성공 — terminal. 재로그인하지 않는다.
--     status='invalid'  자격 오류 — terminal.
--     status='locked'   계정 잠금/정지 — terminal.
--     status='error'    사이트/네트워크/복호화 오류 — 계정 잘못이 아니므로
--                       site_credentials.status 는 건드리지 않는다. 다만 "확인되지
--                       않은 계정"이므로 terminal 로 두고 그 창구의 잡은 수동 신청으로
--                       돌린다(재로그인 없음 — 로그인 시도 제한/계정 잠금 방지).
--   attempts 는 죽은 running 레코드 회수 횟수를 묶어 둔다(무한 재로그인 방지).
--   판정 규칙의 코드 쪽 단일 소스는 packages/core/src/precheck.ts
--   (planCredentialPrecheck / PRECHECK_STALE_MS / PRECHECK_MAX_ATTEMPTS) 다.
--
-- 저장 정책(비밀 노출 금지):
--   이 표에는 비밀번호·세션쿠키·어댑터 원문 메시지를 저장하지 않는다.
--   outcome_code 는 안정 코드, outcome_detail 은 PRECHECK_MESSAGES 고정 문구만
--   기록한다(사용자에게 그대로 보여도 안전한 값).
--
-- ---------------------------------------------------------------------------
-- 사전검사 / 롤백 위험:
--   * 신규 테이블만 추가한다. 기존 행 변경 없음 → HARD-FAIL 사전검사 불필요.
--     이미 같은 이름의 테이블이 있으면(부분 적용 재실행) EXCEPTION 으로 알린다.
--   * 롤백: drop table credential_prechecks;
--          alter table application_windows drop constraint application_windows_id_muni_key;
--     (데이터 손실은 점검 이력뿐이며 제품 동작은 "점검 기록 없음 = 다시 점검"으로
--      안전하게 되돌아간다. application_windows 의 (id, municipality_id) unique 는
--      id 가 PK 라 항상 성립하므로 추가/삭제 모두 기존 행에 영향이 없다.)
--   * 애플리케이션 호환: worker 가 이 표를 읽지 못하면 사전 점검이 fail-closed 로
--     실패(잡 재시도)하므로, 반드시 worker 배포 전에 적용한다.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'credential_prechecks') then
    raise exception '[precheck] credential_prechecks 테이블이 이미 존재한다. 0005 가 이미 적용됐는지 확인 후 진행하라.';
  end if;
  raise notice '[precheck] credential_prechecks 신규 생성 — 기존 데이터 영향 없음.';
end $$;

create table credential_prechecks (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references application_windows(id) on delete cascade,
  credential_id uuid not null references site_credentials(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  municipality_id uuid not null references municipalities(id) on delete cascade,
  status text not null default 'running'
    check (status in ('running', 'ok', 'invalid', 'locked', 'error')),
  -- 안정 오류 코드(SubmissionErrorCode 호환) — 원문 메시지 저장 금지
  outcome_code text,
  -- 사용자에게 그대로 노출 가능한 고정 문구만 (PRECHECK_MESSAGES)
  outcome_detail text,
  attempts int not null default 1 check (attempts >= 1),
  last_attempt_at timestamptz not null default now(),
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  -- 핵심: 창구 × 계정 당 한 행 → 중복/재시도 잡의 반복 로그인 차단
  unique (window_id, credential_id)
);

create index idx_credential_prechecks_window on credential_prechecks (window_id, status);
create index idx_credential_prechecks_tenant on credential_prechecks (tenant_id, created_at desc);

-- (window, credential) 은 같은 tenant/municipality 소속이어야 한다는 것을 이 표에서도
-- 재확인한다. S01(0002) 의 복합 FK 와 같은 원칙 — 오염 데이터가 점검 기록으로도
-- 남지 않게 한다. site_credentials 는 0002 에서 (id, tenant_id, municipality_id)
-- 복합 unique 를 갖고, application_windows 는 (id, municipality_id) 를 갖는다.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'site_credentials_id_tenant_muni_key') then
    raise exception '[precheck] site_credentials 복합 unique(0002) 가 없다. 0002 를 먼저 적용하라.';
  end if;
end $$;

-- application_windows 쪽 참조 대상 키 (id 는 이미 PK 이므로 데이터 영향 없는 추가)
alter table application_windows
  add constraint application_windows_id_muni_key unique (id, municipality_id);

alter table credential_prechecks
  add constraint credential_prechecks_credential_fk
  foreign key (credential_id, tenant_id, municipality_id)
  references site_credentials (id, tenant_id, municipality_id) on delete cascade;

alter table credential_prechecks
  add constraint credential_prechecks_window_fk
  foreign key (window_id, municipality_id)
  references application_windows (id, municipality_id) on delete cascade;

-- =========================================================
-- RLS — 사용자는 자기 테넌트 점검 결과를 읽기만, 쓰기는 worker(service_role) 전용
-- =========================================================
alter table credential_prechecks enable row level security;

create policy credential_prechecks_select on credential_prechecks for select
  using (tenant_id in (select auth_tenant_ids()));

-- insert/update/delete 정책 없음 → authenticated 는 쓰기 불가(service_role 만 우회).
