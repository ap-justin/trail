import type { Db } from "../db/client.js";

/** The handle a `db.transaction` callback writes through. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
