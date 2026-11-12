import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { ErrorState } from "@/components/states";
import { ApiError } from "@/lib/api";

const couldNotReach = {
  title: "Couldn't reach trail",
  description: "Check your connection, then try again.",
};
const failed = {
  title: "Couldn't load this page",
  description: "Something went wrong on our side. Try again.",
};

/**
 * Any route that throws: a gate's `/me` read with trail down (every deploy), or a render
 * error. Drawn without the shell, which needs the `/me` that may be what failed.
 */
export function ErrorPage({ error }: ErrorComponentProps) {
  const router = useRouter();
  const copy =
    error instanceof ApiError && error.status === 0 ? couldNotReach : failed;
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      {/* invalidate re-runs every beforeLoad and resets this boundary */}
      <ErrorState {...copy} onRetry={() => void router.invalidate()} />
    </main>
  );
}
