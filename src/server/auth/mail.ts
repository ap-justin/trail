/** One email as trail sends it: one recipient, an HTML and a plain-text body. */
export type MailMessage = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
};

/** Sends one email; rejects when the provider refused it. */
export type MailTransport = (message: MailMessage) => Promise<void>;

/** Sends through Resend's HTTP API with `apiKey`; `send` is the fetch it uses. */
export function resendTransport(
  apiKey: string,
  send: typeof fetch = fetch,
): MailTransport {
  return async (message) => {
    const res = await send("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...message, to: [message.to] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Resend answered ${res.status}: ${await res.text()}`);
    }
  };
}

const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const font = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

/** The sign-in email for `url`, as designed: no images, no tracking. */
export function signInEmail(
  url: string,
): Pick<MailMessage, "subject" | "html" | "text"> {
  const href = escapeHtml(url);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your trail sign-in link</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:480px;margin:0 auto;padding:40px 24px">
<div style="font:600 18px/1.2 ${font};color:#0a0a0a;padding-bottom:24px">trail<span style="color:#2d54bc">.</span></div>
<div style="font:400 16px/1.5 ${font};color:#0a0a0a;padding-bottom:20px">Use this link to sign in to trail.</div>
<div style="padding-bottom:24px"><a href="${href}" style="display:inline-block;background:#171717;color:#fafafa;font:500 15px/1 ${font};padding:13px 20px;border-radius:6px;text-decoration:none">Sign in to trail</a></div>
<div style="font:400 13px/1.5 ${font};color:#636363;padding-bottom:4px">This link works once and expires in 15 minutes.</div>
<div style="font:400 13px/1.5 ${font};color:#636363;padding-bottom:24px">Didn't ask for it? Ignore this email and nothing happens.</div>
<div style="border-top:1px solid #e5e5e5;padding-top:16px;font:400 12px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#636363;word-break:break-all"><span style="font-family:${font}">Button not working? Paste this link into your browser:</span><br><a href="${href}" style="color:#636363;text-decoration:none">${href}</a></div>
</div>
</body></html>
`;
  const text = `Use this link to sign in to trail:

${url}

It works once and expires in 15 minutes.

Didn't ask for it? Ignore this email and nothing happens.
`;
  return { subject: "Your trail sign-in link", html, text };
}
