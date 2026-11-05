import { MarkdownMessageText } from "@openbot/ui/features/conversation/MarkdownMessageText";
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";

// A favicon with transparent parts let the link symbol under it show through.
it("hides the link symbol once the favicon loads, and shows it again when the favicon fails", async () => {
  const { container } = render(() => (
    <MarkdownMessageText
      body="[Drive](https://drive.google.com/drive/folders/x)"
      agents={[]}
      onSelectAgent={vi.fn()}
      onOpenLink={vi.fn()}
    />
  ));
  const icon = container.querySelector(".message-link-icon");
  const image = icon?.querySelector("img");
  expect(icon?.hasAttribute("data-favicon")).toBe(false);
  if (!image) throw new Error("no favicon");
  fireEvent.load(image);
  await waitFor(() => expect(icon?.hasAttribute("data-favicon")).toBe(true));
  fireEvent.error(image);
  await waitFor(() => expect(icon?.hasAttribute("data-favicon")).toBe(false));
  expect(icon?.querySelector("img")).toBeNull();
});
