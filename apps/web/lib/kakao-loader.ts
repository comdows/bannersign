"use client";

declare global {
  interface Window {
    kakao?: any;
  }
}

let loading: Promise<any> | null = null;

/**
 * Kakao Maps JS SDK 지연 로더 (autoload=false).
 * 키 미설정/로드 실패 시 reject — 호출부는 리스트 전용 폴백으로 동작해야 한다.
 */
export function loadKakaoMaps(appKey: string | undefined): Promise<any> {
  if (!appKey) return Promise.reject(new Error("kakao app key not configured"));
  if (typeof window === "undefined") return Promise.reject(new Error("client only"));
  if (window.kakao?.maps?.Map) return Promise.resolve(window.kakao.maps);

  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`;
    script.async = true;
    script.onload = () => {
      if (!window.kakao?.maps) return reject(new Error("kakao maps namespace missing"));
      window.kakao.maps.load(() => resolve(window.kakao.maps));
    };
    script.onerror = () => {
      loading = null; // 재시도 허용
      reject(new Error("kakao maps sdk load failed"));
    };
    document.head.appendChild(script);
  });
  return loading;
}
