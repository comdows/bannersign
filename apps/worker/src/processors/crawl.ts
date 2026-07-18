import { createAuditTrail, getAdapter, memorySink, type CrawlContext } from "@youni/adapters";
import { crawlJobPayloadSchema, precheckJobPayloadSchema } from "@youni/core";
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
  const { data: muni } = await db()
    .from("municipalities")
    .select("*")
    .eq("id", payload.municipalityId)
    .single();
  if (!muni) return;
  const municipality = muni as MunicipalityRow;
  const adapter = getAdapter(municipality.adapter_key);

  const { data: run } = await db()
    .from("crawl_runs")
    .insert({ municipality_id: municipality.id, kind: payload.target === "health" ? "health" : payload.target })
    .select("id")
    .single();

  try {
    await withCrawlContext(async (ctx) => {
      if (payload.target === "boards") {
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
              },
              { onConflict: "municipality_id,external_id" },
            );
        }
        await db()
          .from("crawl_runs")
          .update({ status: "ok", ended_at: new Date().toISOString(), diff_summary: { count: boards.length } })
          .eq("id", run?.id ?? "");
      } else if (payload.target === "health") {
        const report = await adapter.healthCheck(ctx);
        if (!report.ok) {
          await db().from("municipalities").update({ status: "broken" }).eq("id", municipality.id);
          logger.error({ municipality: municipality.code, failures: report.failures }, "healthCheck failed");
        }
        await db()
          .from("crawl_runs")
          .update({ status: report.ok ? "ok" : "failed", ended_at: new Date().toISOString(), diff_summary: { failures: report.failures } })
          .eq("id", run?.id ?? "");
      }
    });
  } catch (err) {
    await db()
      .from("crawl_runs")
      .update({ status: "failed", ended_at: new Date().toISOString(), error_detail: String(err) })
      .eq("id", run?.id ?? "");
    throw err;
  }
}

/** D-1 사전 점검: healthCheck (로그인 테스트는 각 credential에 대해 추후 확장) */
export async function processPrecheckJob(bullJob: Job): Promise<void> {
  const payload = precheckJobPayloadSchema.parse(bullJob.data);
  const { data: window_ } = await db()
    .from("application_windows")
    .select("municipality_id")
    .eq("id", payload.windowId)
    .single();
  if (!window_) return;

  const { data: muni } = await db()
    .from("municipalities")
    .select("*")
    .eq("id", window_.municipality_id)
    .single();
  if (!muni) return;
  const municipality = muni as MunicipalityRow;
  const adapter = getAdapter(municipality.adapter_key);

  await withCrawlContext(async (ctx) => {
    const report = await adapter.healthCheck(ctx);
    if (!report.ok) {
      await db().from("municipalities").update({ status: "broken" }).eq("id", municipality.id);
      // 이 창구의 잡을 가진 테넌트들에게 사전 경고
      const { data: jobs } = await db()
        .from("submission_jobs")
        .select("id, tenant_id")
        .eq("window_id", payload.windowId)
        .in("status", ["pending", "queued"]);
      for (const j of jobs ?? []) {
        await db().from("notifications").upsert(
          {
            tenant_id: j.tenant_id,
            channel: "email",
            type: "precheck_failed",
            ref_id: j.id,
            payload: { failures: report.failures },
          },
          { onConflict: "type,ref_id,channel,user_id", ignoreDuplicates: true },
        );
      }
    }
  });
}
