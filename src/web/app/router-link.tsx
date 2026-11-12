import { useLinkProps } from "@tanstack/react-router";
import { useCallback } from "react";
import type { AppLinkProps } from "@/components/app-link";

/**
 * The components' links, navigated by the router. They carry built hrefs (`paths`), which
 * `to` can't type, and mark the current item themselves ("page" or "location"): Link would
 * set aria-current="page" on any active match, so its props are taken and that dropped.
 */
export function RouterLink({
  href,
  ref,
  className,
  "aria-current": current,
  ...props
}: AppLinkProps) {
  // useLinkProps types its ref as Element's; the element is always this anchor
  const forwardRef = useCallback(
    (element: Element | null) => {
      const anchor = element instanceof HTMLAnchorElement ? element : null;
      if (typeof ref === "function") return ref(anchor);
      if (ref) ref.current = anchor;
    },
    [ref],
  );
  const link = useLinkProps(
    // href wins over `to` in router.buildLocation; the types still demand a `to`
    { to: ".", href, ...props },
    forwardRef,
  );
  return (
    <a
      {...link}
      className={className}
      aria-current={current}
      data-status={undefined}
    />
  );
}
