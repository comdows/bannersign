"use client";

import { useMemo, useState } from "react";
import { BoardMap, type MapBoard } from "../requests/board-map";

interface BoardRow {
  id: string;
  municipality_id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  fee: number | null;
  slot_count: number | null;
  dimensions_cm: { width: number; height: number } | null;
  raw: { district?: string } | null;
}

interface Props {
  municipalities: { id: string; name: string; status: string }[];
  boards: BoardRow[];
  kakaoAppKey: string | undefined;
}

export function BoardsExplorer({ municipalities, boards, kakaoAppKey }: Props) {
  const withBoards = municipalities.filter((m) => boards.some((b) => b.municipality_id === m.id));
  const [muniId, setMuniId] = useState(withBoards[0]?.id ?? municipalities[0]?.id ?? "");
  const [district, setDistrict] = useState("");

  const muniBoards = useMemo(() => boards.filter((b) => b.municipality_id === muniId), [boards, muniId]);
  const districts = useMemo(
    () => [...new Set(muniBoards.map((b) => b.raw?.district).filter((d): d is string => Boolean(d)))].sort(),
    [muniBoards],
  );
  const visible = district ? muniBoards.filter((b) => b.raw?.district === district) : muniBoards;
  const mapBoards: MapBoard[] = visible.filter((b): b is BoardRow & MapBoard => b.lat != null && b.lng != null);

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={{ fontSize: 14 }}>
            지자체{" "}
            <select
              value={muniId}
              onChange={(e) => {
                setMuniId(e.target.value);
                setDistrict("");
              }}
            >
              {municipalities.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {boards.some((b) => b.municipality_id === m.id) ? "" : " (수집 전)"}
                </option>
              ))}
            </select>
          </label>
          {districts.length > 0 && (
            <label style={{ fontSize: 14 }}>
              읍/면/동{" "}
              <select value={district} onChange={(e) => setDistrict(e.target.value)}>
                <option value="">전체 ({muniBoards.length}곳)</option>
                {districts.map((d) => (
                  <option key={d} value={d}>
                    {d} ({muniBoards.filter((b) => b.raw?.district === d).length}곳)
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {muniBoards.length === 0 ? (
          <p style={{ fontSize: 13, color: "#777" }}>이 지자체는 아직 게시대 정보 수집 전입니다.</p>
        ) : (
          <div style={{ marginTop: 10 }}>
            <BoardMap boards={mapBoards} selectedIds={[]} appKey={kakaoAppKey} height={420} />
          </div>
        )}
      </div>

      {visible.length > 0 && (
        <div className="card">
          <h3>게시대 목록 ({visible.length}곳)</h3>
          <table className="list">
            <thead>
              <tr>
                <th>이름</th>
                <th>주소</th>
                <th>읍/면/동</th>
                <th>면수</th>
                <th>규격(cm)</th>
                <th>요금</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.name}
                    {b.lat == null && (
                      <span style={{ color: "#999", fontSize: 12 }}> (위치 정보 없음)</span>
                    )}
                  </td>
                  <td>{b.address ?? "—"}</td>
                  <td>{b.raw?.district ?? "—"}</td>
                  <td>{b.slot_count ?? "—"}</td>
                  <td>{b.dimensions_cm ? `${b.dimensions_cm.width}×${b.dimensions_cm.height}` : "—"}</td>
                  <td>{b.fee ? `${b.fee.toLocaleString()}원` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
