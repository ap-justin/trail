import type { HumanActor, VisibleProject } from "./identity.js";

export type { HumanActor, VisibleProject };

/**
 * Who a request comes from, by its session cookie. Resolved on every request,
 * so a removed invite or project takes effect on the next one.
 */
export type Viewer =
  /** no valid session */
  | { kind: "anonymous" }
  /** signed in with GitHub but neither the owner nor invited: no actor, no data */
  | { kind: "not_invited"; login: string }
  | {
      kind: "member" | "owner";
      /** lowercased GitHub login */
      login: string;
      actor: HumanActor;
      /** the owner sees every project; a member, those its invite lists */
      projects: VisibleProject[];
    };

export type ViewerEnv = { Variables: { viewer: Viewer } };
