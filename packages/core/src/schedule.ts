/**
 * 규칙 일정(rule)과 실측 일정(crawled) 동기화 — 순수 판정 로직 (S03).
 *
 * 논리 창구 식별자는 (municipality_id, target_period_start) 이다. 같은 지자체·대상
 * 게시기간에 rule/crawled 이중 행이 생기지 않아야 한다(DB 0004 unique 로 강제).
 *
 * 출처 우선순위: manual > crawled > rule.
 *   - 규칙 창구 생성은 같은 논리 키의 crawled/manual 을 절대 덮지 않는다(rule 만 갱신).
 *   - schedule crawl 은 rule/crawled 을 관측값으로 조정하되 manual 은 절대 덮지 않는다.
 *
 * 안전한 변경 정책(위험 변경 자동 반영 금지):
 *   - 값이 동일 → noop(필요 시 rule→crawled 출처 확인만 안전 반영).
 *   - 값이 다르고 (오픈까지 24시간 이하) 또는 (해당 window 에 submission_job 존재)
 *     → 시간 값을 자동으로 바꾸지 않고 requiresManualReview diff 를 남긴다.
 *   - 그 외(24시간 초과 + job 없음) → crawled 값을 적용(applied).
 *
 * DB 를 직접 만지지 않는다. 호출자(worker crawl/scheduler)가 이 판정 결과대로
 * upsert/update 를 수행하고, diff 는 crawl_runs.diff_summary 에 구조화 저장한다.
 */

export type WindowSource = "rule" | "crawled" | "manual";

/** 24시간(ms) — 오픈 임박 판정 임계값 */
export const NEAR_OPEN_MS = 24 * 60 * 60 * 1000;

/** targetPeriodStart 를 논리 키로 정규화(YYYY-MM-DD). DB target_period_start(date)와 대조용. */
export function normalizeTargetKey(targetPeriodStart: string): string {
  return targetPeriodStart.slice(0, 10);
}

/**
 * 한 관측 응답 안에서 같은 논리 키(정규화 YYYY-MM-DD target_period_start)가 두 번 이상
 * 나오는지 검사한다. 반환값(중복 키 목록)이 비어있지 않으면 호출자는 DB 쓰기 전에
 * fail-closed(파서/검증 오류)로 처리해야 한다 — 뒤 관측이 앞 관측을 조용히 덮는 모호성 방지.
 */
export function findDuplicateTargetPeriodStarts(
  observed: ReadonlyArray<{ targetPeriodStart: string }>,
): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const w of observed) {
    const key = normalizeTargetKey(w.targetPeriodStart);
    if (seen.has(key)) dups.add(key);
    seen.add(key);
  }
  return [...dups];
}

/** 논리 키(target_period_start)를 제외한 창구 "일정 값" */
export interface WindowScheduleValues {
  opensAt: string;
  closesAt: string;
  targetPeriodEnd: string;
  selectionMethod: "lottery" | "fcfs";
  resultExpectedAt: string | null;
}

export interface ExistingWindowRow extends WindowScheduleValues {
  id: string;
  source: WindowSource;
  targetPeriodStart: string;
}

export interface ObservedWindow extends WindowScheduleValues {
  targetPeriodStart: string;
}

/** 두 ISO 시각이 같은 순간인지(표기 차이 +09:00/Z 흡수). null 은 "값 없음". */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

/** 일정 값이 달라진 필드 목록(안정 순서). 날짜는 순간 비교, selection 은 문자열 비교. */
export function scheduleChangedFields(
  prev: WindowScheduleValues,
  next: WindowScheduleValues,
): string[] {
  const changed: string[] = [];
  if (!sameInstant(prev.opensAt, next.opensAt)) changed.push("opensAt");
  if (!sameInstant(prev.closesAt, next.closesAt)) changed.push("closesAt");
  if (!sameInstant(prev.targetPeriodEnd, next.targetPeriodEnd)) changed.push("targetPeriodEnd");
  if (prev.selectionMethod !== next.selectionMethod) changed.push("selectionMethod");
  if (!sameInstant(prev.resultExpectedAt, next.resultExpectedAt)) changed.push("resultExpectedAt");
  return changed;
}

function pickValues(v: WindowScheduleValues): WindowScheduleValues {
  return {
    opensAt: v.opensAt,
    closesAt: v.closesAt,
    targetPeriodEnd: v.targetPeriodEnd,
    selectionMethod: v.selectionMethod,
    resultExpectedAt: v.resultExpectedAt ?? null,
  };
}

// ── 규칙 창구 생성 판정 ──────────────────────────────────────────────────────

export type RuleWindowAction = "insert" | "update_rule" | "skip";

/**
 * 규칙(rule) 창구 upsert 시, 같은 논리 키의 기존 행을 어떻게 다룰지.
 *   - 없음 → insert
 *   - 기존이 rule → update_rule (최신 rule 값으로만 갱신)
 *   - 기존이 crawled/manual → skip (절대 덮지 않음)
 */
export function planRuleWindow(existing: { source: WindowSource } | null): RuleWindowAction {
  if (!existing) return "insert";
  if (existing.source === "rule") return "update_rule";
  return "skip";
}

// ── schedule crawl reconcile 판정 ───────────────────────────────────────────

export interface ReconcileContext {
  /** 판정 기준 시각(Date.now()) */
  nowMs: number;
  /** 기존 window 에 submission_job 이 하나라도 있는가 */
  jobsExist: boolean;
  /** 관측 시각 ISO (diff 기록용) */
  observedAt: string;
}

/** crawl_runs.diff_summary 에 담을 창구별 변경 기록 */
export interface ScheduleDiff {
  targetPeriodStart: string;
  changedFields: string[];
  previous: WindowScheduleValues;
  observed: WindowScheduleValues;
  observedAt: string;
  /** 위험 변경이라 자동 반영하지 않음 */
  requiresManualReview?: boolean;
  reason?: "near_open" | "jobs_exist";
  /** 안전 변경이라 자동 반영함 */
  applied?: boolean;
}

export type ReconcileAction =
  | "insert" // 기존 없음 → 관측값을 crawled 로 신규 삽입
  | "noop" // 값 동일, 변경 없음
  | "confirm_source" // 값 동일, 기존 rule → crawled 로만 출처 확인 승격
  | "apply" // 안전 변경 → 관측값 반영(source=crawled)
  | "manual_review" // 위험 변경 → 시간 값 유지, diff 만 기록
  | "skip_manual"; // 기존 manual → 절대 건드리지 않음

export interface ReconcilePlan {
  action: ReconcileAction;
  diff?: ScheduleDiff;
}

/**
 * 관측 창구(observed) 를 기존 행(existing) 과 대조해 무엇을 할지 결정한다.
 * 호출자는 existing/observed 가 같은 논리 키((municipality_id, target_period_start))
 * 임을 보장해야 한다.
 */
export function planScheduleReconcile(
  existing: ExistingWindowRow | null,
  observed: ObservedWindow,
  ctx: ReconcileContext,
): ReconcilePlan {
  if (!existing) return { action: "insert" };
  if (existing.source === "manual") return { action: "skip_manual" };

  const changedFields = scheduleChangedFields(existing, observed);
  if (changedFields.length === 0) {
    // 값이 완전히 같다 — rule 이면 관측 확인차 crawled 로만 안전 승격.
    return { action: existing.source === "rule" ? "confirm_source" : "noop" };
  }

  const openMs = Math.min(Date.parse(existing.opensAt), Date.parse(observed.opensAt));
  const nearOpen = Number.isFinite(openMs) && openMs - ctx.nowMs <= NEAR_OPEN_MS;

  const base = {
    targetPeriodStart: observed.targetPeriodStart,
    changedFields,
    previous: pickValues(existing),
    observed: pickValues(observed),
    observedAt: ctx.observedAt,
  };

  if (ctx.jobsExist || nearOpen) {
    return {
      action: "manual_review",
      diff: { ...base, requiresManualReview: true, reason: ctx.jobsExist ? "jobs_exist" : "near_open" },
    };
  }
  return { action: "apply", diff: { ...base, applied: true } };
}
