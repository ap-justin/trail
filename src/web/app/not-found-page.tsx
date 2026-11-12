import { AppPage } from "@/app/chrome";
import { NotFoundPanel } from "@/components/states";

/**
 * An unknown URL, and a project, issue or page the viewer can't see: one page for all, under
 * no nav item and with no heading, so a hidden key reads exactly like a missing one.
 */
export function NotFoundPage() {
  return (
    <AppPage section={null} heading={null}>
      <NotFoundPanel />
    </AppPage>
  );
}
