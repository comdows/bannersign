import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  checkAspectRatio,
  checkFileFormat,
  designValidationResultSchema,
  type DesignFinding,
  type DesignSpec,
  type DesignValidationResult,
} from "@youni/core";

const MODEL = "claude-opus-4-8";

export interface DesignImageInput {
  /** base64 인코딩된 이미지 (2000px 이하로 리사이즈 후 전달 권장 — 비용 제어) */
  base64: string;
  mediaType: "image/jpeg" | "image/png";
  fileName: string;
  widthPx: number;
  heightPx: number;
}

/**
 * 시안 적합성 검증.
 * - 비율/파일형식은 코드로 결정적 판정 (@youni/core)
 * - 필수 문구, 금지 콘텐츠, 색상 제한, 가독성은 Claude vision + structured output
 * 최종 verdict는 모든 finding 중 최악값 (fail > warn > pass).
 */
export async function validateDesign(
  image: DesignImageInput,
  spec: DesignSpec,
  municipalityNameKo: string,
  client: Anthropic = new Anthropic(),
): Promise<DesignValidationResult & { model: string }> {
  const deterministic: DesignFinding[] = [
    checkAspectRatio({ width: image.widthPx, height: image.heightPx }, spec),
    checkFileFormat(image.fileName, spec),
  ];

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system: [
      "당신은 한국 지자체 현수막 게시대 시안 심사 보조원입니다.",
      "주어진 규정에 대해 시안 이미지를 검사하고 규칙별로 pass/warn/fail을 판정합니다.",
      "확실히 위반이면 fail, 애매하거나 판독이 어려우면 warn을 사용하세요.",
      "reasonKo는 광고주가 바로 수정할 수 있도록 한국어로 구체적으로 작성하세요.",
      "이미지 크기/비율은 별도 시스템이 검사하므로 판정하지 마세요.",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: image.mediaType, data: image.base64 },
          },
          {
            type: "text",
            text: buildRulesPrompt(spec, municipalityNameKo),
          },
        ],
      },
    ],
    output_config: {
      format: zodOutputFormat(designValidationResultSchema),
    },
  });

  const aiResult = response.parsed_output;
  const findings = [...deterministic, ...(aiResult?.findings ?? [])];
  return {
    verdict: worstVerdict(findings),
    findings,
    model: MODEL,
  };
}

function buildRulesPrompt(spec: DesignSpec, municipalityNameKo: string): string {
  const lines: string[] = [
    `${municipalityNameKo} 현수막 게시대 규정에 대해 이 시안을 검사하세요.`,
    "",
    "검사할 규칙 (각 규칙마다 finding 1개, ruleId는 아래 표기 사용):",
  ];
  spec.requiredTexts?.forEach((t, i) =>
    lines.push(`- required_text_${i + 1}: 필수 표기 "${t}"가 시안에 존재하는가`),
  );
  spec.prohibited?.forEach((p, i) =>
    lines.push(`- prohibited_${i + 1}: 금지 사항 "${p}"에 해당하는 내용이 없는가`),
  );
  spec.colorRules?.forEach((c, i) =>
    lines.push(`- color_${i + 1}: 색상 규칙 "${c}"를 준수하는가`),
  );
  lines.push("- readability: 실제 현수막 크기로 인쇄했을 때 문구 가독성이 충분한가 (경고 수준 판정)");
  return lines.join("\n");
}

function worstVerdict(findings: DesignFinding[]): "pass" | "warn" | "fail" {
  if (findings.some((f) => f.result === "fail")) return "fail";
  if (findings.some((f) => f.result === "warn")) return "warn";
  return "pass";
}
