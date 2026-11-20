/** One email as trail sends it: one recipient, an HTML and a plain-text body. */
export type MailMessage = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** extra email headers, like List-Unsubscribe */
  headers?: Record<string, string>;
  /** the same key on a retry makes the provider send it at most once */
  idempotencyKey?: string;
};

/**
 * Sends one email; rejects with `MailRefused` when the provider answered with
 * a refusal, with any other error when it couldn't be reached. `signal` cuts
 * the request.
 */
export type MailTransport = (
  message: MailMessage,
  signal?: AbortSignal,
) => Promise<void>;

/** The provider answered `status` and didn't take the email. */
export class MailRefused extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Resend answered ${status}: ${body}`);
  }
}

/** Sends through Resend's HTTP API with `apiKey`; `send` is the fetch it uses. */
export function resendTransport(
  apiKey: string,
  send: typeof fetch = fetch,
): MailTransport {
  return async ({ idempotencyKey, ...message }, signal) => {
    const timeout = AbortSignal.timeout(10_000);
    const res = await send("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(idempotencyKey !== undefined && {
          "idempotency-key": idempotencyKey,
        }),
      },
      body: JSON.stringify({ ...message, to: [message.to] }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (!res.ok) throw new MailRefused(res.status, await res.text());
  };
}

export const escapeHtml = (s: string) =>
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
<div style="font:600 18px/1.2 ${font};color:#0a0a0a;padding-bottom:24px">trail<span style="color:#006375">.</span></div>
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

/** The longest bot comment an issue-ended email quotes, in characters; a longer one is cut with an ellipsis. */
const QUOTED_COMMENT_MAX = 1000;

const quoted = (body: string) => {
  const chars = [...body.trim()];
  return chars.length <= QUOTED_COMMENT_MAX
    ? chars.join("")
    : `${chars.slice(0, QUOTED_COMMENT_MAX).join("").trimEnd()}…`;
};

/** What the issue-ended email reports: the issue, how it ended and why, and its two links. */
export type IssueEnded = {
  key: string;
  title: string;
  status: "done" | "canceled";
  /** the product's bot's last comment on the issue when it ended */
  comment: { author: string; body: string } | null;
  url: string;
  unsubscribeUrl: string;
};

/**
 * The email telling a person an issue filed for them ended, in the sign-in
 * email's look: no images, no tracking. The bot's comment is markdown, shown
 * as escaped plain text, never rendered.
 */
export function issueEndedEmail(
  ended: IssueEnded,
): Pick<MailMessage, "subject" | "html" | "text"> {
  const outcome = ended.status === "done" ? "is done" : "was canceled";
  const comment = ended.comment && {
    author: ended.comment.author,
    body: quoted(ended.comment.body),
  };
  const href = escapeHtml(ended.url);
  const unsubscribe = escapeHtml(ended.unsubscribeUrl);
  const key = escapeHtml(ended.key);
  const mono = "ui-monospace,Menlo,Consolas,monospace";
  const commentHtml = comment
    ? `<div style="font:500 14px/1.5 ${font};color:#0a0a0a;padding-bottom:6px">${escapeHtml(comment.author)} wrote:</div>
<div style="font:400 15px/1.5 ${font};color:#0a0a0a;white-space:pre-wrap;word-break:break-word;border-left:3px solid #e5e5e5;padding:0 0 0 12px;margin-bottom:24px">${escapeHtml(comment.body)}</div>
`
    : "";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${key} ${outcome}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
<div style="max-width:480px;margin:0 auto;padding:40px 24px">
<div style="font:600 18px/1.2 ${font};color:#0a0a0a;padding-bottom:24px">trail<span style="color:#006375">.</span></div>
<div style="font:400 16px/1.5 ${font};color:#0a0a0a;padding-bottom:12px">The issue filed for you ${outcome}.</div>
<div style="font:600 16px/1.4 ${font};color:#0a0a0a;padding-bottom:24px"><span style="font:500 14px/1.4 ${mono};color:#636363">${key}</span>&nbsp; ${escapeHtml(ended.title)}</div>
${commentHtml}<div style="padding-bottom:24px"><a href="${href}" style="display:inline-block;background:#171717;color:#fafafa;font:500 15px/1 ${font};padding:13px 20px;border-radius:6px;text-decoration:none">Open ${key}</a></div>
<div style="border-top:1px solid #e5e5e5;padding-top:16px;font:400 12px/1.5 ${font};color:#636363">You get this email each time an issue filed for you is done or canceled. <a href="${unsubscribe}" style="color:#636363">Stop these emails</a></div>
</div>
</body></html>
`;
  const commentText = comment
    ? `${comment.author} wrote:\n\n${comment.body}\n\n`
    : "";
  const text = `The issue filed for you ${outcome}.

${ended.key}  ${ended.title}

${commentText}Open it in trail:
${ended.url}

You get this email each time an issue filed for you is done or canceled. Stop these emails:
${ended.unsubscribeUrl}
`;
  return { subject: `${ended.key} ${outcome}: ${ended.title}`, html, text };
}
