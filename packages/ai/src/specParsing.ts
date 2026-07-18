import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const MODEL = "claude-opus-4-8";

/**
 * 크롤링한 지자체 공고문 자유 텍스트 → 구조화된 규격 초안.
 * 결과는 municipality_specs에 바로 반영하지 않고 관리자 검수 큐를 거친다.
 */
const specDraftSchema = z.object({
  sizeCm: z
    .object({ width: z.number(), height: z.number() })
    .nullable()
    .describe("현수막 규격(cm). 명시되지 않았으면 null"),
  fileFormats: z.array(z.string()).describe("허용 파일 형식. 불명확하면 빈 배열"),
  colorRules: z.array(z.string()).describe("색상 관련 규칙 원문 요약"),
  requiredTexts: z.array(z.string()).describe("시안에 반드시 표기해야 하는 문구"),
  prohibited: z.array(z.string()).describe("금지 콘텐츠 규칙"),
  windowRule: z
    .object({
      openDayOfMonth: z.number(),
      closeDayOfMonth: z.number(),
      selectionMethod: z.enum(["lottery", "fcfs"]),
    })
    .nullable()
    .describe("매월 접수 기간 규칙. 명시되지 않았으면 null"),
  confidence: z.enum(["high", "medium", "low"]).describe("추출 신뢰도"),
  notes: z.array(z.string()).describe("검수자가 확인해야 할 애매한 부분"),
});

export type ParsedSpecDraft = z.infer<typeof specDraftSchema>;

export async function parseSpecFromText(
  rawText: string,
  municipalityNameKo: string,
  client: Anthropic = new Anthropic(),
): Promise<ParsedSpecDraft> {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    system:
      "한국 지자체 현수막 게시대 공고문에서 규격·접수 규칙을 추출합니다. 명시되지 않은 값은 추측하지 말고 null/빈 배열로 두고 notes에 기록하세요.",
    messages: [
      {
        role: "user",
        content: `${municipalityNameKo} 공고문:\n\n${rawText.slice(0, 30_000)}`,
      },
    ],
    output_config: { format: zodOutputFormat(specDraftSchema) },
  });
  if (!response.parsed_output) {
    throw new Error("spec parsing returned no structured output");
  }
  return response.parsed_output;
}

/**
 * 결과 발표문(표/자유 텍스트)에서 선정 결과 행 추출.
 * 관리자 확인 큐 경유 후 results 테이블에 반영.
 */
const resultRowsSchema = z.object({
  rows: z.array(
    z.object({
      boardName: z.string().nullable(),
      applicantName: z.string().nullable(),
      receiptNo: z.string().nullable(),
      outcome: z.enum(["selected", "rejected", "unknown"]),
    }),
  ),
  confidence: z.enum(["high", "medium", "low"]),
});

export type ExtractedResults = z.infer<typeof resultRowsSchema>;

export async function extractResultsFromText(
  rawText: string,
  client: Anthropic = new Anthropic(),
): Promise<ExtractedResults> {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8192,
    system:
      "현수막 게시대 추첨/선정 결과 발표문에서 결과 행을 추출합니다. 표기가 애매한 행은 outcome을 unknown으로 두세요. 개인정보는 원문 그대로 두되 추측으로 채우지 마세요.",
    messages: [{ role: "user", content: rawText.slice(0, 50_000) }],
    output_config: { format: zodOutputFormat(resultRowsSchema) },
  });
  if (!response.parsed_output) {
    throw new Error("results extraction returned no structured output");
  }
  return response.parsed_output;
}
