"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadKakaoMaps } from "@/lib/kakao-loader";

export interface MapBoard {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address?: string | null;
  fee?: number | null;
}

interface Props {
  boards: MapBoard[];
  selectedIds: string[];
  /** 미지정이면 읽기 전용(탐색 모드) */
  onToggle?: (id: string) => void;
  appKey: string | undefined;
  height?: number;
}

/** 근접 게시대 그룹 키 — 소수 4자리(≈11m)로 반올림해 같은 교차로의 다중 게시대를 묶는다 */
function groupKey(b: MapBoard): string {
  return `${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
}

/**
 * 게시대 위치 지도 (Kakao Maps).
 * - 마커 클릭: 단일 게시대면 바로 선택/해제, 같은 지점에 여러 개면 하단 패널에서 개별 선택
 * - 선택된 게시대는 마커 위에 우선순위 뱃지 표시
 * - SDK 로드 실패/키 미설정이면 안내만 — 상위 폼은 리스트로 계속 동작해야 한다
 */
export function BoardMap({ boards, selectedIds, onToggle, appKey, height = 380 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const [activeGroup, setActiveGroup] = useState<string | null>(null);

  const groups = useMemo(() => {
    const m = new Map<string, MapBoard[]>();
    for (const b of boards) m.set(groupKey(b), [...(m.get(groupKey(b)) ?? []), b]);
    return m;
  }, [boards]);

  // 지도 생성 + 마커 (boards 변경 시 재구성)
  useEffect(() => {
    let cancelled = false;
    if (boards.length === 0) return;
    loadKakaoMaps(appKey)
      .then((maps) => {
        if (cancelled || !containerRef.current) return;
        const map = new maps.Map(containerRef.current, {
          center: new maps.LatLng(boards[0]!.lat, boards[0]!.lng),
          level: 7,
        });
        mapRef.current = { map, maps };

        const bounds = new maps.LatLngBounds();
        for (const [key, group] of groups) {
          const first = group[0]!;
          const pos = new maps.LatLng(first.lat, first.lng);
          bounds.extend(pos);
          const marker = new maps.Marker({ map, position: pos, title: group.map((g) => g.name).join(", ") });
          maps.event.addListener(marker, "click", () => {
            if (group.length === 1 && onToggle) onToggle(first.id);
            else setActiveGroup((cur) => (cur === key ? null : key));
          });
          if (group.length > 1) {
            // 같은 지점 다중 게시대 — 개수 뱃지
            new maps.CustomOverlay({
              map,
              position: pos,
              yAnchor: 2.4,
              content: `<div style="background:#333;color:#fff;border-radius:10px;padding:0 6px;font-size:11px;line-height:16px">${group.length}</div>`,
            });
          }
        }
        map.setBounds(bounds, 24);
        setStatus("ready");
      })
      .catch(() => !cancelled && setStatus("unavailable"));
    return () => {
      cancelled = true;
      mapRef.current = null;
    };
  }, [appKey, boards, groups, onToggle]);

  // 선택 변경 → 우선순위 뱃지 오버레이 갱신
  useEffect(() => {
    const ref = mapRef.current;
    if (!ref || status !== "ready") return;
    overlaysRef.current.forEach((o) => o.setMap(null));
    overlaysRef.current = [];
    const byId = new Map(boards.map((b) => [b.id, b]));
    selectedIds.forEach((id, i) => {
      const b = byId.get(id);
      if (!b) return; // 좌표 없는 게시대는 뱃지 생략
      const overlay = new ref.maps.CustomOverlay({
        map: ref.map,
        position: new ref.maps.LatLng(b.lat, b.lng),
        yAnchor: 3.1,
        zIndex: 10,
        content: `<div style="background:#2c6ecb;color:#fff;border-radius:50%;width:20px;height:20px;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.4)">${i + 1}</div>`,
      });
      overlaysRef.current.push(overlay);
    });
  }, [selectedIds, boards, status]);

  if (boards.length === 0) return null;
  if (status === "unavailable") {
    return (
      <p style={{ fontSize: 13, color: "#777", background: "#f6f6f6", padding: 10, borderRadius: 6 }}>
        지도를 불러올 수 없어 목록으로 선택합니다. (관리자: NEXT_PUBLIC_KAKAO_MAP_APP_KEY 설정 +
        카카오 개발자 콘솔 도메인 등록 필요)
      </p>
    );
  }

  const active = activeGroup ? (groups.get(activeGroup) ?? []) : [];

  return (
    <div>
      <div ref={containerRef} style={{ width: "100%", height, borderRadius: 6, background: "#eee" }} />
      {status === "loading" && <p style={{ fontSize: 13, color: "#777" }}>지도 불러오는 중…</p>}
      {active.length > 0 && (
        <div style={{ border: "1px solid #ddd", borderRadius: 6, padding: 10, marginTop: 8 }}>
          <strong style={{ fontSize: 13 }}>이 지점의 게시대 {active.length}곳</strong>
          {active.map((b) => {
            const rank = selectedIds.indexOf(b.id);
            return (
              <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, marginTop: 6 }}>
                <span style={{ flex: 1 }}>
                  {b.name} <span style={{ color: "#888", fontSize: 12 }}>{b.address ?? ""}</span>
                </span>
                {onToggle && (
                  <button type="button" onClick={() => onToggle(b.id)}>
                    {rank >= 0 ? `해제 (${rank + 1}순위)` : "선택"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
