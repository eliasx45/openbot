// @vitest-environment node

import { plainPreview } from "@openbot/team-client/agent-notifications";
import { describe, expect, it } from "vitest";

const LEAD = "I checked the logs for the last three deploys across all regions and services.";

describe("the notification text of a reply", () => {
  it("does not end inside bold text that holds a full stop", () => {
    const body = plainPreview(
      `${LEAD} **Root cause. The cache layer drops writes when the TTL is zero and the key is long.** Fix is in.`,
    );
    expect(body).not.toContain("**");
    expect(body?.startsWith(LEAD)).toBe(true);
  });

  it("does not end inside a link label that holds a full stop", () => {
    const body = plainPreview(
      "Short intro about the work that was done today on the parser and the tests. See [the design doc. It explains everything](https://example.com/docs/design) for more context.",
    );
    expect(body).not.toMatch(/[[\]]/u);
  });

  it("does not end inside inline math that holds a full stop", () => {
    const body = plainPreview(
      "The formula for the result over the given domain is as follows in this case here. $x = 1. y = 2$ and that is all there is to it for now, really.",
    );
    expect(body).not.toContain("$");
  });

  it("keeps a sentence split outside Markdown", () => {
    expect(plainPreview("**Done.** All tests pass. The build is green.")).toBe(
      "Done. All tests pass. The build is green.",
    );
  });
});
