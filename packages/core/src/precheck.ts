/**
 * D-1 사이트 계정 사전 점검(precheck) — 순수 판정 + 포트 주입 오케스트레이션 (S04).
 *
 * 창구 오픈 하루 전에 (1) 지자체 사이트 자체가 살아있는지(healthCheck), (2) 그 창구에
 * 걸린 각 사이트 계정으로 실제 로그인이 되는지를 확인한다. 창구가 열린 뒤에야
 * "비밀번호가 틀렸다"를 알게 되는 상황을 막는 것이 목적이다.
 *
 * 설계 원칙
 *   - fail-closed: 사이트 점검 실패 = 그 창구의 pending/queued 잡 전부 needs_manual.
 *     DB 조회/쓰기 오류는 "대상 없음"이 아니라 오류로 전파한다(포트 구현이 throw).
 *   - 계정 단위 격리: 한 계정의 실패가 다른 계정 점검을 멈추지 않는다.
 *   - 로그인 1회/계정: 같은 계정을 여러 요청이 공유해도 점검 1회당 로그인은 1번.
 *   - 비밀 노출 금지: 이 모듈은 비밀번호/쿠키를 절대 다루지 않는다. 로그인은
 *     ports.login(credentialId) 뒤에 있고, 저장/알림 문구는 고정 메시지 표뿐이다.
 *   - 재시도 안전: (window, credential) 단위 durable 레코드(credential_prechecks,
 *     migration 0005)로 중복/재시도 잡이 같은 계정에 반복 로그인하지 않게 한다.
 *     특히 invalid/locked 같은 terminal 실패 후에는 절대 재로그인하지 않는다.
 *
 * DB/Playwright/어댑터를 직접 만지지 않으므로(모두 PrecheckPorts 뒤) 가짜 포트로
 * 결정적 단위 테스트가 가능하다 — 실제 지자체 사이트에 접속하지 않는다.
 */

/** 사전 점검 알림 타입 — notifications.type (멱등키 (type, ref_id, channel, user_id)) */
export const PRECHECK_NOTIFICATION_TYPE = "precheck_failed";

/** 계정 로그인 점검 결과. 'error' 는 계정 잘못이 아닌 사이트/인프라 오류. */
export type PrecheckLoginOutcome = "ok" | "invalid" | "locked" | "error";

/** credential_prechecks.status — 'running' 은 점검 진행 중(클레임) */
export type PrecheckRecordStatus = PrecheckLoginOutcome | "running";

/** 'running' 레코드를 죽은 점검(워커 사망)으로 보고 회수하기까지의 시간 */
export const PRECHECK_STALE_MS = 15 * 60_000;

/** 같은 (window, credential) 에 허용하는 최대 로그인 시도 횟수 */
export const PRECHECK_MAX_ATTEMPTS = 3;

/** 사전 점검 잡 큐잉의 시간 버킷 — 1시간 (스케줄러 jobId 멱등키) */
export const PRECHECK_BUCKET_MS = 3600_000;

/**
 * 사전 점검 BullMQ jobId. 창구 id + 1시간 버킷.
 *
 * 버킷이 없으면 `precheck-<window>` 잡이 한 번 완료된 뒤(제거 전) 같은 창구에 대해
 * 다시 큐잉되지 않아, 첫 점검 이후 새로 만들어진 잡(D-1 이후 생성된 submission_job)이
 * 영영 점검되지 않는다. 버킷을 붙이면 매시간 한 번 다시 돌아 늦게 생긴 잡까지 덮되,
 * 같은 시간 안의 중복 큐잉은 계속 막는다.
 *
 * 반복 로그인은 이 jobId 가 아니라 credential_prechecks(window, credential) terminal
 * 레코드가 막는다 — 잡이 다시 돌아도 확정된 결과를 재적용할 뿐 재로그인하지 않는다.
 */
export function precheckJobId(windowId: string, nowMs: number): string {
  return `precheck-${windowId}-${Math.floor(nowMs / PRECHECK_BUCKET_MS)}`;
}

/**
 * 저장/사용자 노출 문구는 이 표에서만 나온다(자유 문자열 금지).
 * 어댑터 원문 메시지는 저장하지 않는다 — 세션/쿠키/입력값이 섞여 들어올 여지를 없앤다.
 */
export const PRECHECK_MESSAGES = {
  site_down: "지자체 사이트 사전 점검에 실패했습니다. 자동 신청을 진행할 수 없어 수동 신청 안내로 전환합니다.",
  invalid: "사이트 계정 로그인에 실패했습니다. 아이디·비밀번호를 다시 등록해 주세요.",
  locked:
    "사이트 계정이 잠금/정지 상태로 확인됐습니다. 지자체 사이트에서 계정을 복구한 뒤 다시 등록해 주세요.",
  error: "사전 점검 중 사이트 오류가 발생해 계정 확인을 마치지 못했습니다.",
  credential_missing: "사이트 계정이 등록되어 있지 않아 자동 제출을 진행할 수 없습니다.",
  reference_invalid: "신청 정보의 조직·지자체·계정 연결이 올바르지 않아 자동 제출을 중단했습니다.",
} as const;

/** 잡에 기록하는 오류 코드 — SubmissionErrorCode 와 호환되는 값만 쓴다. */
export const PRECHECK_ERROR_CODES = {
  site_down: "site_down",
  invalid: "login_failed",
  locked: "login_failed",
  /** 인프라/사이트 오류로 계정 확인을 마치지 못함 — 계정 잘못이 아니므로 login_failed 가 아니다 */
  error: "site_down",
  credential_missing: "login_failed",
  reference_invalid: "validation_rejected",
} as const;

// ---------------------------------------------------------------------------
// 순수 판정 1: 비밀 문자열 마스킹
// ---------------------------------------------------------------------------

/**
 * text 안의 secrets 를 '***' 로 치환하고 길이를 자른다.
 * 저장하지 않는 진단 로그에도 계정/비밀번호가 남지 않도록 마지막 방어선으로 쓴다.
 * (저장·알림 문구는 PRECHECK_MESSAGES 고정값만 사용한다.)
 */
export function redactSecrets(text: string, secrets: readonly string[], maxLength = 300): string {
  let out = text;
  // 긴 비밀부터 치환 — 짧은 값이 긴 값의 일부를 먼저 깨뜨리지 않게.
  for (const s of [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join("***");
  }
  // 제어문자 제거(로그 라인 오염 방지) 후 길이 제한
  out = [...out]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 0x20 || cp === 0x7f ? " " : ch;
    })
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

// ---------------------------------------------------------------------------
// 순수 판정 2: 로그인 실패 분류 (invalid vs locked)
// ---------------------------------------------------------------------------

/**
 * 계정 잠금/정지로 볼 수 있는 근거 문구. 어댑터가 이 문구를 남겼을 때만 'locked' 로
 * 승격하고, 근거가 없으면 최소 보장인 'invalid' 로 둔다.
 */
const LOCK_MARKERS = [
  "잠금",
  "잠겼",
  "잠금되",
  "정지",
  "차단",
  "사용중지",
  "이용정지",
  "locked",
  "lock",
  "suspend",
  "disabled",
  "blocked",
];

/** 계정 잘못이 아니라 사이트/네트워크 문제로 보는 어댑터 오류 코드 */
const SITE_ERROR_CODES = new Set([
  "network",
  "site_down",
  "not_open_yet",
  "captcha_timeout",
  "selector_missing",
]);

interface AdapterErrorLike {
  code?: unknown;
  message?: unknown;
}

/**
 * adapter.login 이 던진 오류를 점검 결과로 분류한다.
 *
 *   - code='login_failed' → 잠금 근거가 있으면 'locked', 없으면 'invalid'(최소 보장)
 *   - 사이트/네트워크 계열 코드 → 'error' (사용자 계정을 invalid 로 표시하지 않는다)
 *   - 코드 없는 일반 예외 → 'error' (근거 없이 사용자 계정을 탓하지 않는다)
 */
export function classifyLoginFailure(err: unknown): Exclude<PrecheckLoginOutcome, "ok"> {
  const e = (err ?? {}) as AdapterErrorLike;
  const code = typeof e.code === "string" ? e.code : null;
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";

  if (code === "login_failed") {
    return LOCK_MARKERS.some((m) => message.includes(m)) ? "locked" : "invalid";
  }
  if (code !== null && SITE_ERROR_CODES.has(code)) return "error";
  return "error";
}

/** 계정 자체의 결함(사용자가 조치해야 하는 실패)인가 */
export function isCredentialFault(outcome: PrecheckLoginOutcome): outcome is "invalid" | "locked" {
  return outcome === "invalid" || outcome === "locked";
}

// ---------------------------------------------------------------------------
// 순수 판정 3: 잡 → 계정 그룹핑 + 참조 검증
// ---------------------------------------------------------------------------

/** 점검 대상 후보 잡 — 호출자가 submission_jobs + application_requests + site_credentials 를 읽어 정규화 */
export interface PrecheckJobRow {
  jobId: string;
  tenantId: string;
  /** submission_jobs.status — pending/queued 만 대상 */
  status: string;
  requestId: string;
  /** application_requests 행 (없으면 null) */
  request: {
    id: string;
    tenant_id: string;
    municipality_id: string;
    credential_id: string | null;
  } | null;
  /** request.credential_id 로 읽은 site_credentials 행 (없으면 null) */
  credential: {
    id: string;
    tenant_id: string;
    municipality_id: string;
    status: string;
  } | null;
}

export interface CredentialGroup {
  credentialId: string;
  tenantId: string;
  municipalityId: string;
  /** 점검 시점의 site_credentials.status */
  credentialStatus: string;
  /** 이 계정에 걸린 pending/queued 잡 (입력 순서 유지) */
  jobs: Array<{ jobId: string; tenantId: string }>;
}

export interface RejectedPrecheckJob {
  jobId: string;
  tenantId: string;
  /** submission_jobs.error_code 로 저장할 값 */
  code: string;
  /** 저장/노출 문구 (PRECHECK_MESSAGES 고정값) */
  detail: string;
  /** 알림 payload 의 사유 코드 */
  reason: "credential_missing" | "reference_invalid";
}

export interface PrecheckGrouping {
  groups: CredentialGroup[];
  rejected: RejectedPrecheckJob[];
}

/** 자동 제출 큐로 나아갈 수 있는 잡 상태 — 이 상태의 잡만 사전 점검 대상이다. */
const PRECHECKABLE_JOB_STATUSES = new Set(["pending", "queued"]);

/**
 * 후보 잡을 "구분되는 계정" 단위로 묶는다. 같은 계정을 여러 요청이 공유하면
 * 그룹은 하나 — 점검 1회당 로그인 1번을 보장하는 근거가 여기다.
 *
 * 동시에 테넌트·지자체·계정 참조를 재검증한다(service_role 은 RLS 를 우회하므로
 * 코드 계층에서 명시적으로 막는다). 위반 잡은 로그인 대상에서 빼고 rejected 로 돌려
 * 호출자가 needs_manual + 알림 처리하게 한다.
 *
 * groups 는 credentialId 사전순으로 안정 정렬한다(테스트/로그 결정성).
 */
export function groupPrecheckJobsByCredential(
  jobs: readonly PrecheckJobRow[],
  ctx: { municipalityId: string },
): PrecheckGrouping {
  const groups = new Map<string, CredentialGroup>();
  const rejected: RejectedPrecheckJob[] = [];

  for (const job of jobs) {
    // pending/queued 가 아니면 사전 점검 대상이 아니다(이미 실행/종료된 잡).
    if (!PRECHECKABLE_JOB_STATUSES.has(job.status)) continue;

    const req = job.request;
    if (!req || req.tenant_id !== job.tenantId || req.municipality_id !== ctx.municipalityId) {
      rejected.push({
        jobId: job.jobId,
        tenantId: job.tenantId,
        code: PRECHECK_ERROR_CODES.reference_invalid,
        detail: PRECHECK_MESSAGES.reference_invalid,
        reason: "reference_invalid",
      });
      continue;
    }

    if (req.credential_id === null) {
      rejected.push({
        jobId: job.jobId,
        tenantId: job.tenantId,
        code: PRECHECK_ERROR_CODES.credential_missing,
        detail: PRECHECK_MESSAGES.credential_missing,
        reason: "credential_missing",
      });
      continue;
    }

    const cred = job.credential;
    if (!cred || cred.id !== req.credential_id) {
      rejected.push({
        jobId: job.jobId,
        tenantId: job.tenantId,
        code: PRECHECK_ERROR_CODES.credential_missing,
        detail: PRECHECK_MESSAGES.credential_missing,
        reason: "credential_missing",
      });
      continue;
    }

    if (cred.tenant_id !== job.tenantId || cred.municipality_id !== ctx.municipalityId) {
      rejected.push({
        jobId: job.jobId,
        tenantId: job.tenantId,
        code: PRECHECK_ERROR_CODES.reference_invalid,
        detail: PRECHECK_MESSAGES.reference_invalid,
        reason: "reference_invalid",
      });
      continue;
    }

    let group = groups.get(cred.id);
    if (!group) {
      group = {
        credentialId: cred.id,
        tenantId: cred.tenant_id,
        municipalityId: cred.municipality_id,
        credentialStatus: cred.status,
        jobs: [],
      };
      groups.set(cred.id, group);
    }
    group.jobs.push({ jobId: job.jobId, tenantId: job.tenantId });
  }

  return {
    groups: [...groups.values()].sort((a, b) => (a.credentialId < b.credentialId ? -1 : 1)),
    rejected,
  };
}

// ---------------------------------------------------------------------------
// 순수 판정 4: (window, credential) 점검 클레임/재시도 계획
// ---------------------------------------------------------------------------

/** credential_prechecks 행 스냅샷 (migration 0005) */
export interface PrecheckRecord {
  status: PrecheckRecordStatus;
  attempts: number;
  /** 마지막 시도 시각 ISO — 죽은 running 판정 기준 */
  lastAttemptAt: string;
  /** 결과가 확정된 시각 ISO (running 이면 null) */
  checkedAt?: string | null;
  /** 마지막 결과 코드 (있으면) */
  outcomeCode?: string | null;
}

export type PrecheckClaimAction =
  /** 지금 로그인 점검을 수행한다(신규 클레임 또는 죽은 running 회수) */
  | "claim"
  /** 이미 확정된 결과가 있다 — 재로그인 없이 결과만 다시 적용 */
  | "reapply_terminal"
  /** 다른 워커가 점검 중 */
  | "skip_running"
  /** 회수 시도 횟수 소진 — 더 이상 로그인하지 않고, 그 계정의 잡은 격리한다 */
  | "skip_exhausted";

export interface PrecheckClaimPlan {
  action: PrecheckClaimAction;
  /** reapply_terminal 일 때 확정된 결과 */
  outcome?: PrecheckLoginOutcome;
  /** 죽은 running 레코드를 회수하는 경우 true (CAS 갱신 필요) */
  reclaim: boolean;
}

/**
 * 같은 (window, credential) 에 대한 중복/재시도 사전 점검 잡이 반복 로그인하지
 * 않도록 다음 행동을 정한다.
 *
 *   - 레코드 없음                → claim (신규)
 *   - ok/invalid/locked/error    → reapply_terminal (재로그인 금지)
 *   - running + 시간 경과 X      → skip_running (다른 워커 진행 중)
 *   - running + 시도 소진        → skip_exhausted
 *   - running + 시간 경과 O      → claim(reclaim) — 죽은 점검 회수
 *
 * 'error'(사이트/인프라 오류)도 terminal 이다. 쿨다운 뒤 재로그인하던 예전 규칙은
 * 지웠다: 이제 error 도 그 계정의 잡을 needs_manual 로 격리하므로 다음 실행에는
 * 후보 잡 자체가 없고, 늦게 생긴 잡이 있더라도 같은 결과를 재적용하는 편이
 * "확인 안 된 계정으로 반복 로그인"보다 안전하다(로그인 시도 제한/계정 잠금 방지).
 * 사이트가 복구되면 사용자가 계정을 다시 등록하거나 운영자가 점검 레코드를 지운다.
 */
export function planCredentialPrecheck(
  existing: PrecheckRecord | null,
  opts: { nowMs: number; staleMs?: number; maxAttempts?: number },
): PrecheckClaimPlan {
  const staleMs = opts.staleMs ?? PRECHECK_STALE_MS;
  const maxAttempts = opts.maxAttempts ?? PRECHECK_MAX_ATTEMPTS;

  if (!existing) return { action: "claim", reclaim: false };

  if (existing.status !== "running") {
    return { action: "reapply_terminal", outcome: existing.status, reclaim: false };
  }

  if (existing.attempts >= maxAttempts) return { action: "skip_exhausted", reclaim: false };

  const last = Date.parse(existing.lastAttemptAt);
  // 시각을 파싱할 수 없으면 보수적으로 "방금"으로 본다(성급한 재로그인 금지).
  const elapsed = Number.isNaN(last) ? 0 : opts.nowMs - last;

  return elapsed >= staleMs
    ? { action: "claim", reclaim: true }
    : { action: "skip_running", reclaim: false };
}

// ---------------------------------------------------------------------------
// 오케스트레이션 (포트 주입)
// ---------------------------------------------------------------------------

export interface PrecheckHealthReport {
  ok: boolean;
  /** 실패한 점검 이름들 — 알림 payload 에는 이름만 넣는다(원문 detail 미저장) */
  failures: Array<{ check: string }>;
}

export interface PrecheckNotification {
  jobId: string;
  tenantId: string;
  payload: Record<string, unknown>;
}

/**
 * 사전 점검이 필요로 하는 외부 작용 전부. worker 가 Supabase/Playwright/어댑터로
 * 구현하고, 테스트는 가짜 구현을 주입한다.
 *
 * 계약: 모든 read/write 포트는 실패 시 throw 한다(빈 결과로 삼키지 않는다).
 */
export interface PrecheckPorts {
  loadWindow(windowId: string): Promise<{ id: string; municipality_id: string } | null>;
  loadMunicipality(municipalityId: string): Promise<{ id: string; adapter_key: string } | null>;
  /** 창구 단위 사이트 헬스체크 (기존 adapter.healthCheck 유지) */
  healthCheck(): Promise<PrecheckHealthReport>;
  markMunicipalityBroken(municipalityId: string): Promise<void>;
  /** 이 창구의 pending/queued 잡 + 조인된 request/credential 스냅샷 */
  loadCandidateJobs(windowId: string): Promise<PrecheckJobRow[]>;

  readPrecheck(windowId: string, credentialId: string): Promise<PrecheckRecord | null>;
  /** 신규 클레임 insert. 이미 행이 있으면(unique 충돌) false */
  claimPrecheck(input: {
    windowId: string;
    credentialId: string;
    tenantId: string;
    municipalityId: string;
    nowIso: string;
  }): Promise<boolean>;
  /**
   * 죽은 레코드 회수 CAS — 읽은 그대로(status, attempts)일 때만 running 으로 되돌리고
   * attempts 를 1 올린다. 경쟁에서 지면 false(= 다른 워커가 이미 잡았다 → 로그인 금지).
   */
  reclaimPrecheck(input: {
    windowId: string;
    credentialId: string;
    expectedStatus: PrecheckRecordStatus;
    expectedAttempts: number;
    nowIso: string;
  }): Promise<boolean>;
  /**
   * 점검 결과 확정 기록. CAS: 이번 실행이 잡고 있는 클레임(status='running' 이고
   * attempts = expectedAttempts)일 때만 기록한다. 0행이면 다른 워커가 회수해 갔거나
   * 행이 사라진 것이므로 throw 해야 한다(조용한 성공 = 재로그인 위험).
   */
  finishPrecheck(input: {
    windowId: string;
    credentialId: string;
    expectedAttempts: number;
    outcome: PrecheckLoginOutcome;
    code: string | null;
    detail: string | null;
    nowIso: string;
  }): Promise<void>;

  /**
   * 계정 하나로 로그인 시도. 구현은 계정마다 새 브라우저 컨텍스트/페이지를 열고,
   * 비밀번호는 이 호출 직전에만 복호화하며, 스크린샷/HTML 증적을 남기지 않는다.
   * 실패 시 throw (AdapterError 면 code 로 분류된다).
   */
  login(credentialId: string): Promise<void>;
  markCredentialStatus(
    credentialId: string,
    status: "ok" | "invalid" | "locked",
    nowIso: string,
  ): Promise<void>;

  /**
   * 잡을 needs_manual 로 전환 (code/detail 은 고정 문구).
   * 구현은 status='pending'|'queued' 가드를 걸어야 하며(그 사이 running/submitted 로
   * 넘어간 잡을 되돌리지 않는다), 실제로 갱신된 잡 id 만 돌려준다 — 요약에 "막았다"고
   * 남는 잡과 DB 상태가 어긋나지 않게.
   */
  markJobsNeedsManual(jobIds: string[], code: string, detail: string): Promise<string[]>;
  /** precheck_failed 알림 생성 — (type, ref_id, channel, user_id) 멱등 upsert */
  notifyPrecheckFailed(items: PrecheckNotification[]): Promise<void>;

  now(): number;
  log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

export interface PrecheckRunSummary {
  windowId: string;
  /** 창구/지자체가 없어 아무것도 하지 않음 */
  skipped: boolean;
  healthOk: boolean;
  /** 실제로 로그인을 시도한 계정 수 */
  loginsAttempted: number;
  /** credentialId → 이번 실행의 처리 결과 */
  outcomes: Record<string, PrecheckLoginOutcome | PrecheckClaimAction>;
  /** needs_manual 로 전환된 잡 id (중복 없음, 안정 순서) */
  blockedJobIds: string[];
  /** 참조 검증에서 걸러진 잡 수 */
  rejectedJobs: number;
}

/**
 * 한 창구의 사전 점검 전체 흐름.
 *
 * 1. 창구/지자체 조회 → 없으면 no-op
 * 2. 사이트 healthCheck — 실패 시 fail-closed: 지자체 broken + 이 창구의
 *    pending/queued 잡 전부 needs_manual + 잡별 멱등 precheck_failed 알림
 * 3. 통과 시 pending/queued 잡을 계정 단위로 묶고(참조 검증 포함)
 * 4. 계정마다 durable 클레임 후 최대 1회 로그인 → 결과 확정 → 실패 계정의 잡만 격리
 *
 * 계정 처리 중 발생한 인프라 오류는 그 계정만 건너뛰고 나머지를 계속 처리한 뒤,
 * 마지막에 모아서 throw 한다(잡 실패로 남겨 재시도 — 조용한 성공 금지).
 */
export async function runWindowPrecheck(
  ports: PrecheckPorts,
  windowId: string,
): Promise<PrecheckRunSummary> {
  const summary: PrecheckRunSummary = {
    windowId,
    skipped: false,
    healthOk: false,
    loginsAttempted: 0,
    outcomes: {},
    blockedJobIds: [],
    rejectedJobs: 0,
  };

  const window_ = await ports.loadWindow(windowId);
  if (!window_) {
    summary.skipped = true;
    ports.log("info", "precheck.window_missing", { windowId });
    return summary;
  }
  const municipality = await ports.loadMunicipality(window_.municipality_id);
  if (!municipality) {
    summary.skipped = true;
    ports.log("info", "precheck.municipality_missing", { windowId, municipalityId: window_.municipality_id });
    return summary;
  }

  const health = await ports.healthCheck();
  summary.healthOk = health.ok;

  if (!health.ok) {
    // fail-closed: 사이트가 정상이 아니면 계정 로그인을 시도하지 않고 창구 전체를 막는다.
    await ports.markMunicipalityBroken(municipality.id);
    const jobs = await ports.loadCandidateJobs(windowId);
    const targets = jobs.filter((j) => PRECHECKABLE_JOB_STATUSES.has(j.status));
    ports.log("error", "precheck.health_failed", {
      windowId,
      municipalityId: municipality.id,
      failures: health.failures.map((f) => f.check),
      blockedJobs: targets.length,
    });
    await blockJobs(ports, summary, {
      jobs: targets.map((j) => ({ jobId: j.jobId, tenantId: j.tenantId })),
      code: PRECHECK_ERROR_CODES.site_down,
      detail: PRECHECK_MESSAGES.site_down,
      payload: {
        reason: "site_down",
        windowId,
        checks: health.failures.map((f) => f.check),
      },
    });
    return summary;
  }

  const jobs = await ports.loadCandidateJobs(windowId);
  const { groups, rejected } = groupPrecheckJobsByCredential(jobs, {
    municipalityId: municipality.id,
  });
  summary.rejectedJobs = rejected.length;

  // 참조 검증 위반/계정 미등록 잡: 사이트 접속 없이 즉시 격리(사유별로 묶어 처리).
  for (const reason of ["credential_missing", "reference_invalid"] as const) {
    const items = rejected.filter((r) => r.reason === reason);
    if (items.length === 0) continue;
    ports.log("warn", "precheck.jobs_rejected", { windowId, reason, count: items.length });
    await blockJobs(ports, summary, {
      jobs: items,
      code: PRECHECK_ERROR_CODES[reason],
      detail: PRECHECK_MESSAGES[reason],
      payload: { reason, windowId },
    });
  }

  const infraErrors: string[] = [];
  for (const group of groups) {
    try {
      await checkCredential(ports, windowId, group, summary);
    } catch (err) {
      // 한 계정의 인프라 오류가 다른 계정 점검을 멈추지 않게 한다.
      const detail = err instanceof Error ? err.message : String(err);
      infraErrors.push(`${group.credentialId}: ${detail}`);
      ports.log("error", "precheck.credential_infra_error", {
        windowId,
        credentialId: group.credentialId,
        detail,
      });
    }
  }

  if (infraErrors.length > 0) {
    // 조용한 성공 금지 — 잡을 실패로 남겨 BullMQ 재시도가 다시 평가하게 한다.
    throw new Error(`precheck 계정 점검 중 오류 ${infraErrors.length}건: ${infraErrors.join(" | ")}`);
  }

  return summary;
}

/** 계정 1개 처리: 클레임 → (필요 시) 로그인 1회 → 결과 확정 → 실패면 그 계정 잡만 격리 */
async function checkCredential(
  ports: PrecheckPorts,
  windowId: string,
  group: CredentialGroup,
  summary: PrecheckRunSummary,
): Promise<void> {
  const existing = await ports.readPrecheck(windowId, group.credentialId);
  const plan = planCredentialPrecheck(existing, { nowMs: ports.now() });

  if (plan.action === "reapply_terminal") {
    const outcome = plan.outcome!;
    summary.outcomes[group.credentialId] = outcome;
    // 재로그인 없이 확정 결과만 다시 적용한다. 점검 이후 새로 생긴 잡도 같은 결과로
    // 격리되며, 알림은 (type, ref_id, ...) 멱등키 덕분에 중복 생성되지 않는다.
    //
    // 계정 상태도 함께 복구한다: 결과 기록(finishPrecheck) 뒤 site_credentials 갱신
    // 직전에 워커가 죽으면 점검 레코드만 terminal 이고 계정 상태는 옛 값으로 남는다.
    // 재적용은 그 창을 닫는다. 이때 쓰는 시각은 "지금"이 아니라 저장된 확정 시각이어야
    // last_login_ok_at 이 실제로 로그인에 성공한 시점을 가리킨다.
    if (isCredentialFault(outcome) || outcome === "ok") {
      await ports.markCredentialStatus(
        group.credentialId,
        outcome,
        existing!.checkedAt ?? existing!.lastAttemptAt,
      );
    }
    if (outcome !== "ok") await applyCredentialFault(ports, windowId, group, outcome, summary);
    ports.log("info", "precheck.terminal_reapplied", {
      windowId,
      credentialId: group.credentialId,
      outcome,
    });
    return;
  }

  if (plan.action !== "claim") {
    summary.outcomes[group.credentialId] = plan.action;
    ports.log("info", "precheck.skipped", {
      windowId,
      credentialId: group.credentialId,
      action: plan.action,
      attempts: existing?.attempts ?? 0,
    });
    // skip_running 은 다른 워커가 지금 점검 중이므로 그 결과를 기다린다.
    // skip_exhausted 는 다르다 — 이 창구에서 이 계정은 더 이상 로그인하지 않기로
    // 확정된 상태다. 잡을 그대로 두면 확인되지 않은 계정으로 창구가 열리는 순간
    // 자동 제출이 나간다. 그래서 fail-closed 로 잡을 격리한다. 다만 계정이 틀렸다는
    // 근거는 없으므로(회수 실패는 인프라 사정) site_credentials 는 건드리지 않고,
    // 'error'(사이트/인프라 오류) 와 같은 고정 문구·코드로 처리한다.
    //
    // 이 경로는 재로그인을 하지 않으므로 매시간 다시 도는 잡이 늦게 생긴 잡까지
    // 로그인 0회로 같은 격리를 적용한다(알림은 잡별 멱등키로 중복되지 않는다).
    if (plan.action === "skip_exhausted") {
      await applyCredentialFault(ports, windowId, group, "error", summary);
      ports.log("error", "precheck.exhausted_blocked", {
        windowId,
        credentialId: group.credentialId,
        attempts: existing?.attempts ?? 0,
        blockedJobs: group.jobs.length,
      });
    }
    return;
  }

  const nowIso = new Date(ports.now()).toISOString();
  // 이번 실행이 소유하게 되는 attempts 값 — finishPrecheck CAS 의 기대값이다.
  const claimedAttempts = plan.reclaim ? existing!.attempts + 1 : 1;
  const claimed = plan.reclaim
    ? await ports.reclaimPrecheck({
        windowId,
        credentialId: group.credentialId,
        expectedStatus: existing!.status,
        expectedAttempts: existing!.attempts,
        nowIso,
      })
    : await ports.claimPrecheck({
        windowId,
        credentialId: group.credentialId,
        tenantId: group.tenantId,
        municipalityId: group.municipalityId,
        nowIso,
      });

  if (!claimed) {
    // 경쟁에서 졌다 = 다른 워커가 같은 (window, credential) 을 이미 잡았다 → 로그인 금지.
    summary.outcomes[group.credentialId] = "skip_running";
    ports.log("info", "precheck.claim_lost", { windowId, credentialId: group.credentialId });
    return;
  }

  let outcome: PrecheckLoginOutcome;
  try {
    await ports.login(group.credentialId);
    outcome = "ok";
  } catch (err) {
    outcome = classifyLoginFailure(err);
  }
  summary.loginsAttempted += 1;
  summary.outcomes[group.credentialId] = outcome;

  // 결과를 먼저 durable 하게 확정한다 — 이후 단계가 실패해도 재로그인이 일어나지 않게.
  const checkedAtIso = new Date(ports.now()).toISOString();
  await ports.finishPrecheck({
    windowId,
    credentialId: group.credentialId,
    expectedAttempts: claimedAttempts,
    outcome,
    code: outcome === "ok" ? null : PRECHECK_ERROR_CODES[outcome],
    detail: outcome === "ok" ? null : PRECHECK_MESSAGES[outcome],
    nowIso: checkedAtIso,
  });

  if (outcome === "ok") {
    await ports.markCredentialStatus(group.credentialId, "ok", checkedAtIso);
    ports.log("info", "precheck.login_ok", {
      windowId,
      credentialId: group.credentialId,
      jobs: group.jobs.length,
    });
    return;
  }

  // 계정 결함(invalid/locked)만 site_credentials 에 반영한다. 사이트/인프라 오류는
  // 계정 잘못이 아니므로 계정 상태를 절대 건드리지 않는다.
  if (isCredentialFault(outcome)) {
    await ports.markCredentialStatus(group.credentialId, outcome, checkedAtIso);
  }
  // 성공하지 못한 점검은 어떤 사유든 그 계정의 잡을 자동 제출에서 뺀다 — 확인되지
  // 않은 계정으로 창구가 열리는 순간 자동 제출이 나가는 것이 가장 나쁜 결과다.
  await applyCredentialFault(ports, windowId, group, outcome, summary);
  ports.log(outcome === "error" ? "error" : "warn", "precheck.login_not_ok", {
    windowId,
    credentialId: group.credentialId,
    outcome,
    blockedJobs: group.jobs.length,
  });
}

/** 점검이 ok 로 끝나지 않은 계정의 잡만 needs_manual + 멱등 알림 */
async function applyCredentialFault(
  ports: PrecheckPorts,
  windowId: string,
  group: CredentialGroup,
  outcome: Exclude<PrecheckLoginOutcome, "ok">,
  summary: PrecheckRunSummary,
): Promise<void> {
  await blockJobs(ports, summary, {
    jobs: group.jobs,
    code: PRECHECK_ERROR_CODES[outcome],
    detail: PRECHECK_MESSAGES[outcome],
    payload: { reason: outcome, windowId },
  });
}

/**
 * 잡 격리의 단일 경로 — 알림 먼저, 잡 전환 나중.
 *
 * 이 순서가 재시도 안전의 핵심이다. 잡을 먼저 needs_manual 로 바꾸면 그 잡은 다음
 * 실행의 후보(pending/queued)에서 빠지므로, 알림 생성 직전에 실패한 잡은 영영
 * 알림을 받지 못한다. 알림을 먼저 만들면 중간에 실패해도 잡이 여전히 후보로 남아
 * 재시도가 전환을 마치고, 알림은 (type, ref_id, channel, user_id) 멱등키 덕분에
 * 중복 생성되지 않는다.
 */
async function blockJobs(
  ports: PrecheckPorts,
  summary: PrecheckRunSummary,
  input: {
    jobs: ReadonlyArray<{ jobId: string; tenantId: string }>;
    code: string;
    detail: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  if (input.jobs.length === 0) return;
  await ports.notifyPrecheckFailed(
    input.jobs.map((j) => ({ jobId: j.jobId, tenantId: j.tenantId, payload: input.payload })),
  );
  // 실제로 전환된 잡만 요약에 남긴다(가드에 걸린 잡을 "막았다"고 보고하지 않는다).
  const blocked = await ports.markJobsNeedsManual(
    input.jobs.map((j) => j.jobId),
    input.code,
    input.detail,
  );
  for (const id of blocked) {
    if (!summary.blockedJobIds.includes(id)) summary.blockedJobIds.push(id);
  }
}
