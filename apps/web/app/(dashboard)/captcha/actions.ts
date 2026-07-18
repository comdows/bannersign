"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import type { ActionResult } from "../designs/actions";

/** 캡차 답 제출 — worker가 polling으로 감지해 제출을 이어간다 */
export async function answerCaptcha(relayId: string, answer: string): Promise<ActionResult> {
  if (!answer.trim()) return { ok: false, message: "답을 입력하세요." };
  const supabase = await createSupabaseServer();
  const { error } = await supabase
    .from("captcha_relays")
    .update({ answer: answer.trim(), status: "answered", answered_at: new Date().toISOString() })
    .eq("id", relayId)
    .eq("status", "waiting");
  if (error) return { ok: false, message: error.message };
  revalidatePath("/captcha");
  return { ok: true, message: "전송되었습니다. 제출이 계속됩니다." };
}
