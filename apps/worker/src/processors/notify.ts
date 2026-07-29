import type { Job } from "bullmq";
import { db } from "../db.js";
import { env } from "../env.js";
import { logger } from "../logger.js";

interface NotificationRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  channel: "email" | "webpush" | "alimtalk";
  type: string;
  ref_id: string | null;
  payload: Record<string, unknown>;
}

/**
 * 알림 디스패처 — pending 알림을 채널별로 발송.
 * email: Resend REST API. RESEND_API_KEY 미설정이면 스텁(로그+sent 마킹)으로 폴백해
 * 워커 가동을 막지 않는다. webpush/alimtalk은 Phase 3~4(SPEC-NOTIFY-02).
 */
export async function processNotifyBatch(_job: Job): Promise<void> {
  const { data: pending } = await db()
    .from("notifications")
    .select("*")
    .eq("status", "pending")
    .limit(50);

  for (const n of (pending ?? []) as NotificationRow[]) {
    if (n.channel !== "email" || !env.RESEND_API_KEY) {
      // 미지원 채널/키 미설정 — 스텁: 쌓임 방지를 위해 sent 처리하되 로그로 구분
      logger.info({ id: n.id, type: n.type, channel: n.channel }, "notification dispatched (stub)");
      await markSent(n.id);
      continue;
    }

    try {
      const recipients = await resolveRecipients(n);
      if (recipients.length === 0) {
        logger.warn({ id: n.id, tenantId: n.tenant_id }, "notification has no recipient email");
        await db().from("notifications").update({ status: "failed" }).eq("id", n.id);
        continue;
      }

      const { subject, body } = renderEmail(n);
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: env.NOTIFY_FROM_EMAIL, to: recipients, subject, text: body }),
      });

      if (res.ok) {
        await markSent(n.id);
        logger.info({ id: n.id, type: n.type, to: recipients.length }, "email sent");
      } else if (res.status >= 500 || res.status === 429) {
        // 일시 오류 — pending 유지, 다음 배치에서 재시도
        logger.warn({ id: n.id, status: res.status }, "email send transient failure, will retry");
      } else {
        // 4xx: 요청 자체가 잘못됨(도메인 미인증, 수신자 형식 등) — 재시도 무의미
        const detail = await res.text().catch(() => "");
        logger.error({ id: n.id, status: res.status, detail }, "email send rejected");
        await db().from("notifications").update({ status: "failed" }).eq("id", n.id);
      }
    } catch (err) {
      // 네트워크 오류 — pending 유지 재시도
      logger.warn({ id: n.id, err: String(err) }, "email send error, will retry");
    }
  }
}

async function markSent(id: string): Promise<void> {
  await db()
    .from("notifications")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", id);
}

/** user_id 지정 알림은 그 사용자에게, 테넌트 전체 알림은 모든 멤버에게 */
async function resolveRecipients(n: NotificationRow): Promise<string[]> {
  const userIds: string[] = [];
  if (n.user_id) {
    userIds.push(n.user_id);
  } else {
    const { data: members } = await db()
      .from("tenant_members")
      .select("user_id")
      .eq("tenant_id", n.tenant_id);
    userIds.push(...((members ?? []) as Array<{ user_id: string }>).map((m) => m.user_id));
  }

  const emails: string[] = [];
  for (const uid of userIds) {
    const { data, error } = await db().auth.admin.getUserById(uid);
    if (!error && data.user?.email) emails.push(data.user.email);
  }
  return [...new Set(emails)];
}

/** 유형별 한글 템플릿 — 상세는 대시보드에서 확인하도록 링크 대신 요약만 담는다 */
function renderEmail(n: NotificationRow): { subject: string; body: string } {
  const p = n.payload ?? {};
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);

  switch (n.type) {
    case "window_upcoming":
      return {
        subject: "[유니] 현수막 게시대 신청 창구가 곧 열립니다",
        body:
          "등록하신 자동 신청이 준비되었습니다. 창구가 열리면 자동으로 제출됩니다.\n" +
          "시안·사이트 계정 상태를 미리 확인해 주세요.\n\n" + detailBlock(p),
      };
    case "submit_ok":
      return {
        subject: "[유니] 신청 제출 완료" + (str("receiptNo") ? ` (접수번호 ${str("receiptNo")})` : ""),
        body: "현수막 게시대 신청이 정상 제출되었습니다.\n\n" + detailBlock(p),
      };
    case "submit_fail":
      return {
        subject: "[유니] 신청 제출 실패 — 확인이 필요합니다",
        body:
          "자동 신청이 실패했습니다. 대시보드에서 원인을 확인해 주세요.\n" +
          "창구 마감 전이라면 수동 신청을 권장합니다.\n\n" + detailBlock(p),
      };
    case "needs_manual":
      return {
        subject: "[유니] 수동 처리가 필요한 신청이 있습니다",
        body:
          "자동으로 마무리하지 못한 신청이 있습니다(dry-run 검증 완료 또는 재시도 소진).\n" +
          "대시보드의 신청 현황을 확인해 주세요.\n\n" + detailBlock(p),
      };
    case "captcha_needed":
      return {
        subject: "[유니] ⏰ 캡차 입력이 필요합니다 (신청 진행 중)",
        body:
          "자동 신청 진행 중 캡차가 나타났습니다. 대시보드 > 캡차 화면에서 바로 입력해 주세요.\n" +
          "시간이 지나면 재시도로 넘어갑니다.\n\n" + detailBlock(p),
      };
    case "precheck_failed":
      return {
        subject: "[유니] 사전 점검 실패 — 창구 오픈 전 확인 필요",
        body:
          "창구 오픈 전 사전 점검(로그인/사이트 상태)에 실패했습니다.\n" +
          "사이트 계정이 유효한지 확인해 주세요.\n\n" + detailBlock(p),
      };
    case "result_selected":
      return {
        subject: "[유니] 🎉 게시대 추첨 당첨",
        body: "신청하신 현수막 게시대에 당첨되었습니다! 수수료 납부·게시 일정을 확인하세요.\n\n" + detailBlock(p),
      };
    case "result_rejected":
      return {
        subject: "[유니] 게시대 추첨 결과 안내",
        body:
          "아쉽게도 이번 추첨에는 선정되지 않았습니다.\n" +
          "다음 달 창구에 자동으로 다시 신청됩니다(상시 주문 기준).\n\n" + detailBlock(p),
      };
    default:
      return {
        subject: `[유니] 알림: ${n.type}`,
        body: detailBlock(p),
      };
  }
}

function detailBlock(p: Record<string, unknown>): string {
  const entries = Object.entries(p).filter(([, v]) => v !== null && v !== undefined);
  if (entries.length === 0) return "";
  return "―――\n" + entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
}
