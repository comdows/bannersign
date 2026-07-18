import type { DesignFinding } from "@youni/core";
import { createSupabaseServer } from "@/lib/supabase/server";
import { DesignUploadForm, ValidateForm } from "./ui";

export default async function DesignsPage() {
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
        <DesignUploadForm />
      </div>

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
