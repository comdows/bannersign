import type { DesignFinding, DesignSpec } from "./types.js";

/**
 * 시안 사이즈/비율 검사 — AI에 위임하지 않고 코드로 결정적 판정.
 * 픽셀 이미지의 가로:세로 비가 규격 cm 비율의 허용 오차 내인지 확인한다.
 */
export function checkAspectRatio(
  imagePx: { width: number; height: number },
  spec: DesignSpec,
): DesignFinding {
  const expected = spec.sizeCm.width / spec.sizeCm.height;
  const actual = imagePx.width / imagePx.height;
  const deviation = Math.abs(actual - expected) / expected;

  if (deviation <= spec.ratioTolerance) {
    return {
      ruleId: "aspect_ratio",
      result: "pass",
      reasonKo: `비율 ${imagePx.width}:${imagePx.height} — 규격 ${spec.sizeCm.width}×${spec.sizeCm.height}cm 대비 오차 ${(deviation * 100).toFixed(1)}% (허용 ${(spec.ratioTolerance * 100).toFixed(0)}%)`,
    };
  }
  return {
    ruleId: "aspect_ratio",
    result: "fail",
    reasonKo: `이미지 비율(${actual.toFixed(3)})이 규격 ${spec.sizeCm.width}×${spec.sizeCm.height}cm 비율(${expected.toFixed(3)})과 ${(deviation * 100).toFixed(1)}% 차이 — 허용 오차 ${(spec.ratioTolerance * 100).toFixed(0)}% 초과. 인쇄 시 왜곡되거나 반려될 수 있습니다.`,
  };
}

export function checkFileFormat(fileName: string, spec: DesignSpec): DesignFinding {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const ok = spec.fileFormats.map((f) => f.toLowerCase()).includes(ext);
  return {
    ruleId: "file_format",
    result: ok ? "pass" : "fail",
    reasonKo: ok
      ? `파일 형식 ${ext} 허용`
      : `파일 형식 ${ext}은(는) 허용되지 않습니다. 허용: ${spec.fileFormats.join(", ")}`,
  };
}
