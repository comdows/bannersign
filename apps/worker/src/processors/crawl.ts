import {
  createAuditTrail,
  getAdapter,
  memorySink,
  type CrawlContext,
  type MunicipalityAdapter,
} from "@youni/adapters";
import {
  crawlJobPayloadSchema,
  findDuplicateTargetPeriodStarts,
  planScheduleReconcile,
  unwrapQuery,
  type ApplicationWindowInfo,
  type ExistingWindowRow,
  type ObservedWindow,
  type ReconcilePlan,
  type ScheduleDiff,
  type WindowSource,
} from "@youni/core";
import type { MunicipalityRow } from "@youni/db";
import type { Job } from "bullmq";
import { chromium, type Browser } from "playwright";
import { db } from "../db.js";
import { logger } from "../logger.js";

async function withCrawlContext<T>(
  fn: (ctx: CrawlContext, browser: Browser) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const ctx: CrawlContext = {
      page,
      audit: createAuditTrail(page, memorySink()),
      log: (msg) => logger.info(msg),
    };
    return await fn(ctx, browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

/** 게시대/일정/규격 크롤 + healthCheck */
export async function processCrawlJob(bullJob: Job): Promise<void> {
  const payload = crawlJobPayloadSchema.parse(bullJob.data);
  const muniRes = await db()
    .from("municipalities")
    .select("*")
    .eq("id", payload.municipalityId)
    .maybeSingle();
  const muni = unwrapQuery(muniRes, `municipalities(${payload.municipalityId})`);
  if (!muni) return; // 지자체 없음 = 정상 no-op (조회 오류는 위에서 throw)
  const municipality = muni as MunicipalityRow;
  const adapter = getAdapter(municipality.adapter_key);

  const runRes = await db()
    .from("crawl_runs")
    .insert({ municipality_id: municipality.id, kind: payload.target === "health" ? "health" : payload.target })
    .select("id")
    .single();
  const run = unwrapQuery(runRes, "crawl_runs.insert") as { id: string };

  try {
    await withCrawlContext(async (ctx) => {
      if (payload.target === "schedule") {
        await reconcileSchedule(ctx, municipality, adapter, run.id);
      } else if (payload.target === "boards") {
        const boards = await adapter.fetchBoards(ctx);
        for (const b of boards) {
          await db()
            .from("board_sites")
            .upsert(
              {
                municipality_id: municipality.id,
                external_id: b.externalId,
                name: b.name,
                address: b.address ?? null,
                slot_count: b.slotCount ?? null,
                fee: b.fee ?? null,
                dimensions_cm: b.dimensionsCm ?? null,
                raw: b.raw ?? null,
                is_active: true,
                last_seen_at: new Date().toISOString(),
                // 좌표는 파서가 찾은 경우에만 — 컬럼 자체를 빼서 기존 값을 null로 덮지 않는다
                ...(b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : {}),
              },
              { onConflict: "municipality_id,external_id" },
            );
        }
        await db()
          .from("crawl_runs")
          .update({ status: "ok", ended_at: new Date().toISOString(), diff_summary: { count: boards.length } })
          .eq("id", run.id);
      } else if (payload.target === "health") {
        const report = await adapter.healthCheck(ctx);
        if (!report.ok) {
          await db().from("municipalities").update({ status: "broken" }).eq("id", municipality.id);
          logger.error({ municipality: municipality.code, failures: report.failures }, "healthCheck failed");
        }
        await db()
          .from("crawl_runs")
          .update({ status: report.ok ? "ok" : "failed", ended_at: new Date().toISOString(), diff_summary: { failures: report.failures } })
          .eq("id", run.id);
      } else {
        // 미구현 target(예: 'spec')은 어느 분기에도 들지 못해 crawl run 이 영구 running 으로
        // 남는다. 명시 오류를 던져 상위 catch 가 failed 로 닫게 한다(조용한 running 누수 방지).
        throw new Error(`crawl target 미구현: ${payload.target}`);
      }
    });
  } catch (err) {
    // failed 상태 기록 자체가 실패해도 원래 오류를 덮지 않는다 — 구조화 error 로그 후 원본 rethrow.
    const { error: failErr } = await db()
      .from("crawl_runs")
      .update({ status: "failed", ended_at: new Date().toISOString(), error_detail: String(err) })
      .eq("id", run.id);
    if (failErr) {
      logger.error(
        { err: failErr, runId: run.id, originalError: String(err) },
        "crawl_runs failed 상태 기록 실패 — 원본 오류는 rethrow 됨",
      );
    }
    throw err;
  }
}

/** crawl_runs 갱신(쓰기 오류 검사) — 실패를 ok/noSchedule 로 기록하지 않도록. */
async function updateCrawlRun(runId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("crawl_runs").update(patch).eq("id", runId);
  if (error) throw new Error(`crawl_runs update 실패 (run ${runId}): ${error.message}`);
}

/**
 * target=schedule 처리: adapter.fetchSchedule 관측 → 논리 키((muni, target_period_start))별
 * reconcile/upsert → crawl_runs 갱신. 모든 Supabase error 를 검사해 성공/0건으로
 * 삼키지 않는다(오류면 throw → 상위에서 crawl run failed + rethrow).
 */
async function reconcileSchedule(
  ctx: CrawlContext,
  municipality: MunicipalityRow,
  adapter: MunicipalityAdapter,
  runId: string,
): Promise<void> {
  // 필드 부재/파서 실패는 adapter 가 selector_missing 로 throw → 상위 catch 로 감. 0건과 구분됨.
  const observed = await adapter.fetchSchedule(ctx);
  const observedAt = new Date().toISOString();
  const nowMs = Date.now();

  if (observed.length === 0) {
    // 어댑터가 명시적으로 [] 를 반환한 경우만 "현재 공지된 일정 없음".
    // 쓰기 오류를 ok/noSchedule 로 기록하지 않도록 결과를 검사한다.
    await updateCrawlRun(runId, {
      status: "ok",
      ended_at: observedAt,
      diff_summary: { count: 0, noSchedule: true, observedAt },
    });
    return;
  }

  // 한 응답 안에 같은 논리 키(정규화 target_period_start)가 중복되면 뒤 관측이 앞을
  // 조용히 덮는 모호성이 있다 → DB 쓰기 전에 fail-closed(검증 오류)로 중단한다.
  const dupKeys = findDuplicateTargetPeriodStarts(observed);
  if (dupKeys.length > 0) {
    throw new Error(
      `schedule 관측에 동일 target_period_start 논리 키 중복: ${dupKeys.join(", ")} — 파서/사이트 검증 실패(fail-closed)`,
    );
  }

  const results: Array<{ targetPeriodStart: string; action: string } & Partial<ScheduleDiff>> = [];
  let requiresManualReview = false;

  for (const obs of observed) {
    const tps = obs.targetPeriodStart.slice(0, 10);
    const existingRes = await db()
      .from("application_windows")
      .select("id, source, opens_at, closes_at, target_period_end, selection_method, result_expected_at")
      .eq("municipality_id", municipality.id)
      .eq("target_period_start", tps)
      .maybeSingle();
    const row = unwrapQuery(existingRes, `application_windows(${municipality.id},${tps})`) as {
      id: string;
      source: WindowSource;
      opens_at: string;
      closes_at: string;
      target_period_end: string;
      selection_method: "lottery" | "fcfs";
      result_expected_at: string | null;
    } | null;

    let jobsExist = false;
    if (row) {
      const jobsRes = await db()
        .from("submission_jobs")
        .select("id", { count: "exact", head: true })
        .eq("window_id", row.id);
      if (jobsRes.error) {
        throw new Error(`submission_jobs count 조회 실패 (window ${row.id}): ${jobsRes.error.message}`);
      }
      jobsExist = (jobsRes.count ?? 0) > 0;
    }

    const existing: ExistingWindowRow | null = row
      ? {
          id: row.id,
          source: row.source,
          targetPeriodStart: tps,
          opensAt: row.opens_at,
          closesAt: row.closes_at,
          targetPeriodEnd: String(row.target_period_end).slice(0, 10),
          selectionMethod: row.selection_method,
          resultExpectedAt: row.result_expected_at,
        }
      : null;
    const observedVals: ObservedWindow = {
      targetPeriodStart: obs.targetPeriodStart,
      opensAt: obs.opensAt,
      closesAt: obs.closesAt,
      targetPeriodEnd: obs.targetPeriodEnd.slice(0, 10),
      selectionMethod: obs.selectionMethod,
      resultExpectedAt: obs.resultExpectedAt ?? null,
    };

    const plan = planScheduleReconcile(existing, observedVals, { nowMs, jobsExist, observedAt });
    await applyReconcilePlan(municipality, tps, obs, existing, plan);

    if (plan.action === "manual_review") {
      requiresManualReview = true;
      // 알림 stub 이 거짓 sent 레코드를 만들지 않도록 notification 은 남기지 않는다.
      // 이 단계의 운영 신호는 crawl_runs.diff_summary + critical warn 이다.
      logger.warn(
        {
          municipality: municipality.code,
          targetPeriodStart: tps,
          reason: plan.diff?.reason,
          changedFields: plan.diff?.changedFields,
          previous: plan.diff?.previous,
          observed: plan.diff?.observed,
        },
        "schedule 변경 감지 — 자동 반영하지 않음(수동 검토 필요)",
      );
    }
    results.push({ targetPeriodStart: tps, action: plan.action, ...(plan.diff ?? {}) });
  }

  await updateCrawlRun(runId, {
    status: "ok",
    ended_at: new Date().toISOString(),
    diff_summary: { count: observed.length, requiresManualReview, observedAt, results },
  });
}

/** reconcile 판정대로 application_windows 를 쓴다(쓰기 오류는 throw). */
async function applyReconcilePlan(
  municipality: MunicipalityRow,
  tps: string,
  obs: ApplicationWindowInfo,
  existing: ExistingWindowRow | null,
  plan: ReconcilePlan,
): Promise<void> {
  const scheduleCols = {
    opens_at: obs.opensAt,
    closes_at: obs.closesAt,
    target_period_end: obs.targetPeriodEnd.slice(0, 10),
    selection_method: obs.selectionMethod,
    result_expected_at: obs.resultExpectedAt ?? null,
  };
  switch (plan.action) {
    case "insert": {
      const { error } = await db()
        .from("application_windows")
        .insert({ municipality_id: municipality.id, target_period_start: tps, source: "crawled", ...scheduleCols });
      // 23505(unique 위반)도 조용히 성공으로 삼키지 않는다 — 동시 생성된 manual/crawled 을
      // 재평가하지 않은 채 insert 성공으로 기록되면 안 된다. 명시 throw → run failed →
      // BullMQ retry 가 기존 행을 다시 읽어 reconcile 한다.
      if (error) {
        throw new Error(
          `application_windows insert 실패 (${municipality.id},${tps}): [${error.code ?? "?"}] ${error.message} — 동시 생성 가능, 재평가 필요`,
        );
      }
      break;
    }
    case "apply": {
      // CAS: source 가 여전히 rule/crawled 일 때만 갱신. 조회 후 운영자가 manual 로 바꾼
      // TOCTOU 에서 manual 을 crawled 로 덮지 않는다. .select().maybeSingle() 로 실제 1행
      // 갱신을 검증하고, 0행이면 동시 변경으로 보고 fail-closed throw(재시도 시 manual 재확인 → skip).
      const { data, error } = await db()
        .from("application_windows")
        .update({ source: "crawled", ...scheduleCols })
        .eq("id", existing!.id)
        .in("source", ["rule", "crawled"])
        .select("id")
        .maybeSingle();
      if (error) throw new Error(`application_windows apply 실패 (${existing!.id}): ${error.message}`);
      if (!data) {
        throw new Error(
          `application_windows apply CAS 0행 (${existing!.id}): 동시 source 변경(예: manual 승격) 감지 — fail-closed`,
        );
      }
      break;
    }
    case "confirm_source": {
      // CAS: source='rule' 일 때만 crawled 로 승격. 0행이면 동시 변경이므로 조용한 성공 금지 → throw.
      const { data, error } = await db()
        .from("application_windows")
        .update({ source: "crawled" })
        .eq("id", existing!.id)
        .eq("source", "rule")
        .select("id")
        .maybeSingle();
      if (error) throw new Error(`application_windows confirm_source 실패 (${existing!.id}): ${error.message}`);
      if (!data) {
        throw new Error(
          `application_windows confirm_source CAS 0행 (${existing!.id}): 동시 source 변경 감지 — fail-closed`,
        );
      }
      break;
    }
    case "noop":
    case "manual_review": // 위험 변경 — 시간 값 유지
    case "skip_manual": // manual 보호 — 절대 건드리지 않음
      break;
  }
}
