import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// each kept block ends in a space, so "a paragraph" and "- a list item" don't run together
const asText = ({ children }: { children?: ReactNode }) => <>{children} </>;
const blocks = [
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "th",
  "td",
] as const;

/**
 * Markdown read as plain text for a one-or-two-line preview: the words survive, the
 * syntax (`**`, backticks, list markers, link URLs) and every element go. Images drop.
 */
export function MarkdownText({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      allowedElements={blocks}
      unwrapDisallowed
      components={Object.fromEntries(blocks.map((tag) => [tag, asText]))}
    >
      {source}
    </ReactMarkdown>
  );
}
