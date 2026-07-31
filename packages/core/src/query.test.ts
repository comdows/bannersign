import { describe, expect, it } from "vitest";
import { unwrapQuery } from "./query.js";

describe("unwrapQuery — fail-closed", () => {
  it("error 가 없으면 data 를 그대로 반환한다", () => {
    expect(unwrapQuery({ data: { status: "active" }, error: null }, "municipalities")).toEqual({
      status: "active",
    });
  });

  it("data 가 null 이어도 error 가 없으면 null 을 반환한다(행 없음 = 정상)", () => {
    expect(unwrapQuery({ data: null, error: null }, "site_credentials")).toBeNull();
  });

  it("error 가 있으면 throw 한다(조회 오류를 미충족으로 삼키지 않음)", () => {
    expect(() =>
      unwrapQuery({ data: null, error: { code: "57014", message: "timeout" } }, "municipalities(x)"),
    ).toThrow();
  });

  it("throw 메시지에 context 와 오류 세부(code/message)가 남는다", () => {
    let msg = "";
    try {
      unwrapQuery(
        { data: null, error: { code: "42501", message: "permission denied", details: "RLS" } },
        "board_sites(req-1)",
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("board_sites(req-1)");
    expect(msg).toContain("42501");
    expect(msg).toContain("permission denied");
  });

  it("error 객체가 비어도(필드 없음) 여전히 throw 한다", () => {
    expect(() => unwrapQuery({ data: null, error: {} }, "designs")).toThrow(/unknown postgrest error/);
  });
});
