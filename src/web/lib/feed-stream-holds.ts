import { useSyncExternalStore } from "react";

// the feed pages mounted now; each holds its own /events stream
let holds = 0;
const listeners = new Set<() => void>();

/** Marks a feed stream as held until the returned release runs. */
export function holdFeedStream(): () => void {
  holds += 1;
  for (const listener of listeners) listener();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    for (const listener of listeners) listener();
  };
}

/** Read at the moment of asking, for an effect that runs before its render saw the change. */
export const feedStreamHeld = () => holds > 0;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Whether a feed page holds a stream of its own, as of this render. */
export function useFeedStreamHeld(): boolean {
  return useSyncExternalStore(subscribe, feedStreamHeld);
}
