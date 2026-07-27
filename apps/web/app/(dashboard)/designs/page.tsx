import type { DesignFinding } from "@youni/core";
import Link from "next/link";
import { createSupabaseServer, currentTenantId } from "@/lib/supabase/server";
import { DesignUploadForm, ValidateForm } from "./ui";

export default async function DesignsPage() {
  const tenantId = await currentTenantId();
  if (!tenantId) {
    return (
      <>
        <h1>시안 관리</h1>
        <div className="card">
          <p style={{ fontSize: 14 }}>
            시안을 올리려면 먼저 <Link href="/settings">설정</Link>에서 워크스페이스를 만들어
            주세요.
          </p>
        </div>
      </>
    );
  }
  const supabase = await createSupabaseServer();
  const [{ data: designs }, { data: municipalities }] = await Promise.all([
    supabase
      .from("designs")
      .select("*, design_validations(id, verdict, findings, municipality_id, spec_version, created_at)")
      .order("created_at", { ascending: false }),
    supabase.from("municipalities").select("id, name").order("name"),
  ]);

  const muniName = new Map((municipalities ?? []).map((m) => [m.id, m.name]));

  return (
    <>
      <h1>시안 관리</h1>

      <div className="card">
        <h3>시안 업로드 (JPG/PNG)</h3>
        <p style={{ fontSize: 13, color: "#555" }}>
          업로드 후 지자체를 선택해 AI 규격 검증을 돌려보세요. 사이즈·필수 문구·금지 콘텐츠를
          미리 점검하면 당첨 후 반려를 예방할 수 있습니다.
        </p>
        <DesignUploadForm />
      </div>

      {(designs ?? []).length === 0 && (
        <div className="card">
          <p style={{ fontSize: 14, color: "#555" }}>
            아직 시안이 없습니다. 위에서 현수막 시안 파일을 올리면 자동 신청에 사용할 수
            있습니다.
          </p>
        </div>
      )}

      {(designs ?? []).map((d) => (
        <div className="card" key={d.id}>
          <strong>{d.file_name}</strong>{" "}
          <span style={{ color: "#777", fontSize: 13 }}>
            {d.file_meta?.widthPx}×{d.file_meta?.heightPx}px
          </span>
          <div style={{ margin: "10px 0" }}>
            <ValidateForm designId={d.id} municipalities={municipalities ?? []} />
          </div>
          {(d.design_validations ?? []).map(
            (v: { id: string; verdict: string; findings: DesignFinding[]; municipality_id: string }) => (
              <div key={v.id} style={{ marginTop: 8 }}>
                <span className={`badge ${v.verdict}`}>
                  {muniName.get(v.municipality_id)} — {v.verdict.toUpperCase()}
                </span>
                <ul style={{ fontSize: 13, margin: "6px 0 0" }}>
                  {v.findings.map((f) => (
                    <li key={f.ruleId}>
                      <span className={`badge ${f.result}`}>{f.result}</span> {f.reasonKo}
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
      ))}
    </>
  );
}
