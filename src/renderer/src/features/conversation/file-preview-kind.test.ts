import { attachmentMimeTypeForName } from "@openbot/contracts/attachment-files";
import { filePreviewKindForFile } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";

function previewKind(name: string) {
  return filePreviewKindForFile(name, attachmentMimeTypeForName(name));
}

describe("the file panel preview of a table as text", () => {
  it("shows a comma-separated file as text", () => {
    expect(previewKind("report.csv")).toBe("text");
  });

  it("shows a tab-separated file as text", () => {
    expect(previewKind("report.tsv")).toBe("text");
    expect(previewKind("REPORT.TSV")).toBe("text");
  });
});
