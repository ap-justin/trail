/** A JSON error as the rest of trail's API answers one. */
export const errorJson = (
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
) => Response.json({ error: { code, message } }, { status, headers });
