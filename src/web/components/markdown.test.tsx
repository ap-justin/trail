import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Markdown } from "@/components/markdown";

function renderMarkdown(source: string) {
  return render(<Markdown>{source}</Markdown>).container;
}

describe("Markdown", () => {
  test("renders GFM: headings, lists, inline code and tables", () => {
    const container = renderMarkdown(
      "### Scope\n\n- one `project_member`\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |",
    );
    expect(screen.getByRole("heading", { name: "Scope" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(container.querySelector("code")).toHaveTextContent("project_member");
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  test("headings sit below the page's own: # is h3, every deeper level h4", () => {
    renderMarkdown("# Summary\n\n## Scope\n\n###### Notes");
    expect(screen.getByRole("heading", { name: "Summary" })).toHaveProperty(
      "tagName",
      "H3",
    );
    expect(screen.getByRole("heading", { name: "Scope" })).toHaveProperty(
      "tagName",
      "H4",
    );
    expect(screen.getByRole("heading", { name: "Notes" })).toHaveProperty(
      "tagName",
      "H4",
    );
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  test("raw HTML never becomes elements, script included", () => {
    const container = renderMarkdown(
      'Hello <b>bold</b>\n\n<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">',
    );
    expect(container.querySelector("script, b, img, [onerror]")).toBeNull();
    // the markup shows as the literal text it is; it is not dropped
    expect(container).toHaveTextContent("<b>bold</b>");
    expect(container).toHaveTextContent("<script>alert(1)</script>");
  });

  test("links keep http, https and mailto, and open with noopener noreferrer", () => {
    renderMarkdown(
      "[web](https://example.com) [plain](http://example.com) [mail](mailto:a@example.com)",
    );
    for (const name of ["web", "plain", "mail"]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(link).toHaveAttribute("target", "_blank");
    }
    expect(screen.getByRole("link", { name: "mail" })).toHaveAttribute(
      "href",
      "mailto:a@example.com",
    );
  });

  test("any other scheme, or a relative path, is text rather than a link", () => {
    renderMarkdown(
      "[js](javascript:alert(1)) [data](data:text/html,hi) [rel](/people) [vb](vbscript:x)",
    );
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(screen.getByText("js")).toBeInTheDocument();
  });

  test("images are not rendered", () => {
    const container = renderMarkdown(
      "Before ![logo](https://example.com/logo.png) after",
    );
    expect(container.querySelector("img")).toBeNull();
    // the text around it survives, so the missing img is not a vanished paragraph
    expect(container).toHaveTextContent("Before after");
  });
});
