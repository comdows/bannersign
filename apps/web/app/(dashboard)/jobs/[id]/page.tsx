import Link from "next/link";
import { notFound } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";

const STATUS_KO: Record<string, string> = {
  pending: "대기",
  queued: "예약됨",
  running: "제출 중",
  awaiting_captcha: "캡차 입력 필요",
  needs_manual: "수동 처리 필요",
  submitted: "제출 완료",
  dry_run_completed: "리허설 완료",
  failed: "실패",
  cancelled: "취소",
};

const OUTCOME_KO: Record<string, string> = {
  ok: "정상 완료",
  network: "네트워크 오류",
  site_down: "사이트 접속 불가",
  not_open_yet: "접수 기간 아님",
  login_failed: "로그인 실패",
  captcha_timeout: "캡차 시간 초과",
  selector_missing: "사이트 구조 변경 의심",
  boards_full: "게시대 마감",
  already_submitted: "이미 제출됨",
  dry_run_completed: "리허설 완료",
  audit_incomplete: "감사 증적 불완전",
  dry_run_safety_violation: "리허설 안전 경계 위반",
  unknown: "알 수 없는 오류",
};

interface AuditEvent {
  step: string;
  url: string;
  capturedAt: string;
  screenshotPath: string | null;
  htmlPath: string | null;
}

interface AttemptRow {
  id: string;
  attempt_no: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  step_reached: string | null;
  error_detail: string | null;
  screenshots: string[];
  audit_events: AuditEvent[];
}

function screenshotPaths(attempt: AttemptRow): string[] {
  const evidencePaths = attempt.audit_events
    .map((event) => event.screenshotPath)
    .filter((path): path is string => path !== null && path.length > 0);
  return evidencePaths.length > 0
    ? evidencePaths
    : attempt.screenshots.filter((path) => path.endsWith(".png"));
}

/** 스크린샷 경로(NN-단계명.png)에서 단계명 복원 */
function stepLabel(path: string): string {
  const file = path.split("/").at(-1) ?? path;
  return file.replace(/^\d+-/, "").replace(/\.(png|html)$/, "").replace(/-/g, " ");
}

/**
 * 제출 타임라인 — 잡 1건의 시도별 감사 증적(단계 스크린샷) 열람.
 * 자동 제출이 실제로 무엇을 했는지 증빙하는 화면 (신뢰·분쟁 대응 핵심).
 */
export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createSupabaseServer();

  const { data: job } = await supabase
    .from("submission_jobs")
    .select(
      "id, status, receipt_no, submitted_at, dry_run_completed_at, selected_board_site_id, error_code, error_detail, dry_run, created_at, application_windows(opens_at, closes_at, target_period_start, target_period_end), application_requests(municipalities(name))",
    )
    .eq("id", id)
    .maybeSingle();
  if (!job) notFound();

  const { data: attemptsData } = await supabase
    .from("submission_attempts")
    .select("id, attempt_no, started_at, ended_at, outcome, step_reached, error_detail, screenshots, audit_events")
    .eq("job_id", id)
    .order("attempt_no", { ascending: true });
  const attempts = (attemptsData ?? []) as AttemptRow[];

  // 스크린샷 서명 URL (1시간) — RLS로 본인 테넌트 경로만 조회 가능
  const allPaths = Array.from(new Set(attempts.flatMap((attempt) => screenshotPaths(attempt))));
  const urlByPath = new Map<string, string>();
  if (allPaths.length > 0) {
    const { data: signed } = await supabase.storage.from("audit").createSignedUrls(allPaths, 3600);
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
    }
  }

  const muni = (job.application_requests as unknown as { municipalities: { name: string } | null } | null)
    ?.municipalities?.name;
  const window_ = job.application_windows as unknown as {
    opens_at: string;
    closes_at: string;
    target_period_start: string;
    target_period_end: string;
  } | null;

  return (
    <>
      <p>
        <Link href="/dashboard">← 신청 현황</Link>
      </p>
      <h1>
        제출 타임라인 {muni ? `— ${muni}` : ""}{" "}
        <span className={`badge ${job.status}`}>{STATUS_KO[job.status] ?? job.status}</span>{" "}
        {job.dry_run && <span className="badge warn">리허설(dry-run)</span>}
      </h1>

      <div className="card">
        <table className="list">
          <tbody>
            <tr>
              <th>접수번호</th>
              <td>{job.receipt_no ?? "—"}</td>
              <th>{job.dry_run_completed_at ? "리허설 완료 시각" : "제출 시각"}</th>
              <td>
                {job.dry_run_completed_at || job.submitted_at
                  ? new Date(job.dry_run_completed_at ?? job.submitted_at!).toLocaleString("ko-KR")
                  : "—"}
              </td>
            </tr>
            <tr>
              <th>게시 기간</th>
              <td>
                {window_ ? `${window_.target_period_start} ~ ${window_.target_period_end}` : "—"}
              </td>
              <th>접수 창구</th>
              <td>
                {window_
                  ? `${new Date(window_.opens_at).toLocaleString("ko-KR")} ~ ${new Date(window_.closes_at).toLocaleString("ko-KR")}`
                  : "—"}
              </td>
            </tr>
            {job.error_detail && (
              <tr>
                <th>비고</th>
                <td colSpan={3}>
                  {job.error_code ? `[${OUTCOME_KO[job.error_code] ?? job.error_code}] ` : ""}
                  {job.error_detail}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {attempts.length === 0 && (
        <div className="card">
          <p>아직 시도 기록이 없습니다. 창구가 열리면 자동으로 진행됩니다.</p>
        </div>
      )}

      {attempts.map((a) => (
        <div className="card" key={a.id}>
          <h3>
            시도 #{a.attempt_no}{" "}
            {a.outcome && (
              <span className={`badge ${["ok", "dry_run_completed"].includes(a.outcome) ? "pass" : "fail"}`}>
                {OUTCOME_KO[a.outcome] ?? a.outcome}
              </span>
            )}
          </h3>
          <p style={{ color: "#666", fontSize: 13 }}>
            {new Date(a.started_at).toLocaleString("ko-KR")}
            {a.ended_at ? ` ~ ${new Date(a.ended_at).toLocaleString("ko-KR")}` : " (진행 중)"}
            {a.step_reached ? ` · 마지막 단계: ${a.step_reached}` : ""}
          </p>
          {a.error_detail && <p style={{ color: "#8f1d1d", fontSize: 13 }}>{a.error_detail}</p>}

          {a.audit_events.length > 0 && (
            <ol style={{ paddingLeft: 20, fontSize: 13 }}>
              {a.audit_events.map((event) => (
                <li key={`${event.step}-${event.capturedAt}`}>
                  <strong>{event.step}</strong> · {new Date(event.capturedAt).toLocaleString("ko-KR")} · {event.url}
                </li>
              ))}
            </ol>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {screenshotPaths(a).map((p, i) => {
              const url = urlByPath.get(p);
              return (
                <figure key={p} style={{ margin: 0, width: 220 }}>
                  <figcaption style={{ fontSize: 12, marginBottom: 4 }}>
                    {i + 1}. {stepLabel(p)}
                  </figcaption>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer">
                      {/* 감사 증적 원본 — 서명 URL이라 next/image 최적화 대상 아님 */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt={stepLabel(p)}
                        style={{ width: "100%", border: "1px solid #ddd", borderRadius: 4 }}
                      />
                    </a>
                  ) : (
                    <span style={{ fontSize: 12, color: "#999" }}>이미지 로드 불가</span>
                  )}
                </figure>
              );
            })}
            {screenshotPaths(a).length === 0 && (
              <span style={{ fontSize: 13, color: "#999" }}>스크린샷 없음</span>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
