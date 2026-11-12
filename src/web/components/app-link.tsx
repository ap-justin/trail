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
        "outline-none after:absolute after:inset-0 focus-visible:after:ring-3 focus-visible:after:ring-ring/25 focus-visible:after:ring-inset",
        className,
      )}
    >
      {children}
    </AppLink>
  );
}
