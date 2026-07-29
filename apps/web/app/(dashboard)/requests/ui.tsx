"use client";

import { useState, useTransition } from "react";
import { createRequest } from "./actions";
import { BoardMap, type MapBoard } from "./board-map";

export interface BoardOption {
  id: string;
  municipality_id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  fee: number | null;
}

interface Props {
  municipalities: { id: string; name: string; status: string }[];
  profiles: { id: string; business_name: string }[];
  credentials: { id: string; municipality_id: string; username: string; status: string }[];
  designs: { id: string; file_name: string }[];
  boards: BoardOption[];
  kakaoAppKey: string | undefined;
}

export function RequestForm({ municipalities, profiles, credentials, designs, boards, kakaoAppKey }: Props) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [muniId, setMuniId] = useState(municipalities[0]?.id ?? "");
  /** 선택 순서 = 우선순위 (index 0 → 1순위) */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [listOpen, setListOpen] = useState(false);

  const muniCredentials = credentials.filter((c) => c.municipality_id === muniId);
  const muniBoards = boards.filter((b) => b.municipality_id === muniId);
  const mapBoards: MapBoard[] = muniBoards.filter((b): b is BoardOption & MapBoard => b.lat != null && b.lng != null);
  const noCoordBoards = muniBoards.filter((b) => b.lat == null || b.lng == null);
  const boardById = new Map(muniBoards.map((b) => [b.id, b]));

  const toggle = (id: string) =>
    setSelectedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const move = (id: string, dir: -1 | 1) =>
    setSelectedIds((cur) => {
      const i = cur.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <form
      className="stack"
      action={(fd) =>
        startTransition(async () => {
          const res = await createRequest(fd);
          setMessage(res.message);
          if (res.ok) setSelectedIds([]);
        })
      }
    >
      <label>
        지자체
        <select
          name="municipality_id"
          value={muniId}
          onChange={(e) => {
            setMuniId(e.target.value);
            setSelectedIds([]); // 지자체가 바뀌면 게시대 선택 초기화
          }}
        >
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
        <legend style={{ fontSize: 13 }}>희망 게시대 — 지도에서 클릭해 선택</legend>
        <p style={{ fontSize: 13, color: "#555", marginTop: 0 }}>
          클릭한 순서가 우선순위가 됩니다. 접수 때 1순위부터 시도하고, 마감된 게시대는 다음
          순위로 자동 이동해 <strong>최종 1곳만</strong> 신청합니다.
        </p>

        {muniBoards.length === 0 && <p style={{ fontSize: 13, color: "#777" }}>게시대 정보 수집 전입니다.</p>}

        <BoardMap boards={mapBoards} selectedIds={selectedIds} onToggle={toggle} appKey={kakaoAppKey} />

        {/* 선택 결과 = 우선순위 목록 (재정렬 가능) */}
        {selectedIds.length > 0 && (
          <ol style={{ paddingLeft: 20, fontSize: 14, marginBottom: 0 }}>
            {selectedIds.map((id) => {
              const b = boardById.get(id);
              if (!b) return null;
              return (
                <li key={id} style={{ marginTop: 4 }}>
                  {b.name}{" "}
                  <span style={{ color: "#888", fontSize: 12 }}>
                    {b.address ?? ""} {b.fee ? `· ${b.fee.toLocaleString()}원` : ""}
                  </span>{" "}
                  <button type="button" onClick={() => move(id, -1)} aria-label="위로">↑</button>{" "}
                  <button type="button" onClick={() => move(id, 1)} aria-label="아래로">↓</button>{" "}
                  <button type="button" onClick={() => toggle(id)} aria-label="제거">✕</button>
                </li>
              );
            })}
          </ol>
        )}

        {/* 목록 선택 폴백 — 지도 미로드/좌표 없는 게시대 포함 전체 목록 */}
        {muniBoards.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => setListOpen((o) => !o)} style={{ fontSize: 13 }}>
              {listOpen ? "목록 닫기" : `전체 목록에서 선택 (${muniBoards.length}곳)`}
            </button>
            {listOpen && (
              <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid #eee", borderRadius: 6, padding: 8, marginTop: 6 }}>
                {muniBoards.map((b) => {
                  const rank = selectedIds.indexOf(b.id);
                  return (
                    <label key={b.id} style={{ display: "block", fontSize: 14 }}>
                      <input type="checkbox" checked={rank >= 0} onChange={() => toggle(b.id)} />{" "}
                      {rank >= 0 ? `[${rank + 1}순위] ` : ""}
                      {b.name}{" "}
                      <span style={{ color: "#888", fontSize: 12 }}>
                        {b.address ?? ""}
                        {b.lat == null ? " (위치 정보 없음)" : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {noCoordBoards.length > 0 && !listOpen && (
              <p style={{ fontSize: 12, color: "#999", marginBottom: 0 }}>
                위치 정보가 없는 게시대 {noCoordBoards.length}곳은 전체 목록에서 선택할 수 있습니다.
              </p>
            )}
          </div>
        )}

        {/* 저장 형태: 선택 순서대로 board_ids — priority = 배열 순서 */}
        {selectedIds.map((id) => (
          <input key={id} type="hidden" name="board_ids" value={id} />
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
