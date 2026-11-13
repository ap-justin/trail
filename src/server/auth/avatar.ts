import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { actorPhoto } from "../db/schema.js";
import type { EventBus } from "../events/bus.js";
import {
  PHOTO_MAX_BYTES,
  setActorPhoto,
  touchActorPhoto,
} from "../service/photos.js";
import type { GitHubHuman } from "./identity.js";

// sign-in doesn't wait on the fetch; this bounds how long the background fetch can run
const AVATAR_TIMEOUT_MS = 3_000;

// a photo checked this long ago is fetched again when its person loads the app
const REFRESH_AFTER_MS = 24 * 60 * 60_000;
// at most one check per person in this long, whatever the last one found; well over AVATAR_TIMEOUT_MS, so a fetch in flight is never doubled
const CHECK_EVERY_MS = 60 * 60_000;

/**
 * Keeps people's GitHub photos current without a new sign-in. Fetches run in
 * the background and never reject, so no caller waits on GitHub.
 */
export function githubPhotos({
  db,
  avatarFetch,
  bus,
  now,
}: {
  db: Db;
  avatarFetch: typeof fetch;
  bus?: EventBus;
  now: () => number;
}) {
  // per human actor, when its photo was last fetched or found fresh
  const lastChecked = new Map<string, number>();

  function fetchNow(person: GitHubHuman, at: number) {
    lastChecked.set(person.id, at);
    void storeGitHubPhoto(db, person, avatarFetch, bus);
  }

  return {
    /** A sign-in always fetches. */
    signedIn(person: GitHubHuman) {
      fetchNow(person, now());
    },
    /** A page load fetches when the photo is missing or over a day old, at most hourly. */
    seen(person: GitHubHuman) {
      const at = now();
      const last = lastChecked.get(person.id);
      if (last !== undefined && at - last < CHECK_EVERY_MS) return;
      const checkedAt = db
        .select({ updatedAt: actorPhoto.updatedAt })
        .from(actorPhoto)
        .where(eq(actorPhoto.actorId, person.id))
        .get()?.updatedAt;
      if (checkedAt && at - checkedAt.getTime() < REFRESH_AFTER_MS) {
        lastChecked.set(person.id, at);
        return;
      }
      fetchNow(person, at);
    },
  };
}

/**
 * Stores the person's current GitHub photo as their actor's photo, and
 * publishes it on `bus` when it changed; the same bytes again only mark the
 * photo checked. Never throws: on any failure the photo they had, or none,
 * stays, and a warning is logged, so sign-in goes on without it.
 */
async function storeGitHubPhoto(
  db: Db,
  person: GitHubHuman,
  avatarFetch: typeof fetch,
  bus?: EventBus,
): Promise<void> {
  try {
    const bytes = await fetchAvatar(person.githubId, avatarFetch);
    const { photoUrl, changed } = setActorPhoto(db, person.id, bytes);
    if (changed) bus?.publishActor({ actorId: person.id, photoUrl });
    else touchActorPhoto(db, person.id);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(
      `GitHub photo for ${person.githubLogin} not stored: ${reason}`.replace(
        /\s+/g,
        " ",
      ),
    );
  }
}

async function fetchAvatar(
  githubId: number,
  avatarFetch: typeof fetch,
): Promise<Uint8Array> {
  // a fixed host and a numeric id: nothing from the profile shapes the URL, and any redirect is refused
  const res = await avatarFetch(
    `https://avatars.githubusercontent.com/u/${githubId}?s=128`,
    { redirect: "error", signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS) },
  );
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error(`GitHub answered ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared > PHOTO_MAX_BYTES) {
    await res.body?.cancel();
    throw new Error(`GitHub's photo is ${declared} bytes`);
  }
  return readAtMost(res, PHOTO_MAX_BYTES);
}

/** The body's bytes, refused as soon as more than `max` arrive, whatever content-length said. */
async function readAtMost(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > max) throw new Error(`GitHub's photo is over ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
