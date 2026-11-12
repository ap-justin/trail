import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Navigate,
  Outlet,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { AppChrome, sessionOf } from "@/app/chrome";
import { isMember, meQuery } from "@/lib/queries";

/** Every page behind sign-in. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!isMember(me)) {
      throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const { data: me } = useSuspenseQuery(meQuery);
  const session = sessionOf(me);
  // the page on screen: the pending location turns into /sign-in itself once Navigate runs
  const here = useRouterState({ select: (s) => s.resolvedLocation?.href });
  // beforeLoad guards the way in; this follows a /me refetch that ends the session mid-visit
  if (!session) return <Navigate to="/sign-in" search={{ redirect: here }} />;
  return (
    <AppChrome session={session}>
      <Outlet />
    </AppChrome>
  );
}
