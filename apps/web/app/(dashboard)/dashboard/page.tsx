import Link from "next/link";
import { createSupabaseServer } from "@/lib/supabase/server";

const STATUS_KO: Record<string, string> = {
  pending: "대기",
  queued: "예약됨",
  running: "제출 중",
  awaiting_captcha: "캡차 입력 필요",
  needs_manual: "수동 처리 필요",
  submitted: "제출 완료",
  failed: "실패",
  cancelled: "취소",
};

export default async function DashboardPage() {
  const supabase = await createSupabaseServer();

  const [{ data: jobs }, { data: windows }] = await Promise.all([
    supabase
      .from("submission_jobs")
      .select(
        "id, status, receipt_no, submitted_at, error_detail, created_at, application_requests(municipality_id), application_windows(opens_at, closes_at)",
      )
      .order("created_at", { ascending: false })
      .limit(30),
    supabase
      .from("application_windows")
      .select("id, opens_at, closes_at, status, municipalities(name)")
      .in("status", ["upcoming", "open"])
      .order("opens_at")
      .limit(10),
  ]);

  return (
    <>
      <h1>신청 현황</h1>

      <div className="card">
        <h3>다가오는 신청 기간</h3>
        <table className="list">
          <thead>
            <tr>
              <th>지자체</th>
              <th>접수 시작</th>
              <th>접수 마감</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {(windows ?? []).map((w) => (
              <tr key={w.id}>
                <td>{(w.municipalities as unknown as { name: string } | null)?.name}</td>
                <td>{new Date(w.opens_at).toLocaleString("ko-KR")}</td>
                <td>{new Date(w.closes_at).toLocaleString("ko-KR")}</td>
                <td>
                  <span className="badge">{w.status === "open" ? "접수 중" : "예정"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>내 신청 잡</h3>
        <table className="list">
          <thead>
            <tr>
              <th>상태</th>
              <th>접수번호</th>
              <th>제출 시각</th>
              <th>비고</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(jobs ?? []).map((j) => (
              <tr key={j.id}>
                <td>
                  <span className={`badge ${j.status}`}>{STATUS_KO[j.status] ?? j.status}</span>
                </td>
                <td>{j.receipt_no ?? "—"}</td>
                <td>{j.submitted_at ? new Date(j.submitted_at).toLocaleString("ko-KR") : "—"}</td>
                <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {j.error_detail ?? ""}
                </td>
                <td>
                  <Link href={`/jobs/${j.id}`}>타임라인</Link>
                </td>
              </tr>
            ))}
            {(jobs ?? []).length === 0 && (
              <tr>
                <td colSpan={5}>아직 신청 잡이 없습니다. 자동 신청을 등록해 보세요.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
