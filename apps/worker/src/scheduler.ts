import { hasAdapter } from "@youni/adapters";
import {
  checkRequestReadiness,
  expiresAfterFirstJob,
  planRuleWindow,
  precheckJobId,
  unwrapQuery,
  upcomingWindows,
  type ReadinessInput,
  type ReadinessMode,
  type ReadinessResult,
  type WindowRule,
  type WindowSource,
} from "@youni/core";
import type { ApplicationRequestRow, ApplicationWindowRow, MunicipalitySpecRow } from "@youni/db";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { env } from "./env.js";
import { getQueue } from "./queues.js";
import { canPrepareWindow, effectiveDryRun } from "./rehearsal.js";

const DAY_MS = 24 * 3600_000;

/**
 * 마스터 틱 (1분 주기) — 스케줄의 원천은 DB.
 * 1. window_rule → application_windows 인스턴스 upsert
 * 2. 창구 status 전이 (upcoming → open → closed)
 * 3. D-3: active request마다 submission_job 생성 + 오픈 예정 알림
 * 4. 오픈 시각 delayed submit 잡 큐잉 (BullMQ jobId = submission_job.id로 멱등)
 * 5. D-1: 사전 점검(로그인/healthCheck) 잡 큐잉
 * 6. 결과 발표 예정 창구의 결과 수집 잡 큐잉
 */
export async function masterTick(): Promise<void> {
  const now = new Date();
  await generateWindows(now);
  await transitionWindowStatuses(now);
  await prepareSubmissionJobs(now);
  await enqueueDueJobs(now);
  await enqueuePrechecks(now);
  await enqueueResultCrawls(now);
  await enqueueScheduleCrawls(now);
}

async function generateWindows(now: Date): Promise<void> {
  const { data: specs, error } = await db()
    .from("municipality_specs")
    .select("id, municipality_id, window_rule, version")
    .not("window_rule", "is", null)
    .order("version", { ascending: false });
  if (error) throw error;

  const seen = new Set<string>();
  for (const spec of (specs ?? []) as Pick<MunicipalitySpecRow, "municipality_id" | "window_rule">[]) {
    if (seen.has(spec.municipality_id)) continue; // 최신 버전만 사용
    seen.add(spec.municipality_id);
    const rule = spec.window_rule as WindowRule;
    for (const w of upcomingWindows(rule, now)) {
      const tps = w.targetPeriodStart.slice(0, 10);
      // 논리 키((municipality_id, target_period_start))로 기존 행 확인 —
      // crawled/manual 은 절대 덮지 않고, rule 만 최신 값으로 갱신한다(출처 우선순위).
      const existingRes = await db()
        .from("application_windows")
        .select("id, source")
        .eq("municipality_id", spec.municipality_id)
        .eq("target_period_start", tps)
        .maybeSingle();
      const existing = unwrapQuery(existingRes, `application_windows(${spec.municipality_id},${tps})`) as
        | { id: string; source: WindowSource }
        | null;

      const action = planRuleWindow(existing);
      if (action === "skip") continue; // crawled/manual 보호

      const row = {
        municipality_id: spec.municipality_id,
        opens_at: w.opensAt,
        closes_at: w.closesAt,
        target_period_start: tps,
        target_period_end: w.targetPeriodEnd.slice(0, 10),
        selection_method: w.selectionMethod,
        result_expected_at: w.resultExpectedAt ?? null,
        source: "rule" as const,
      };

      if (action === "insert") {
        const { error: insErr } = await db().from("application_windows").insert(row);
        // 경쟁 삽입으로 unique 위반(23505)이면 다른 tick/크롤이 이미 만든 것 → 무시.
        if (insErr && insErr.code !== "23505") {
          logger.error({ err: insErr, municipalityId: spec.municipality_id, tps }, "window insert failed");
        }
      } else {
        // update_rule: 기존 rule 행만 최신 rule 값으로 갱신.
        const { error: updErr } = await db()
          .from("application_windows")
          .update(row)
          .eq("id", existing!.id)
          .eq("source", "rule");
        if (updErr) logger.error({ err: updErr, windowId: existing!.id }, "window rule update failed");
      }
    }
  }
}

async function transitionWindowStatuses(now: Date): Promise<void> {
  const iso = now.toISOString();
  const { error: openError } = await db()
    .from("application_windows")
    .update({ status: "open" })
    .eq("status", "upcoming")
    .lte("opens_at", iso)
    .gt("closes_at", iso);
  if (openError) throw openError;

  const { error: closeError } = await db()
    .from("application_windows")
    .update({ status: "closed" })
    .in("status", ["upcoming", "open"])
    .lte("closes_at", iso);
  if (closeError) throw closeError;
}

/**
 * D-3 이내 창구: active request마다 submission_job(pending) 생성 + 알림 레코드.
 * 이미 열린 창구는 worker 재기동 catch-up을 위해 포함하되, 실 제출 요청은
 * D-1 점검을 건너뛴 채 뒤늦게 실행하지 않도록 dry-run만 허용한다.
 */
async function prepareSubmissionJobs(now: Date): Promise<void> {
  const horizon = new Date(now.getTime() + 3 * DAY_MS).toISOString();
  const nowIso = now.toISOString();
  const { data: windows, error } = await db()
    .from("application_windows")
    .select("*")
    .in("status", ["upcoming", "open"])
    .lte("opens_at", horizon)
    .gt("closes_at", nowIso);
  if (error) throw error;

  for (const w of (windows ?? []) as ApplicationWindowRow[]) {
    const { data: requests, error: reqErr } = await db()
      .from("application_requests")
      .select("*")
      .eq("municipality_id", w.municipality_id)
      .eq("status", "active");
    // 조회 오류를 "요청 없음"으로 삼키면 안 된다 — fail-closed 로 이 창구를 건너뛰고
    // 운영 장애를 구분할 수 있게 구조화 error 로그를 남긴다(잡 미생성).
    if (reqErr) {
      logger.error(
        { err: reqErr, windowId: w.id, municipalityId: w.municipality_id },
        "active requests 조회 실패 — 이 창구 건너뜀(fail-closed)",
      );
      continue;
    }

    for (const req of (requests ?? []) as ApplicationRequestRow[]) {
      const requestDryRun = effectiveDryRun(env.SUBMIT_DRY_RUN_DEFAULT, req.dry_run_only);
      if (!canPrepareWindow(w.status, requestDryRun, w.opens_at, now)) {
        logger.warn(
          { requestId: req.id, windowId: w.id, status: w.status },
          "열린 창구의 실 제출 catch-up 차단(fail-closed)",
        );
        continue;
      }

      // 실행 직전 준비도 재검증 — 이미 존재하는 요청도 동일 기준으로 재확인한다.
      // 준비도는 시간에 따라 변한다(계정 잠김/지자체 broken/규격 갱신/게시대 비활성).
      // service-role 로 RLS 를 우회하므로 RLS 가 아니라 여기서 "명시적으로" 게이트한다.
      //
      // 조회 오류는 미충족(not ready)과 반드시 구분한다: evaluateRequestReadiness 는
      // 조회 오류 시 throw 하고, 여기서 fail-closed(잡 미생성)로 처리하되 request/window
      // 식별자와 오류 세부를 구조화 error 로그로 남긴다(운영 장애 ≠ 사용자 데이터 미충족).
      let readiness: ReadinessResult;
      try {
        readiness = await evaluateRequestReadiness(req, requestDryRun ? "dry_run" : "live");
      } catch (err) {
        logger.error(
          { err, requestId: req.id, windowId: w.id, municipalityId: w.municipality_id },
          "readiness 조회 실패 — fail-closed, submission_job 생성 안 함",
        );
        continue;
      }
      if (!readiness.ready) {
        logger.info(
          { requestId: req.id, windowId: w.id, issues: readiness.issues.map((i) => i.code) },
          "request not ready — submission_job 생성 안 함",
        );
        continue;
      }

      const { data: job, error: insErr } = await db()
        .from("submission_jobs")
        .insert({
          request_id: req.id,
          window_id: w.id,
          tenant_id: req.tenant_id,
          status: "pending",
          dry_run: requestDryRun,
          queued_for: w.opens_at,
        })
        .select("id")
        .single();
      // unique(request_id, window_id) 위반 = 이미 생성됨 → 무시
      if (insErr && !insErr.message.includes("duplicate")) {
        if (insErr.code !== "23505") logger.error({ err: insErr }, "job insert failed");
        continue;
      }
      if (job && w.status === "upcoming" && new Date(w.opens_at).getTime() > now.getTime()) {
        await db().from("notifications").insert({
          tenant_id: req.tenant_id,
          channel: "email",
          type: "window_upcoming",
          ref_id: job.id,
          payload: { windowId: w.id, opensAt: w.opens_at, municipalityId: w.municipality_id },
        });
        logger.info({ jobId: job.id, windowId: w.id }, "submission job prepared");
      }

      // recurrence='once' 는 첫 job 이 생기면 expired. 권위 구현은 DB 트리거
      // (trg_jobs_expire_once, insert 와 동일 트랜잭션)이며, 여기서는 멱등 백스톱으로
      // 한 번 더 보장한다(status='active' 가드 → 이미 expired 면 no-op).
      if (expiresAfterFirstJob(req.recurrence)) {
        await db()
          .from("application_requests")
          .update({ status: "expired" })
          .eq("id", req.id)
          .eq("status", "active");
      }
    }
  }
}

/**
 * 요청의 준비도 스냅샷을 DB 에서 로드해 @youni/core 의 순수 판정기로 평가한다.
 * (DB 결합은 여기, 판정 로직은 순수 함수 checkRequestReadiness — 후자를 단위 테스트한다.)
 */
async function evaluateRequestReadiness(
  req: ApplicationRequestRow,
  mode: ReadinessMode,
): Promise<ReadinessResult> {
  const boardIds = req.board_preferences.map((b) => b.boardSiteId);
  const [muniRes, credRes, profRes, specRes, boardsRes] = await Promise.all([
    db().from("municipalities").select("status, capabilities").eq("id", req.municipality_id).maybeSingle(),
    req.credential_id
      ? db()
          .from("site_credentials")
          .select("tenant_id, municipality_id, status")
          .eq("id", req.credential_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db().from("advertiser_profiles").select("business_name, phone").eq("id", req.profile_id).maybeSingle(),
    db()
      .from("municipality_specs")
      .select("version")
      .eq("municipality_id", req.municipality_id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
    boardIds.length > 0
      ? db().from("board_sites").select("id, municipality_id, is_active").in("id", boardIds)
      : Promise.resolve({ data: [] as { id: string; municipality_id: string; is_active: boolean }[], error: null }),
  ]);

  // 각 조회 오류를 명시적으로 검사 — 오류면 throw(호출자가 fail-closed 로 처리).
  const muni = unwrapQuery(muniRes, `municipalities(${req.municipality_id})`) as {
    status: string;
    capabilities: { autoSubmit: boolean };
  } | null;
  const cred = unwrapQuery(credRes, `site_credentials(${req.credential_id})`) as {
    tenant_id: string;
    municipality_id: string;
    status: string;
  } | null;
  const prof = unwrapQuery(profRes, `advertiser_profiles(${req.profile_id})`) as {
    business_name: string;
    phone: string;
  } | null;
  const latestSpecVersion =
    (unwrapQuery(specRes, `municipality_specs(${req.municipality_id})`) as { version: number } | null)
      ?.version ?? null;
  const boardRows =
    (unwrapQuery(boardsRes, `board_sites(request=${req.id})`) as
      | { id: string; municipality_id: string; is_active: boolean }[]
      | null) ?? [];

  let designValidation: ReadinessInput["designValidation"] = null;
  if (latestSpecVersion !== null) {
    const dvRes = await db()
      .from("design_validations")
      .select("verdict, spec_version")
      .eq("design_id", req.design_id)
      .eq("municipality_id", req.municipality_id)
      .eq("spec_version", latestSpecVersion)
      .maybeSingle();
    const row = unwrapQuery(dvRes, `design_validations(design=${req.design_id})`) as {
      verdict: "pass" | "warn" | "fail";
      spec_version: number;
    } | null;
    if (row) designValidation = { verdict: row.verdict, specVersion: row.spec_version };
  }

  const input: ReadinessInput = {
    tenantId: req.tenant_id,
    municipalityId: req.municipality_id,
    municipality: muni ? { status: muni.status, capabilities: muni.capabilities } : null,
    credentialId: req.credential_id,
    credential: cred
      ? { tenant_id: cred.tenant_id, municipality_id: cred.municipality_id, status: cred.status }
      : null,
    profile: prof ? { business_name: prof.business_name, phone: prof.phone } : null,
    latestSpecVersion,
    designValidation,
    selectedBoardIds: boardIds,
    boards: boardRows,
  };

  return checkRequestReadiness(input, mode);
}

/** pending 잡을 오픈 시각 delayed BullMQ 잡으로 큐잉 */
async function enqueueDueJobs(now: Date): Promise<void> {
  const { data: jobs, error } = await db()
    .from("submission_jobs")
    .select("id, queued_for")
    .eq("status", "pending")
    .not("queued_for", "is", null);
  if (error) throw error;

  const queue = getQueue("submit");
  for (const job of jobs ?? []) {
    const delay = Math.max(0, new Date(job.queued_for as string).getTime() - now.getTime());
    // jobId를 submission_job.id로 고정 — 중복 큐잉 방지 (이미 있으면 no-op)
    await queue.add(
      "submit",
      { kind: "submit", submissionJobId: job.id, dryRun: undefined },
      { jobId: job.id as string, delay, attempts: 1 },
    );
    await db()
      .from("submission_jobs")
      .update({ status: "queued", bullmq_job_id: job.id })
      .eq("id", job.id)
      .eq("status", "pending");
  }
}

/**
 * D-1 사전 점검.
 *
 * jobId 에 1시간 버킷을 넣어 오픈 전 24시간 동안 창구마다 매시간 한 번 다시 돈다.
 * 고정 jobId 였을 때는 첫 점검 이후 만들어진 submission_job(D-1 이후 생성분)이
 * 점검되지 않은 채 창구 오픈을 맞았다. 재실행이 반복 로그인으로 이어지지는 않는다 —
 * credential_prechecks 의 terminal 레코드가 재로그인을 막고 결과만 재적용한다.
 */
async function enqueuePrechecks(now: Date): Promise<void> {
  const from = now.toISOString();
  const to = new Date(now.getTime() + DAY_MS).toISOString();
  const { data: windows, error } = await db()
    .from("application_windows")
    .select("id")
    .eq("status", "upcoming")
    .gte("opens_at", from)
    .lte("opens_at", to);
  // 조회 오류를 "대상 창구 없음"으로 삼키면 사전 점검을 통째로 건너뛴 채 창구가
  // 열린다 — 조용한 성공 금지(마스터 틱이 실패하고 다음 틱이 다시 시도한다).
  if (error) throw error;

  const queue = getQueue("precheck");
  for (const w of windows ?? []) {
    await queue.add(
      "precheck",
      { kind: "precheck", windowId: w.id },
      { jobId: precheckJobId(w.id as string, now.getTime()), attempts: 2 },
    );
  }
}

/** 결과 발표 예정 시각이 지난 창구 → 6시간 간격 결과 수집 */
async function enqueueResultCrawls(now: Date): Promise<void> {
  const { data: windows } = await db()
    .from("application_windows")
    .select("id")
    .eq("status", "closed")
    .lte("result_expected_at", now.toISOString());

  const queue = getQueue("results");
  for (const w of windows ?? []) {
    const bucket = Math.floor(now.getTime() / (6 * 3600_000)); // 6시간 버킷으로 멱등
    await queue.add(
      "results",
      { kind: "results", windowId: w.id },
      { jobId: `results-${w.id}-${bucket}`, attempts: 2 },
    );
  }
}

/** KST 기준 날짜 버킷 YYYYMMDD (BullMQ jobId 용, 콜론 없음) */
function dateBucketKst(now: Date): string {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * 등록된 adapter 를 가진 active/beta/broken 지자체에 1일 1회 schedule crawl job 을 큐잉.
 * disabled 는 제외. 날짜 버킷을 포함한 결정적 jobId(콜론 금지)로 같은 날 중복 큐잉을 막는다.
 * 실제 외부 크롤은 여기서 실행하지 않는다(크롤 worker 가 처리).
 */
async function enqueueScheduleCrawls(now: Date): Promise<void> {
  const { data: munis, error } = await db()
    .from("municipalities")
    .select("id, adapter_key, status")
    .in("status", ["active", "beta", "broken"]);
  if (error) {
    logger.error({ err: error }, "schedule crawl 대상 지자체 조회 실패");
    return;
  }

  const bucket = dateBucketKst(now);
  const queue = getQueue("crawl");
  for (const m of (munis ?? []) as { id: string; adapter_key: string; status: string }[]) {
    if (!hasAdapter(m.adapter_key)) continue; // 어댑터 미등록 지자체 제외
    const jobId = `schedule-${m.id}-${bucket}`; // uuid + 날짜버킷, 콜론 없음 → 하루 1회 멱등
    try {
      await queue.add(
        "crawl",
        { kind: "crawl", municipalityId: m.id, target: "schedule" },
        { jobId, attempts: 2 },
      );
    } catch (err) {
      logger.error({ err, municipalityId: m.id }, "schedule crawl enqueue 실패");
    }
  }
}

export function startScheduler(): NodeJS.Timeout {
  const run = () =>
    masterTick().catch((err) => logger.error({ err }, "master tick failed"));
  run();
  return setInterval(run, 60_000);
}
