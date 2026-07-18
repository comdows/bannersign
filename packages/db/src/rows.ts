import type {
  BoardPreference,
  DesignFinding,
  DesignSpec,
  DesignVerdict,
  MunicipalityCapabilities,
  MunicipalityStatus,
  SelectionMethod,
  SubmissionJobStatus,
  WindowRule,
} from "@youni/core";

/**
 * DB row 타입 — supabase/migrations/0001_init.sql과 수동 동기화.
 * (추후 `supabase gen types typescript`로 대체 가능하나, jsonb 컬럼에
 *  도메인 타입을 입히기 위해 당분간 수동 유지)
 */

export interface MunicipalityRow {
  id: string;
  code: string;
  name: string;
  operator_type: "association" | "private" | "city";
  site_url: string;
  adapter_key: string;
  adapter_version: number;
  status: MunicipalityStatus;
  capabilities: MunicipalityCapabilities;
  created_at: string;
}

export interface BoardSiteRow {
  id: string;
  municipality_id: string;
  external_id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  slot_count: number | null;
  fee: number | null;
  dimensions_cm: { width: number; height: number } | null;
  raw: Record<string, unknown> | null;
  is_active: boolean;
  last_seen_at: string;
  created_at: string;
}

export interface MunicipalitySpecRow {
  id: string;
  municipality_id: string;
  version: number;
  spec: DesignSpec;
  window_rule: WindowRule | null;
  source_url: string | null;
  effective_from: string;
  created_at: string;
}

export interface ApplicationWindowRow {
  id: string;
  municipality_id: string;
  opens_at: string;
  closes_at: string;
  target_period_start: string;
  target_period_end: string;
  selection_method: SelectionMethod;
  result_expected_at: string | null;
  source: "rule" | "crawled" | "manual";
  status: "upcoming" | "open" | "closed" | "results_out";
  created_at: string;
}

export interface TenantRow {
  id: string;
  name: string;
  plan: string;
  created_at: string;
}

export interface AdvertiserProfileRow {
  id: string;
  tenant_id: string;
  business_name: string;
  biz_reg_no: string | null;
  representative: string | null;
  phone: string;
  email: string | null;
  address: string | null;
  created_at: string;
}

export interface SiteCredentialRow {
  id: string;
  tenant_id: string;
  municipality_id: string;
  username: string;
  password_enc: string;
  enc_iv: string;
  status: "unverified" | "ok" | "invalid" | "locked";
  last_login_ok_at: string | null;
  created_at: string;
}

export interface DesignRow {
  id: string;
  tenant_id: string;
  storage_path: string;
  file_name: string;
  file_meta: { widthPx?: number; heightPx?: number; sizeBytes?: number };
  uploaded_by: string | null;
  created_at: string;
}

export interface DesignValidationRow {
  id: string;
  design_id: string;
  tenant_id: string;
  municipality_id: string;
  spec_version: number;
  verdict: DesignVerdict;
  findings: DesignFinding[];
  model: string | null;
  raw_response: unknown;
  created_at: string;
}

export interface ApplicationRequestRow {
  id: string;
  tenant_id: string;
  municipality_id: string;
  profile_id: string;
  credential_id: string | null;
  design_id: string;
  board_preferences: BoardPreference[];
  max_entries: number;
  recurrence: "once" | "monthly";
  status: "active" | "paused" | "expired";
  created_at: string;
}

export interface SubmissionJobRow {
  id: string;
  request_id: string;
  window_id: string;
  tenant_id: string;
  status: SubmissionJobStatus;
  dry_run: boolean;
  queued_for: string | null;
  submitted_at: string | null;
  receipt_no: string | null;
  selected_board_site_id: string | null;
  error_code: string | null;
  error_detail: string | null;
  bullmq_job_id: string | null;
  updated_at: string;
  created_at: string;
}

export interface SubmissionAttemptRow {
  id: string;
  job_id: string;
  tenant_id: string;
  attempt_no: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  step_reached: string | null;
  error_detail: string | null;
  screenshots: string[];
  html_snapshot_path: string | null;
}

export interface CaptchaRelayRow {
  id: string;
  job_id: string;
  tenant_id: string;
  image_path: string;
  requested_at: string;
  expires_at: string;
  answered_at: string | null;
  answer: string | null;
  status: "waiting" | "answered" | "expired" | "cancelled";
}

export interface ResultRow {
  id: string;
  window_id: string;
  municipality_id: string;
  board_site_id: string | null;
  raw_row: Record<string, unknown>;
  matched_job_id: string | null;
  match_confidence: "exact" | "fuzzy" | "manual" | null;
  outcome: "selected" | "rejected" | null;
  reviewed: boolean;
  crawled_at: string;
}

export interface NotificationRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  channel: "email" | "webpush" | "alimtalk";
  type: string;
  ref_id: string | null;
  payload: Record<string, unknown>;
  status: "pending" | "sent" | "failed";
  sent_at: string | null;
  created_at: string;
}
