import type { AuditSink } from "@youni/adapters";
import { db } from "./db.js";
import { logger } from "./logger.js";

/**
 * 감사 증적 저장: audit/{tenantId}/{jobId}/{attemptNo}/NN-step.png|html
 * 저장 경로는 submission_attempts.screenshots에 누적 기록된다.
 */
export function storageAuditSink(
  tenantId: string,
  jobId: string,
  attemptNo: number,
  onSaved: (path: string) => void,
): AuditSink {
  let seq = 0;
  const base = `${tenantId}/${jobId}/${attemptNo}`;
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9가-힣]+/g, "-").slice(0, 40);

  async function save(name: string, ext: string, body: Buffer | string, contentType: string) {
    const path = `${base}/${String(seq++).padStart(2, "0")}-${slug(name)}.${ext}`;
    const { error } = await db().storage.from("audit").upload(path, body, {
      contentType,
      upsert: true,
    });
    if (error) {
      logger.warn({ error, path }, "audit upload failed");
      return path;
    }
    onSaved(path);
    return path;
  }

  return {
    saveScreenshot: (step, png) => save(step, "png", png, "image/png"),
    saveHtml: (step, html) => save(step, "html", html, "text/html"),
  };
}
