import {
  AdapterError,
  createAuditTrail,
  getAdapter,
  memorySink,
  type CrawlContext,
  type MunicipalityAdapter,
  type ResultRowDraft,
  type SubmitContext,
} from "@youni/adapters";
import { decryptSecret, loadEncKey, resultsJobPayloadSchema } from "@youni/core";
import type {
  ApplicationRequestRow,
  MunicipalityRow,
  SiteCredentialRow,
  SubmissionJobRow,
} from "@youni/db";
import type { Job } from "bullmq";
import { chromium, type Browser } from "playwright";
import { db } from "../db.js";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * 결과 수집: fetchResults → results 저장 → 잡 매칭 → 알림.
 *
 * 두 경로:
 * - 공개 결과 페이지: 미인증 크롤 1회 (기존 경로)
 * - resultsRequireLogin(uriad 계열): 결과가 개인 마이페이지에만 있으므로, 이 창구의
 *   submitted 잡들을 credential별로 묶어 각 사용자로 로그인 후 마이페이지를 파싱한다.
 *
 * 매칭: 접수번호 정확 일치 = exact(자동 통과). 인증 경로에서 접수번호가 없으면
 * 그 사용자 잡 1건·결과 1건일 때만 fuzzy(관리자 확인 큐 경유). 그 외는 미매칭 보관.
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

  const { data: jobsData } = await db()
    .from("submission_jobs")
    .select("*")
    .eq("window_id", payload.windowId)
    .eq("status", "submitted");
  const jobs = (jobsData ?? []) as SubmissionJobRow[];

  const browser = await chromium.launch({ headless: true });
  try {
    const decided = adapter.meta.resultsRequireLogin
      ? await collectAuthenticated(browser, adapter, municipality, window_, jobs)
      : await collectPublic(browser, adapter, municipality, window_, jobs);

    if (!decided) return; // 아직 발표 전 — 다음 버킷에서 재시도

    await db().from("application_windows").update({ status: "results_out" }).eq("id", payload.windowId);
  } finally {
    await browser.close().catch(() => {});
  }
}

type WindowRow = { id: string; opens_at: string; closes_at: string; target_period_start: string };

/** 공개 결과 페이지 경로 — 접수번호 exact 매칭만 자동 통과 */
async function collectPublic(
  browser: Browser,
  adapter: MunicipalityAdapter,
  municipality: MunicipalityRow,
  window_: WindowRow,
  jobs: SubmissionJobRow[],
): Promise<boolean> {
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
  await page.close().catch(() => {});
  if (rows.length === 0) return false;

  const byReceipt = new Map(jobs.filter((j) => j.receipt_no).map((j) => [j.receipt_no!, j]));
  let matched = 0;
  for (const row of rows) {
    const job = row.receiptNo ? byReceipt.get(row.receiptNo) : undefined;
    matched += await saveResult(municipality, window_.id, row, job, job ? "exact" : null);
  }
  logger.info({ windowId: window_.id, rows: rows.length, matched }, "results crawled (public)");
  return true;
}

/**
 * uriad 계열 인증 경로 — submitted 잡을 credential별로 묶어 각 사용자 마이페이지 파싱.
 * 반환: 결과 발표가 확인됐는가(1건 이상 selected/rejected 행 발견).
 */
async function collectAuthenticated(
  browser: Browser,
  adapter: MunicipalityAdapter,
  municipality: MunicipalityRow,
  window_: WindowRow,
  jobs: SubmissionJobRow[],
): Promise<boolean> {
  if (jobs.length === 0) return true; // 수집할 대상이 없음 — 창구 종료 처리

  // 잡 → request → credential 로 그룹핑
  const requestIds = [...new Set(jobs.map((j) => j.request_id))];
  const { data: reqData } = await db()
    .from("application_requests")
    .select("*")
    .in("id", requestIds);
  const requests = new Map(((reqData ?? []) as ApplicationRequestRow[]).map((r) => [r.id, r]));

  const byCredential = new Map<string, SubmissionJobRow[]>();
  for (const job of jobs) {
    const credId = requests.get(job.request_id)?.credential_id;
    if (!credId) continue;
    byCredential.set(credId, [...(byCredential.get(credId) ?? []), job]);
  }

  let decidedRows = 0;
  for (const [credId, credJobs] of byCredential) {
    try {
      const { data: cred } = await db()
        .from("site_credentials")
        .select("*")
        .eq("id", credId)
        .single();
      if (!cred) continue;
      const credential = cred as SiteCredentialRow;

      const page = await browser.newPage();
      try {
        const ctx: SubmitContext = {
          page,
          audit: createAuditTrail(page, memorySink()),
          log: (msg) => logger.info({ credId }, msg),
          dryRun: true, // 결과 조회만 — 제출 경로 아님
          onCaptcha: () => Promise.reject(new Error("captcha not supported in results crawl")),
        };
        const password = decryptSecret(
          { iv: credential.enc_iv, data: credential.password_enc },
          loadEncKey(env.CREDENTIALS_ENC_KEY),
        );
        await adapter.login(ctx, { username: credential.username, password });

        const rows = await adapter.fetchResults(ctx, {
          opensAt: window_.opens_at,
          closesAt: window_.closes_at,
          targetPeriodStart: window_.target_period_start,
        });

        // 발표 전에는 outcome을 알 수 없는 행(신청현황)만 보인다 — 결정된 행만 저장
        const decided = rows.filter((r) => r.outcome !== "unknown");
        decidedRows += decided.length;

        const byReceipt = new Map(credJobs.filter((j) => j.receipt_no).map((j) => [j.receipt_no!, j]));
        for (const row of decided) {
          let job = row.receiptNo ? byReceipt.get(row.receiptNo) : undefined;
          let confidence: "exact" | "fuzzy" | null = job ? "exact" : null;
          // 접수번호 부재 시: 이 사용자 잡 1건·결정 행 1건이면 fuzzy 매칭(관리자 확인 경유)
          if (!job && credJobs.length === 1 && decided.length === 1) {
            job = credJobs[0];
            confidence = "fuzzy";
          }
          await saveResult(municipality, window_.id, row, job, confidence);
        }
      } finally {
        await page.close().catch(() => {});
      }
    } catch (err) {
      // 한 사용자 실패가 전체 수집을 막지 않도록 — 로그인 실패는 credential 무효 마킹
      if (err instanceof AdapterError && err.code === "login_failed") {
        await db().from("site_credentials").update({ status: "invalid" }).eq("id", credId);
      }
      logger.warn({ credId, err: String(err) }, "authenticated result crawl failed for credential");
    }
  }

  if (decidedRows === 0) return false;
  logger.info({ windowId: window_.id, decidedRows }, "results crawled (authenticated)");
  return true;
}

/** 결과 행 저장 + 매칭 잡 알림. 반환: 매칭 성공 수(0|1) */
async function saveResult(
  municipality: MunicipalityRow,
  windowId: string,
  row: ResultRowDraft,
  job: SubmissionJobRow | undefined,
  confidence: "exact" | "fuzzy" | null,
): Promise<number> {
  const outcome = row.outcome === "unknown" ? null : row.outcome;
  const { data: inserted } = await db()
    .from("results")
    .insert({
      window_id: windowId,
      municipality_id: municipality.id,
      raw_row: row.raw,
      matched_job_id: job?.id ?? null,
      match_confidence: job ? confidence : null,
      outcome,
      reviewed: confidence === "exact", // exact만 자동 통과, fuzzy는 관리자 확인 큐
    })
    .select("id")
    .single();

  if (!job || !outcome || !inserted) return 0;
  await db().from("notifications").upsert(
    {
      tenant_id: job.tenant_id,
      channel: "email",
      type: outcome === "selected" ? "result_selected" : "result_rejected",
      ref_id: job.id,
      payload: { resultId: inserted.id, windowId },
    },
    { onConflict: "type,ref_id,channel,user_id", ignoreDuplicates: true },
  );
  return 1;
}
