-- youni: 현수막 게시대 자동 신청 SaaS — 초기 스키마 + RLS
-- 실행: supabase db push 또는 SQL 에디터에서 순서대로 실행

create extension if not exists "pgcrypto";

-- =========================================================
-- 1. 테넌시
-- =========================================================
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);

create table tenant_members (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

-- RLS 정책에서 재사용하는 멤버십 조회 함수 (RLS 재귀 방지 위해 security definer)
create or replace function auth_tenant_ids()
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  select tenant_id from tenant_members where user_id = auth.uid();
$$;

-- =========================================================
-- 2. 공용: 지자체 레지스트리 (write는 service_role만)
-- =========================================================
create table municipalities (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,             -- 'hwaseong'
  name text not null,                    -- '화성시'
  -- 게시대 운영은 대부분 지자체가 직접 하지 않고 수탁 기관에 위임한다:
  --   city: 지자체 직영 / association: 옥외광고협회 지회
  --   welfare_org: 장애인 단체 등 복지단체 수탁 (화성시 등)
  --   private: 민간 대행사
  operator_type text not null default 'welfare_org' check (operator_type in ('city', 'association', 'welfare_org', 'private')),
  operator_name text,                    -- 실제 수탁 기관명 (예: 'OO장애인협회 화성시지회')
  operator_contact text,                 -- 수탁 기관 연락처 (문의/분쟁 대응용)
  site_url text not null,
  adapter_key text not null,             -- packages/adapters 레지스트리 키
  adapter_version int not null default 1,
  status text not null default 'beta' check (status in ('active', 'beta', 'broken', 'disabled')),
  capabilities jsonb not null default '{"autoSubmit": false, "onlinePayment": false, "captchaType": "unknown"}',
  created_at timestamptz not null default now()
);

create table board_sites (
  id uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references municipalities(id) on delete cascade,
  external_id text not null,             -- 사이트 내부 게시대 ID
  name text not null,                    -- '동탄역 사거리'
  address text,
  lat double precision,
  lng double precision,
  slot_count int,
  fee int,                               -- 원
  dimensions_cm jsonb,                   -- {"width":500,"height":70}
  raw jsonb,
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (municipality_id, external_id)
);

create table municipality_specs (
  id uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references municipalities(id) on delete cascade,
  version int not null,
  spec jsonb not null,                   -- DesignSpec (packages/core)
  window_rule jsonb,                     -- WindowRule
  source_url text,
  effective_from date not null default current_date,
  created_at timestamptz not null default now(),
  unique (municipality_id, version)
);

create table application_windows (
  id uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references municipalities(id) on delete cascade,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  target_period_start date not null,
  target_period_end date not null,
  selection_method text not null default 'lottery' check (selection_method in ('lottery', 'fcfs')),
  result_expected_at timestamptz,
  source text not null default 'rule' check (source in ('rule', 'crawled', 'manual')),
  status text not null default 'upcoming' check (status in ('upcoming', 'open', 'closed', 'results_out')),
  created_at timestamptz not null default now(),
  unique (municipality_id, opens_at)
);

create index idx_windows_opens on application_windows (status, opens_at);

-- =========================================================
-- 3. 테넌트 데이터
-- =========================================================
create table advertiser_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  business_name text not null,
  biz_reg_no text,
  representative text,
  phone text not null,
  email text,
  address text,
  created_at timestamptz not null default now()
);

create table site_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  municipality_id uuid not null references municipalities(id) on delete cascade,
  username text not null,
  password_enc text not null,            -- base64(ciphertext+tag), AES-256-GCM
  enc_iv text not null,                  -- base64(iv)
  status text not null default 'unverified' check (status in ('unverified', 'ok', 'invalid', 'locked')),
  last_login_ok_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, municipality_id, username)
);

create table designs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  storage_path text not null,            -- Supabase Storage 'designs' 버킷 경로
  file_name text not null,
  file_meta jsonb not null default '{}', -- {widthPx, heightPx, sizeBytes}
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table design_validations (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references designs(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  municipality_id uuid not null references municipalities(id) on delete cascade,
  spec_version int not null,
  verdict text not null check (verdict in ('pass', 'warn', 'fail')),
  findings jsonb not null default '[]',  -- DesignFinding[]
  model text,
  raw_response jsonb,
  created_at timestamptz not null default now(),
  unique (design_id, municipality_id, spec_version)
);

create table application_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  municipality_id uuid not null references municipalities(id) on delete cascade,
  profile_id uuid not null references advertiser_profiles(id),
  credential_id uuid references site_credentials(id),
  design_id uuid not null references designs(id),
  board_preferences jsonb not null default '[]',  -- BoardPreference[] (priority 순)
  max_entries int not null default 1 check (max_entries >= 1),
  recurrence text not null default 'monthly' check (recurrence in ('once', 'monthly')),
  status text not null default 'active' check (status in ('active', 'paused', 'expired')),
  created_at timestamptz not null default now()
);

create table submission_jobs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references application_requests(id) on delete cascade,
  window_id uuid not null references application_windows(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  status text not null default 'pending' check (status in
    ('pending', 'queued', 'running', 'awaiting_captcha', 'needs_manual', 'submitted', 'failed', 'cancelled')),
  dry_run boolean not null default false,
  queued_for timestamptz,                -- 창구 오픈 시각
  submitted_at timestamptz,
  receipt_no text,
  selected_board_site_id uuid references board_sites(id),
  error_code text,
  error_detail text,
  bullmq_job_id text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (request_id, window_id)         -- 중복 신청 원천 차단
);

create index idx_jobs_status on submission_jobs (status, queued_for);
create index idx_jobs_tenant on submission_jobs (tenant_id, created_at desc);

create table submission_attempts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references submission_jobs(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  attempt_no int not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text,                          -- SubmissionErrorCode 또는 'ok'
  step_reached text,                     -- 마지막 audit.step 이름
  error_detail text,
  screenshots jsonb not null default '[]',  -- storage 경로 배열
  html_snapshot_path text,
  unique (job_id, attempt_no)
);

create table captcha_relays (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references submission_jobs(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  image_path text not null,              -- storage 경로
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  answered_at timestamptz,
  answer text,
  status text not null default 'waiting' check (status in ('waiting', 'answered', 'expired', 'cancelled'))
);

create index idx_captcha_waiting on captcha_relays (status, expires_at);

create table results (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references application_windows(id) on delete cascade,
  municipality_id uuid not null references municipalities(id) on delete cascade,
  board_site_id uuid references board_sites(id),
  raw_row jsonb not null,
  matched_job_id uuid references submission_jobs(id),
  match_confidence text check (match_confidence in ('exact', 'fuzzy', 'manual')),
  outcome text check (outcome in ('selected', 'rejected')),
  reviewed boolean not null default false,  -- 관리자 확인 큐 통과 여부
  crawled_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid references auth.users(id),
  channel text not null check (channel in ('email', 'webpush', 'alimtalk')),
  type text not null,
  ref_id uuid,                           -- 관련 job/result/window id
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  -- 멱등키: user_id가 null(테넌트 전체 알림)이어도 중복이 막히도록 nulls not distinct
  unique nulls not distinct (type, ref_id, channel, user_id)
);

create table crawl_runs (
  id uuid primary key default gen_random_uuid(),
  municipality_id uuid not null references municipalities(id) on delete cascade,
  kind text not null check (kind in ('boards', 'schedule', 'spec', 'results', 'health')),
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  diff_summary jsonb,
  error_detail text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

-- =========================================================
-- 4. updated_at 트리거
-- =========================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_jobs_updated before update on submission_jobs
  for each row execute function set_updated_at();

-- =========================================================
-- 5. RLS
-- =========================================================
alter table tenants enable row level security;
alter table tenant_members enable row level security;
alter table municipalities enable row level security;
alter table board_sites enable row level security;
alter table municipality_specs enable row level security;
alter table application_windows enable row level security;
alter table advertiser_profiles enable row level security;
alter table site_credentials enable row level security;
alter table designs enable row level security;
alter table design_validations enable row level security;
alter table application_requests enable row level security;
alter table submission_jobs enable row level security;
alter table submission_attempts enable row level security;
alter table captcha_relays enable row level security;
alter table results enable row level security;
alter table notifications enable row level security;
alter table crawl_runs enable row level security;

-- 테넌시 자체
-- 테넌트 생성은 create_tenant_with_owner() RPC로만 (직접 insert 정책 없음 —
-- RLS 하 self-join 우회로 남의 테넌트에 가입하는 취약점 방지)
create policy tenants_select on tenants for select
  using (id in (select auth_tenant_ids()));
create policy tenants_update on tenants for update
  using (id in (select tenant_id from tenant_members where user_id = auth.uid() and role = 'owner'));

create policy members_select on tenant_members for select
  using (tenant_id in (select auth_tenant_ids()));
-- 멤버 추가는 해당 테넌트 owner만 (첫 멤버는 RPC가 security definer로 생성)
create policy members_insert on tenant_members for insert
  with check (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid() and role = 'owner')
  );
create policy members_delete on tenant_members for delete
  using (tenant_id in (select tenant_id from tenant_members where user_id = auth.uid() and role = 'owner'));

-- 온보딩: 테넌트 + 본인 owner 멤버십을 한 트랜잭션으로 생성.
-- security definer라 RLS를 우회하며, 반환값이 RLS select에 막히는 문제도 없음.
create or replace function create_tenant_with_owner(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'tenant name required';
  end if;
  insert into tenants (name) values (trim(p_name)) returning id into v_tenant;
  insert into tenant_members (tenant_id, user_id, role) values (v_tenant, auth.uid(), 'owner');
  return v_tenant;
end;
$$;

revoke all on function create_tenant_with_owner(text) from public;
grant execute on function create_tenant_with_owner(text) to authenticated;

-- 공용 레지스트리: 로그인 사용자 read, write는 service_role(RLS 우회)만
create policy municipalities_read on municipalities for select using (auth.uid() is not null);
create policy board_sites_read on board_sites for select using (auth.uid() is not null);
create policy specs_read on municipality_specs for select using (auth.uid() is not null);
create policy windows_read on application_windows for select using (auth.uid() is not null);

-- 테넌트 데이터 표준 정책
create policy profiles_all on advertiser_profiles for all
  using (tenant_id in (select auth_tenant_ids()))
  with check (tenant_id in (select auth_tenant_ids()));

create policy credentials_all on site_credentials for all
  using (tenant_id in (select auth_tenant_ids()))
  with check (tenant_id in (select auth_tenant_ids()));

create policy designs_all on designs for all
  using (tenant_id in (select auth_tenant_ids()))
  with check (tenant_id in (select auth_tenant_ids()));

create policy validations_select on design_validations for select
  using (tenant_id in (select auth_tenant_ids()));

create policy requests_all on application_requests for all
  using (tenant_id in (select auth_tenant_ids()))
  with check (tenant_id in (select auth_tenant_ids()));

-- 잡/증적은 사용자 read-only (쓰기는 worker service_role)
create policy jobs_select on submission_jobs for select
  using (tenant_id in (select auth_tenant_ids()));
create policy attempts_select on submission_attempts for select
  using (tenant_id in (select auth_tenant_ids()));

-- 캡차 릴레이: read + 답변 update만 허용
create policy captcha_select on captcha_relays for select
  using (tenant_id in (select auth_tenant_ids()));
create policy captcha_answer on captcha_relays for update
  using (tenant_id in (select auth_tenant_ids()) and status = 'waiting')
  with check (tenant_id in (select auth_tenant_ids()));

-- 결과: 내 잡에 매칭된 행만 노출 (미매칭 행은 운영자 전용)
create policy results_select on results for select
  using (matched_job_id in (select id from submission_jobs where tenant_id in (select auth_tenant_ids())));

create policy notifications_select on notifications for select
  using (tenant_id in (select auth_tenant_ids()));

-- crawl_runs는 운영자(service_role) 전용 — 사용자 정책 없음

-- =========================================================
-- 6. Storage 버킷
-- =========================================================
insert into storage.buckets (id, name, public) values
  ('designs', 'designs', false),
  ('audit', 'audit', false),
  ('captcha', 'captcha', false)
on conflict (id) do nothing;

-- 경로 규약: {bucket}/{tenant_id}/... — 첫 폴더가 tenant_id
create policy storage_designs_rw on storage.objects for all
  using (bucket_id = 'designs' and (storage.foldername(name))[1]::uuid in (select auth_tenant_ids()))
  with check (bucket_id = 'designs' and (storage.foldername(name))[1]::uuid in (select auth_tenant_ids()));

create policy storage_audit_read on storage.objects for select
  using (bucket_id = 'audit' and (storage.foldername(name))[1]::uuid in (select auth_tenant_ids()));

create policy storage_captcha_read on storage.objects for select
  using (bucket_id = 'captcha' and (storage.foldername(name))[1]::uuid in (select auth_tenant_ids()));
