import { upcomingWindows, type WindowRule } from "@youni/core";
import type { ApplicationRequestRow, ApplicationWindowRow, MunicipalitySpecRow } from "@youni/db";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { env } from "./env.js";
import { getQueue } from "./queues.js";

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
      const { error: upsertErr } = await db()
        .from("application_windows")
        .upsert(
          {
            municipality_id: spec.municipality_id,
            opens_at: w.opensAt,
            closes_at: w.closesAt,
            target_period_start: w.targetPeriodStart.slice(0, 10),
            target_period_end: w.targetPeriodEnd.slice(0, 10),
            selection_method: w.selectionMethod,
            result_expected_at: w.resultExpectedAt ?? null,
            source: "rule",
          },
          { onConflict: "municipality_id,opens_at", ignoreDuplicates: true },
        );
      if (upsertErr) logger.error({ err: upsertErr }, "window upsert failed");
    }
  }
}

async function transitionWindowStatuses(now: Date): Promise<void> {
  const iso = now.toISOString();
  await db()
    .from("application_windows")
    .update({ status: "open" })
    .eq("status", "upcoming")
    .lte("opens_at", iso)
    .gt("closes_at", iso);
  await db()
    .from("application_windows")
    .update({ status: "closed" })
    .in("status", ["upcoming", "open"])
    .lte("closes_at", iso);
}

/** D-3 이내 창구: active request마다 submission_job(pending) 생성 + 알림 레코드 */
async function prepareSubmissionJobs(now: Date): Promise<void> {
  const horizon = new Date(now.getTime() + 3 * DAY_MS).toISOString();
  const { data: windows, error } = await db()
    .from("application_windows")
    .select("*")
    .eq("status", "upcoming")
    .lte("opens_at", horizon);
  if (error) throw error;

  for (const w of (windows ?? []) as ApplicationWindowRow[]) {
    const { data: requests } = await db()
      .from("application_requests")
      .select("*")
      .eq("municipality_id", w.municipality_id)
      .eq("status", "active");

    for (const req of (requests ?? []) as ApplicationRequestRow[]) {
      const { data: job, error: insErr } = await db()
        .from("submission_jobs")
        .insert({
          request_id: req.id,
          window_id: w.id,
          tenant_id: req.tenant_id,
          status: "pending",
          dry_run: env.SUBMIT_DRY_RUN_DEFAULT,
          queued_for: w.opens_at,
        })
        .select("id")
        .single();
      // unique(request_id, window_id) 위반 = 이미 생성됨 → 무시
      if (insErr && !insErr.message.includes("duplicate")) {
        if (insErr.code !== "23505") logger.error({ err: insErr }, "job insert failed");
        continue;
      }
      if (job) {
        await db().from("notifications").insert({
          tenant_id: req.tenant_id,
          channel: "email",
          type: "window_upcoming",
          ref_id: job.id,
          payload: { windowId: w.id, opensAt: w.opens_at, municipalityId: w.municipality_id },
        });
        logger.info({ jobId: job.id, windowId: w.id }, "submission job prepared");
      }
    }
  }
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

/** D-1 사전 점검 */
async function enqueuePrechecks(now: Date): Promise<void> {
  const from = now.toISOString();
  const to = new Date(now.getTime() + DAY_MS).toISOString();
  const { data: windows } = await db()
    .from("application_windows")
    .select("id")
    .eq("status", "upcoming")
    .gte("opens_at", from)
    .lte("opens_at", to);

  const queue = getQueue("precheck");
  for (const w of windows ?? []) {
    await queue.add(
      "precheck",
      { kind: "precheck", windowId: w.id },
      { jobId: `precheck-${w.id}`, attempts: 2 },
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

export function startScheduler(): NodeJS.Timeout {
  const run = () =>
    masterTick().catch((err) => logger.error({ err }, "master tick failed"));
  run();
  return setInterval(run, 60_000);
}
