import { useEffect, useState } from "react";

/** The clock relative times are read against: `fixed` when given, else now, ticking each minute. */
export function useMinuteClock(fixed: Date | undefined): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (fixed) return;
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [fixed]);
  return fixed ?? now;
}
