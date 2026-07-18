import { CaptchaTimeoutError } from "@youni/adapters";
import { db } from "./db.js";
import { logger } from "./logger.js";

const CAPTCHA_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 3_000;

/**
 * 캡차 수동 릴레이:
 * 이미지 → Storage 업로드 → captcha_relays 레코드 + 잡 awaiting_captcha + 알림
 * → 사용자가 web 릴레이 UI에서 답 입력(DB update) → 폴링으로 감지 → 답 반환.
 * 타임아웃 시 CaptchaTimeoutError (worker 재시도 정책이 처리).
 */
export async function relayCaptcha(
  tenantId: string,
  jobId: string,
  imageBuffer: Buffer,
): Promise<string> {
  const imagePath = `${tenantId}/${jobId}/${Date.now()}.png`;
  await db().storage.from("captcha").upload(imagePath, imageBuffer, {
    contentType: "image/png",
    upsert: true,
  });

  const expiresAt = new Date(Date.now() + CAPTCHA_TIMEOUT_MS).toISOString();
  const { data: relay, error } = await db()
    .from("captcha_relays")
    .insert({ job_id: jobId, tenant_id: tenantId, image_path: imagePath, expires_at: expiresAt })
    .select("id")
    .single();
  if (error || !relay) throw error ?? new Error("captcha relay insert failed");

  await db().from("submission_jobs").update({ status: "awaiting_captcha" }).eq("id", jobId);
  await db().from("notifications").insert({
    tenant_id: tenantId,
    channel: "email",
    type: "captcha_needed",
    ref_id: relay.id,
    payload: { jobId, relayId: relay.id, expiresAt },
  });
  logger.info({ jobId, relayId: relay.id }, "captcha relay requested");

  const deadline = Date.now() + CAPTCHA_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const { data } = await db()
      .from("captcha_relays")
      .select("status, answer")
      .eq("id", relay.id)
      .single();
    if (data?.status === "answered" && data.answer) {
      await db().from("submission_jobs").update({ status: "running" }).eq("id", jobId);
      return data.answer;
    }
    if (data?.status === "cancelled") break;
  }

  await db().from("captcha_relays").update({ status: "expired" }).eq("id", relay.id);
  throw new CaptchaTimeoutError();
}
