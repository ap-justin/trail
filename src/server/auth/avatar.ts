import type { Db } from "../db/client.js";
import { PHOTO_MAX_BYTES, setActorPhoto } from "../service/photos.js";
import type { HumanActor } from "./identity.js";

// sign-in doesn't wait on the fetch; this bounds how long the background fetch can run
const AVATAR_TIMEOUT_MS = 3_000;

/**
 * Stores the person's current GitHub photo as their actor's photo. Never
 * throws: on any failure the photo they had, or none, stays, and a warning is
 * logged, so sign-in goes on without it.
 */
export async function storeGitHubPhoto(
  db: Db,
  person: HumanActor,
  avatarFetch: typeof fetch,
): Promise<void> {
  try {
    setActorPhoto(
      db,
      person.id,
      await fetchAvatar(person.githubId, avatarFetch),
    );
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
  // a fixed host and a numeric id: nothing from the profile shapes the URL
  const res = await avatarFetch(
    `https://avatars.githubusercontent.com/u/${githubId}?s=128`,
    { signal: AbortSignal.timeout(AVATAR_TIMEOUT_MS) },
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
