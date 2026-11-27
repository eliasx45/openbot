import { describe, expect, it } from "vitest";
import { applicationContentType } from "./application-content-type";

describe("applicationContentType", () => {
  it("serves the pdf.js worker module as JavaScript so the built app can start it", () => {
    expect(applicationContentType("/app/out/renderer/assets/pdf.worker.min-CjEcRF4W.mjs")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(applicationContentType("/app/out/renderer/assets/index.js")).toBe("text/javascript; charset=utf-8");
    expect(applicationContentType("/app/out/renderer/assets/data.bin")).toBe("application/octet-stream");
  });
});
