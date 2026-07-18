import type { Job } from "bullmq";
import { db } from "../db.js";
import { logger } from "../logger.js";

/**
 * 알림 디스패처 — pending 알림을 채널별로 발송.
 * MVP: 이메일(Resend) 연동 전까지는 로그 + sent 마킹만 수행 (인터페이스 자리).
 * TODO(Phase 3): Resend API 연동, webpush, 알림톡.
 */
export async function processNotifyBatch(_job: Job): Promise<void> {
  const { data: pending } = await db()
    .from("notifications")
    .select("*")
    .eq("status", "pending")
    .limit(50);

  for (const n of pending ?? []) {
    // 실제 발송 자리 — 채널별 어댑터 (email → Resend)
    logger.info({ id: n.id, type: n.type, channel: n.channel }, "notification dispatched (stub)");
    await db()
      .from("notifications")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", n.id);
  }
}
