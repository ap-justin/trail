import {
  type ComponentType,
  createContext,
  type ReactNode,
  type Ref,
  useContext,
} from "react";
import { cn } from "@/lib/utils";

export type AppLinkProps = {
  href: string;
  className?: string;
  children?: ReactNode;
  "aria-current"?: "page" | "location" | undefined;
  "aria-label"?: string;
  "aria-describedby"?: string;
  ref?: Ref<HTMLAnchorElement>;
};

function PlainLink({ href, ...props }: AppLinkProps) {
  return <a href={href} {...props} />;
}

const LinkContext = createContext<ComponentType<AppLinkProps>>(PlainLink);

/**
 * Every in-app link in these components renders through `component`, so the router
 * can do client-side navigation without the components importing it. Without a
 * provider, links are plain anchors.
 */
export function LinkProvider({
  component,
  children,
}: {
  component: ComponentType<AppLinkProps>;
  children: ReactNode;
}) {
  return <LinkContext value={component}>{children}</LinkContext>;
}

export function AppLink(props: AppLinkProps) {
  const Link = useContext(LinkContext);
  return <Link {...props} />;
}

/** A text link's keyboard focus: the 2px `--ring` outline every control draws. */
export const textLinkFocus =
  "rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** A standalone text link's 44px tap area below lg; from lg its box is the text's own. */
export const textLinkTap =
  "max-lg:inline-flex max-lg:min-h-11 max-lg:items-center";

/**
 * The link a row opens; its ::after covers the nearest positioned ancestor (the row), so
 * the whole row is the target while the link's name stays its own text.
 */
export function RowLink({
  href,
  label,
  children,
  className,
}: {
  href: string;
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <AppLink
      href={href}
      aria-label={label}
      className={cn(
        "outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring",
        className,
      )}
    >
      {children}
    </AppLink>
  );
}
