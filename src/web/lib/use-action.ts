import { type MutationFunction, useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";

type Outcome<TVars> = {
  pending: boolean;
  error: Error | null;
  vars: TVars | null;
};

/**
 * A write as a form sees it: pending from the click itself, and its outcome landing in one
 * render. The components clear or close when they see pending fall with no error; Query's
 * own state reaches React through a batch a fast answer can beat, so it would skip the
 * pending render, or show pending fall a render before the error.
 */
export function useAction<TVars, TData>(
  mutationFn: MutationFunction<TData, TVars>,
  onSuccess?: (data: TData, vars: TVars) => unknown,
) {
  const [outcome, setOutcome] = useState<Outcome<TVars>>({
    pending: false,
    error: null,
    vars: null,
  });
  // a second click can land before the first one's pending render
  const inFlight = useRef(false);
  const mutation = useMutation({
    mutationFn,
    onSuccess: async (data, vars) => {
      await onSuccess?.(data, vars);
      setOutcome({ pending: false, error: null, vars });
    },
    onError: (error, vars) => setOutcome({ pending: false, error, vars }),
    onSettled: () => {
      inFlight.current = false;
    },
  });
  return {
    ...outcome,
    run: (vars: TVars) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setOutcome({ pending: true, error: null, vars });
      mutation.mutate(vars);
    },
    reset: () => setOutcome({ pending: false, error: null, vars: null }),
  };
}

type KeyedOutcome<TVars> = {
  pending: boolean;
  error: Error | null;
  vars: TVars;
};

/**
 * `useAction` once per key: each key's write has its own pending, error and in-flight guard,
 * so one row's write neither blocks nor resets another's. `outcomes` has one entry per key
 * with a write in flight or just failed; a success drops its entry, in the same render as onSuccess's
 * refresh landing.
 */
export function useKeyedAction<TKey, TVars, TData>(
  mutationFn: MutationFunction<TData, TVars>,
  keyOf: (vars: TVars) => TKey,
  onSuccess?: (data: TData, vars: TVars) => unknown,
) {
  const [outcomes, setOutcomes] = useState<
    ReadonlyMap<TKey, KeyedOutcome<TVars>>
  >(new Map());
  const inFlight = useRef(new Set<TKey>());
  const settle = (key: TKey, outcome: KeyedOutcome<TVars> | null) =>
    setOutcomes((current) => {
      const next = new Map(current);
      if (outcome) next.set(key, outcome);
      else next.delete(key);
      return next;
    });
  const mutation = useMutation({
    mutationFn,
    onSuccess: async (data, vars) => {
      await onSuccess?.(data, vars);
      settle(keyOf(vars), null);
    },
    onError: (error, vars) =>
      settle(keyOf(vars), { pending: false, error, vars }),
    onSettled: (_data, _error, vars) => {
      inFlight.current.delete(keyOf(vars));
    },
  });
  return {
    outcomes: [...outcomes.values()],
    run: (vars: TVars) => {
      const key = keyOf(vars);
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      settle(key, { pending: true, error: null, vars });
      mutation.mutate(vars);
    },
  };
}
