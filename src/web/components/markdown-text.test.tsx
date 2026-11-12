import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { MarkdownText } from "@/components/markdown-text";

test("Markdown reads as its words, without the syntax", () => {
  const { container } = render(
    <p>
      <MarkdownText
        source={
          "The client **never sends** `Last-Event-ID`, see [the PR](https://github.com/x/y/pull/31).\n\n- fix in PR #31\n- needs a _test_"
        }
      />
    </p>,
  );
  expect(container.textContent?.replace(/\s+/g, " ").trim()).toBe(
    "The client never sends Last-Event-ID, see the PR. fix in PR #31 needs a test",
  );
  expect(container.querySelector("strong, code, a, ul, li")).toBeNull();
});
