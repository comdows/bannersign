"use client";

import { useState, useTransition } from "react";
import { createRequest } from "./actions";

interface Props {
  municipalities: { id: string; name: string; status: string }[];
  profiles: { id: string; business_name: string }[];
  credentials: { id: string; municipality_id: string; username: string; status: string }[];
  designs: { id: string; file_name: string }[];
  boards: { id: string; municipality_id: string; name: string }[];
}

export function RequestForm({ municipalities, profiles, credentials, designs, boards }: Props) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [muniId, setMuniId] = useState(municipalities[0]?.id ?? "");

  const muniCredentials = credentials.filter((c) => c.municipality_id === muniId);
  const muniBoards = boards.filter((b) => b.municipality_id === muniId);

  return (
    <form
      className="stack"
      action={(fd) =>
        startTransition(async () => {
          const res = await createRequest(fd);
          setMessage(res.message);
        })
      }
    >
      <label>
        지자체
        <select name="municipality_id" value={muniId} onChange={(e) => setMuniId(e.target.value)}>
          {municipalities.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.status !== "active" ? ` (${m.status})` : ""}
            </option>
          ))}
        </select>
      </label>

      <label>
        사업자 프로필
        <select name="profile_id" required>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.business_name}
            </option>
          ))}
        </select>
      </label>

      <label>
        사이트 계정 (자동 제출용)
        <select name="credential_id">
          <option value="">— 없음 (수동 신청 안내만) —</option>
          {muniCredentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.username} ({c.status})
            </option>
          ))}
        </select>
      </label>

      <label>
        시안
        <select name="design_id" required>
          {designs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.file_name}
            </option>
          ))}
        </select>
      </label>

      <fieldset style={{ border: "1px solid #ddd", borderRadius: 6, padding: 10 }}>
        <legend style={{ fontSize: 13 }}>희망 게시대 (선택 순서 = 우선순위)</legend>
        {muniBoards.length === 0 && <p style={{ fontSize: 13, color: "#777" }}>게시대 정보 수집 전입니다.</p>}
        {muniBoards.map((b) => (
          <label key={b.id} style={{ display: "block", fontSize: 14 }}>
            <input type="checkbox" name="board_ids" value={b.id} /> {b.name}
          </label>
        ))}
      </fieldset>

      <label>
        반복
        <select name="recurrence" defaultValue="monthly">
          <option value="monthly">매월 자동 신청</option>
          <option value="once">다음 1회만</option>
        </select>
      </label>

      <button type="submit" disabled={pending}>
        {pending ? "등록 중..." : "자동 신청 등록"}
      </button>
      {message && <p style={{ fontSize: 13 }}>{message}</p>}
    </form>
  );
}
