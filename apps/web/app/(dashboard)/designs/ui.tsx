"use client";

import { useState, useTransition } from "react";
import { runValidation, uploadDesign } from "./actions";

export function DesignUploadForm() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <form
      className="stack"
      action={(formData) =>
        startTransition(async () => {
          const res = await uploadDesign(formData);
          setMessage(res.message);
        })
      }
    >
      <input type="file" name="file" accept=".jpg,.jpeg,.png" required />
      <button type="submit" disabled={pending}>
        {pending ? "업로드 중..." : "업로드"}
      </button>
      {message && <p style={{ fontSize: 13 }}>{message}</p>}
    </form>
  );
}

export function ValidateForm({
  designId,
  municipalities,
}: {
  designId: string;
  municipalities: { id: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const [muniId, setMuniId] = useState(municipalities[0]?.id ?? "");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <select value={muniId} onChange={(e) => setMuniId(e.target.value)}>
        {municipalities.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <button
        disabled={pending || !muniId}
        onClick={() =>
          startTransition(async () => {
            const res = await runValidation(designId, muniId);
            setMessage(res.message);
          })
        }
      >
        {pending ? "AI 검증 중..." : "규격 검증"}
      </button>
      {message && <span style={{ fontSize: 13 }}>{message}</span>}
    </div>
  );
}
