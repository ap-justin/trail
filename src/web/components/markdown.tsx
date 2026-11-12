import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const safeScheme = /^(?:https?|mailto):/i;

// Absolute http(s) and mailto only: relative paths would resolve against trail's own
// routes, and every other scheme (javascript:, data:) is dropped to an empty href.
function urlTransform(url: string): string {
  return safeScheme.test(url.trim()) ? url : "";
}

// user text sits under the page's h1 and its h2 sections, so its headings start at h3
const sectionHeading: Components["h1"] = ({ node: _node, ...props }) => (
  <h3 {...props} />
);
const subHeading: Components["h2"] = ({ node: _node, ...props }) => (
  <h4 {...props} />
);

const components: Components = {
  h1: sectionHeading,
  h2: subHeading,
  h3: subHeading,
  h4: subHeading,
  h5: subHeading,
  h6: subHeading,
  a({ node: _node, href, children, ...props }) {
    // a link whose URL was refused stays readable as its text, not a dead anchor
    if (!href) return <span>{children}</span>;
    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium underline underline-offset-3"
      >
        {children}
      </a>
    );
  },
};

/**
 * Bot- and person-written Markdown (GFM). Raw HTML renders as the literal text it is,
 * never as elements, and images are not rendered: the CSP allows same-origin images only.
 */
export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 break-words",
        "[&_h3,&_h4]:mt-1 [&_h3,&_h4]:font-semibold",
        "[&_ol]:list-decimal [&_ol,&_ul]:flex [&_ol,&_ul]:flex-col [&_ol,&_ul]:gap-0.5 [&_ol,&_ul]:pl-4.5 [&_ul]:list-disc",
        "[&_:not(pre)>code]:rounded-sm [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_code]:font-mono [&_code]:text-xs",
        "[&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-muted [&_pre]:p-3",
        "[&_blockquote]:border-l-2 [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground",
        "[&_table]:block [&_table]:overflow-x-auto [&_td,&_th]:border [&_td,&_th]:px-2 [&_td,&_th]:py-1 [&_th]:text-left",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={["img"]}
        urlTransform={urlTransform}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
