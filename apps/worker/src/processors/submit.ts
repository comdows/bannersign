import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterError,
  createAuditTrail,
  getAdapter,
  type SubmissionInput,
  type SubmitContext,
} from "@youni/adapters";
import { decryptSecret, loadEncKey, type SubmissionErrorCode } from "@youni/core";
import type {
  AdvertiserProfileRow,
  ApplicationRequestRow,
  BoardSiteRow,
  DesignRow,
  MunicipalityRow,
  SiteCredentialRow,
  SubmissionJobRow,
} from "@youni/db";
import type { Job } from "bullmq";
import { chromium } from "playwright";
import { submitJobPayloadSchema } from "@youni/core";
import { storageAuditSink } from "../audit.js";
import { relayCaptcha } from "../captcha.js";
import { db } from "../db.js";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { getQueue } from "../queues.js";

/** 오류 유형별 재시도 정책 (지수 백오프는 delay 재큐잉으로 구현) */
const RETRY_DELAYS_MS: Partial<Record<SubmissionErrorCode, number[]>> = {
  network: [60_000, 300_000, 900_000, 3_600_000, 10_800_000],
  site_down: [60_000, 300_000, 900_000, 3_600_000, 10_800_000],
  not_open_yet: [1_800_000], // 30분 폴링 (창구 마감까지 반복)
  captcha_timeout: [3_600_000, 3_600_000, 3_600_000],
};

export async function processSubmitJob(bullJob: Job): Promise<void> {
  const payload = submitJobPayloadSchema.parse(bullJob.data);
  const jobId = payload.submissionJobId;

  const job = await loadJob(jobId);
  if (!job) return;
  if (["submitted", "cancelled", "failed"].includes(job.status)) return;

  const ctx = await loadJobContext(job);
  if ("skip" in ctx) {
    await markJob(jobId, { status: "needs_manual", error_code: ctx.code, error_detail: ctx.detail });
    await notify(job.tenant_id, "needs_manual", jobId, { reason: ctx.detail });
    return;
  }

  const attemptNo = await nextAttemptNo(jobId);
  const screenshots: string[] = [];
  const { data: attempt } = await db()
    .from("submission_attempts")
    .insert({ job_id: jobId, tenant_id: job.tenant_id, attempt_no: attemptNo, screenshots: [] })
    .select("id")
    .single();

  await markJob(jobId, { status: "running" });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const sink = storageAuditSink(job.tenant_id, jobId, attemptNo, (p) => screenshots.push(p));
  const audit = createAuditTrail(page, sink);
  const tmpDir = await mkdtemp(join(tmpdir(), "design-"));

  const submitCtx: SubmitContext = {
    page,
    audit,
    log: (msg) => logger.info({ jobId }, msg),
    dryRun: job.dry_run || payload.dryRun,
    onCaptcha: (img) => relayCaptcha(job.tenant_id, jobId, img),
  };

  try {
    const adapter = getAdapter(ctx.municipality.adapter_key);
    if (!adapter.meta.autoSubmit || !ctx.municipality.capabilities.autoSubmit) {
      throw new AdapterError("unknown", "auto submit disabled for this municipality", false);
    }

    // 시안 다운로드 → 임시 파일 (제출 폼 업로드용)
    const { data: designFile, error: dlErr } = await db()
      .storage.from("designs")
      .download(ctx.design.storage_path);
    if (dlErr || !designFile) throw new AdapterError("unknown", "design download failed", true);
    const designPath = join(tmpDir, ctx.design.file_name);
    await writeFile(designPath, Buffer.from(await designFile.arrayBuffer()));

    // 사이트 계정 복호화 — 제출 직전에만, 메모리에서만
    const password = decryptSecret(
      { iv: ctx.credential.enc_iv, data: ctx.credential.password_enc },
      loadEncKey(env.CREDENTIALS_ENC_KEY),
    );

    await adapter.login(submitCtx, { username: ctx.credential.username, password });
    await db()
      .from("site_credentials")
      .update({ status: "ok", last_login_ok_at: new Date().toISOString() })
      .eq("id", ctx.credential.id);

    const input: SubmissionInput = {
      profile: {
        businessName: ctx.profile.business_name,
        bizRegNo: ctx.profile.biz_reg_no ?? undefined,
        representative: ctx.profile.representative ?? undefined,
        phone: ctx.profile.phone,
        email: ctx.profile.email ?? undefined,
        address: ctx.profile.address ?? undefined,
      },
      boardPreferences: ctx.boardPrefs,
      designFilePath: designPath,
      targetPeriod: { start: ctx.window.target_period_start, end: ctx.window.target_period_end },
    };

    const receipt = await adapter.submitApplication(submitCtx, input);

    await markJob(jobId, {
      status: receipt.dryRun ? "needs_manual" : "submitted",
      submitted_at: receipt.submittedAt,
      receipt_no: receipt.receiptNo ?? null,
      error_code: null,
      error_detail: receipt.dryRun ? "dry-run 완료 (실제 제출 안 됨)" : null,
    });
    await finishAttempt(attempt?.id, "ok", audit.steps.at(-1), screenshots);
    await notify(job.tenant_id, receipt.dryRun ? "needs_manual" : "submit_ok", jobId, {
      receiptNo: receipt.receiptNo,
      dryRun: receipt.dryRun,
      board: receipt.selectedBoardExternalId,
    });
  } catch (err) {
    await handleFailure(job, err, attempt?.id, audit.steps.at(-1), screenshots);
  } finally {
    await browser.close().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleFailure(
  job: SubmissionJobRow,
  err: unknown,
  attemptId: string | undefined,
  lastStep: string | undefined,
  screenshots: string[],
): Promise<void> {
  const code: SubmissionErrorCode = err instanceof AdapterError ? err.code : "unknown";
  const detail = err instanceof Error ? err.message : String(err);
  logger.warn({ jobId: job.id, code, detail }, "submit attempt failed");
  await finishAttempt(attemptId, code, lastStep, screenshots, detail);

  const attemptNo = await nextAttemptNo(job.id);
  const delays = RETRY_DELAYS_MS[code];
  const retryIdx = attemptNo - 2; // attempt 1 실패 → 첫 재시도 delay
  const windowStillOpen = await isWindowOpen(job.window_id);

  const canRetry =
    delays !== undefined &&
    windowStillOpen &&
    (code === "not_open_yet" ? true : retryIdx < delays.length);

  if (canRetry) {
    const delay = delays[Math.min(Math.max(retryIdx, 0), delays.length - 1)]!;
    await markJob(job.id, { status: "queued", error_code: code, error_detail: detail });
    await getQueue("submit").add(
      "submit",
      { kind: "submit", submissionJobId: job.id },
      { jobId: `${job.id}-retry-${attemptNo}`, delay, attempts: 1 },
    );
    return;
  }

  // 재시도 불가: 자격 문제/매진/사이트 변경 등 → 상태 분기
  if (code === "login_failed") {
    await db()
      .from("site_credentials")
      .update({ status: "invalid" })
      .eq("id", (await loadRequest(job.request_id))?.credential_id ?? "");
  }
  if (code === "selector_missing") {
    // 사이트 구조 변경 의심 — 지자체 broken 마킹 (운영자 확인 후 복구)
    const req = await loadRequest(job.request_id);
    if (req) {
      await db().from("municipalities").update({ status: "broken" }).eq("id", req.municipality_id);
    }
  }

  const terminal = code === "already_submitted" ? "submitted" : windowStillOpen ? "needs_manual" : "failed";
  await markJob(job.id, { status: terminal, error_code: code, error_detail: detail });
  await notify(job.tenant_id, terminal === "needs_manual" ? "needs_manual" : "submit_fail", job.id, {
    code,
    detail,
  });
}

// ---------- helpers ----------

interface JobContext {
  municipality: MunicipalityRow;
  profile: AdvertiserProfileRow;
  credential: SiteCredentialRow;
  design: DesignRow;
  window: { target_period_start: string; target_period_end: string };
  boardPrefs: SubmissionInput["boardPreferences"];
}

async function loadJobContext(
  job: SubmissionJobRow,
): Promise<JobContext | { skip: true; code: SubmissionErrorCode; detail: string }> {
  const req = await loadRequest(job.request_id);
  if (!req) return { skip: true, code: "unknown", detail: "application_request not found" };
  if (!req.credential_id) return { skip: true, code: "login_failed", detail: "사이트 계정 미등록" };

  const [muni, profile, credential, design, window_] = await Promise.all([
    single<MunicipalityRow>("municipalities", req.municipality_id),
    single<AdvertiserProfileRow>("advertiser_profiles", req.profile_id),
    single<SiteCredentialRow>("site_credentials", req.credential_id),
    single<DesignRow>("designs", req.design_id),
    single<{ target_period_start: string; target_period_end: string }>(
      "application_windows",
      job.window_id,
    ),
  ]);
  if (!muni || !profile || !credential || !design || !window_) {
    return { skip: true, code: "unknown", detail: "job context incomplete" };
  }

  const boardIds = req.board_preferences.map((b) => b.boardSiteId);
  const { data: boards } = await db()
    .from("board_sites")
    .select("id, external_id, name")
    .in("id", boardIds.length > 0 ? boardIds : ["00000000-0000-0000-0000-000000000000"]);
  const boardMap = new Map((boards as Pick<BoardSiteRow, "id" | "external_id" | "name">[] | null)?.map((b) => [b.id, b]) ?? []);

  return {
    municipality: muni,
    profile,
    credential,
    design,
    window: window_,
    boardPrefs: req.board_preferences
      .filter((p) => boardMap.has(p.boardSiteId))
      .map((p) => ({
        ...p,
        externalId: boardMap.get(p.boardSiteId)!.external_id,
        boardName: boardMap.get(p.boardSiteId)!.name,
      })),
  };
}

async function single<T>(table: string, id: string): Promise<T | null> {
  const { data } = await db().from(table).select("*").eq("id", id).maybeSingle();
  return data as T | null;
}

async function loadJob(id: string): Promise<SubmissionJobRow | null> {
  return single<SubmissionJobRow>("submission_jobs", id);
}

async function loadRequest(id: string): Promise<ApplicationRequestRow | null> {
  return single<ApplicationRequestRow>("application_requests", id);
}

async function markJob(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("submission_jobs").update(patch).eq("id", id);
  if (error) logger.error({ error, id, patch }, "job update failed");
}

async function nextAttemptNo(jobId: string): Promise<number> {
  const { count } = await db()
    .from("submission_attempts")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  return (count ?? 0) + 1;
}

async function finishAttempt(
  attemptId: string | undefined,
  outcome: string,
  stepReached: string | undefined,
  screenshots: string[],
  errorDetail?: string,
): Promise<void> {
  if (!attemptId) return;
  await db()
    .from("submission_attempts")
    .update({
      ended_at: new Date().toISOString(),
      outcome,
      step_reached: stepReached ?? null,
      screenshots,
      error_detail: errorDetail ?? null,
    })
    .eq("id", attemptId);
}

async function isWindowOpen(windowId: string): Promise<boolean> {
  const { data } = await db()
    .from("application_windows")
    .select("closes_at")
    .eq("id", windowId)
    .maybeSingle();
  return data ? new Date(data.closes_at).getTime() > Date.now() : false;
}

async function notify(
  tenantId: string,
  type: string,
  refId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db()
    .from("notifications")
    .upsert(
      { tenant_id: tenantId, channel: "email", type, ref_id: refId, payload },
      { onConflict: "type,ref_id,channel,user_id", ignoreDuplicates: true },
    );
}
