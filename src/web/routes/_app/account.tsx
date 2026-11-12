import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { AppPage, useChrome } from "@/app/chrome";
import { AccountPanel } from "@/components/account-panel";

export const Route = createFileRoute("/_app/account")({
  component: AccountPage,
});

// the shell's desktop layout, where the account row's menu takes this page's place
const DESKTOP = "(min-width: 1024px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(DESKTOP);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const isDesktop = () => window.matchMedia(DESKTOP).matches;

function AccountPage() {
  const { session, signOut } = useChrome();
  const desktop = useSyncExternalStore(subscribe, isDesktop);
  if (desktop) return <Navigate to="/" replace />;
  return (
    <AppPage section="account" heading="Account">
      <AccountPanel viewer={session.viewer} onSignOut={signOut} />
    </AppPage>
  );
}
