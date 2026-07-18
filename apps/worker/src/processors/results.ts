import { createAuditTrail, getAdapter, memorySink, type CrawlContext } from "@youni/adapters";
import { resultsJobPayloadSchema } from "@youni/core";
import type { MunicipalityRow, SubmissionJobRow } from "@youni/db";
import type { Job } from "bullmq";
import { chromium } from "playwright";
import { db } from "../db.js";
import { logger } from "../logger.js";

/**
 * 결과 수집: fetchResults → results 테이블 저장 → 접수번호/사업자명 매칭 → 알림.
 * 접수번호 정확 일치만 자동 매칭(exact), 이름 매칭은 fuzzy로 저장 후 관리자 확인 큐 경유.
 *
 * TODO(uriad 계열): 결과가 공개 페이지가 아니라 로그인 후 개인 마이페이지(top_mypage.jsp)에
 * 있다. 현재는 미인증 CrawlContext로 fetchResults를 호출해 uriad 사이트에선 0건이 나온다.
 * 후속: 이 창구의 submitted 잡별로 사용자 credential로 로그인(login())한 뒤 fetchResults를
 * 호출해 각 사용자 마이페이지를 파싱하도록 잡을 분리한다.
 */
export async function processResultsJob(bullJob: Job): Promise<void> {
  const payload = resultsJobPayloadSchema.parse(bullJob.data);
  const { data: window_ } = await db()
    .from("application_windows")
    .select("*")
    .eq("id", payload.windowId)
    .single();
  if (!window_ || window_.status === "results_out") return;

  const { data: muni } = await db()
    .from("municipalities")
    .select("*")
    .eq("id", window_.municipality_id)
    .single();
  if (!muni) return;
  const municipality = muni as MunicipalityRow;
  const adapter = getAdapter(municipality.adapter_key);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const ctx: CrawlContext = {
      page,
      audit: createAuditTrail(page, memorySink()),
      log: (msg) => logger.info(msg),
    };
    const rows = await adapter.fetchResults(ctx, {
      opensAt: window_.opens_at,
      closesAt: window_.closes_at,
      targetPeriodStart: window_.target_period_start,
    });
    if (rows.length === 0) return; // 아직 발표 전 — 다음 버킷에서 재시도

    // 이 창구의 submitted 잡들 (매칭 대상)
    const { data: jobs } = await db()
      .from("submission_jobs")
      .select("*")
      .eq("window_id", payload.windowId)
      .eq("status", "submitted");
    const byReceipt = new Map(
      ((jobs ?? []) as SubmissionJobRow[]).filter((j) => j.receipt_no).map((j) => [j.receipt_no!, j]),
    );

    let matched = 0;
    for (const row of rows) {
      const job = row.receiptNo ? byReceipt.get(row.receiptNo) : undefined;
      const outcome = row.outcome === "unknown" ? null : row.outcome;
      const { data: inserted } = await db()
        .from("results")
        .insert({
          window_id: payload.windowId,
          municipality_id: municipality.id,
          raw_row: row.raw,
          matched_job_id: job?.id ?? null,
          match_confidence: job ? "exact" : null,
          outcome,
          reviewed: Boolean(job), // 접수번호 정확 매칭은 자동 통과
        })
        .select("id")
        .single();

      if (job && outcome && inserted) {
        matched++;
        await db().from("notifications").upsert(
          {
            tenant_id: job.tenant_id,
            channel: "email",
            type: outcome === "selected" ? "result_selected" : "result_rejected",
            ref_id: job.id,
            payload: { resultId: inserted.id, windowId: payload.windowId },
          },
          { onConflict: "type,ref_id,channel,user_id", ignoreDuplicates: true },
        );
      }
    }

    await db().from("application_windows").update({ status: "results_out" }).eq("id", payload.windowId);
    logger.info({ windowId: payload.windowId, rows: rows.length, matched }, "results crawled");
  } finally {
    await browser.close().catch(() => {});
  }
}
