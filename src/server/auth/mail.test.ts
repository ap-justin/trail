import { expect, test } from "vitest";
import {
  issueEndedEmail,
  type MailMessage,
  MailRefused,
  resendTransport,
  signInEmail,
} from "./mail.js";

const message: MailMessage = {
  from: "trail <trail@mail.example.test>",
  to: "dana@example.com",
  subject: "Your trail sign-in link",
  html: "<p>hi</p>",
  text: "hi",
};

test("Resend gets one POST /emails with the key as a bearer token and the message as JSON", async () => {
  const sent: Request[] = [];
  const send = resendTransport("re_key", async (input, init) => {
    sent.push(new Request(input, init));
    return Response.json({ id: "49a3999c" });
  });
  await send(message);
  expect(sent).toHaveLength(1);
  const [req] = sent as [Request];
  expect(req.method).toBe("POST");
  expect(req.url).toBe("https://api.resend.com/emails");
  expect(req.headers.get("authorization")).toBe("Bearer re_key");
  expect(await req.json()).toEqual({ ...message, to: ["dana@example.com"] });
});

test("a refusal from Resend rejects with its status and body", async () => {
  const send = resendTransport("re_key", async () =>
    Response.json({ name: "validation_error" }, { status: 422 }),
  );
  await expect(send(message)).rejects.toThrow(/422.*validation_error/);
});

test("aborting the signal passed to the transport cuts the request", async () => {
  const send = resendTransport(
    "re_key",
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  const shutdown = new AbortController();
  const sending = send(message, shutdown.signal);
  const reason = new Error("shutting down");
  shutdown.abort(reason);
  await expect(sending).rejects.toBe(reason);
});

const url =
  "https://trail.example/sign-in/confirm?token=b7Xk2mQe9Ls4PvTa8Ncd5JhWrU3yZo0G&callbackURL=%2F";

test("the plain-text email is the designed copy around the link", () => {
  expect(signInEmail(url).text).toBe(`Use this link to sign in to trail:

${url}

It works once and expires in 15 minutes.

Didn't ask for it? Ignore this email and nothing happens.
`);
});

test("the HTML email links the button and the fallback to the link, and loads nothing", () => {
  const { subject, html } = signInEmail(url);
  expect(subject).toBe("Your trail sign-in link");
  const escaped = url.replaceAll("&", "&amp;");
  expect(html.split(`href="${escaped}"`)).toHaveLength(3);
  expect(html).toContain(">Sign in to trail</a>");
  expect(html).toContain("This link works once and expires in 15 minutes.");
  expect(html).toContain(
    "Didn't ask for it? Ignore this email and nothing happens.",
  );
  expect(html).toContain(
    "Button not working? Paste this link into your browser:",
  );
  expect(html).not.toMatch(/<img|<link|<script|url\(/i);
  // no address but the link itself
  expect(html.match(/https?:\/\/[^\s"<]+/g)?.every((u) => u === escaped)).toBe(
    true,
  );
});

test("Resend gets the email headers in the JSON body and the idempotency key as a request header", async () => {
  const sent: Request[] = [];
  const send = resendTransport("re_key", async (input, init) => {
    sent.push(new Request(input, init));
    return Response.json({ id: "49a3999c" });
  });
  const headers = {
    "List-Unsubscribe": "<https://trail.example/unsubscribe/issue-end?t=x>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  await send({ ...message, headers, idempotencyKey: "issue-end-mail/abc" });
  const [req] = sent as [Request];
  expect(req.headers.get("idempotency-key")).toBe("issue-end-mail/abc");
  expect(await req.json()).toEqual({
    ...message,
    to: ["dana@example.com"],
    headers,
  });
});

test("a refusal carries Resend's status, and a dropped connection none", async () => {
  const refused = resendTransport("re_key", async () =>
    Response.json({ name: "rate_limit_exceeded" }, { status: 429 }),
  );
  await expect(refused(message)).rejects.toMatchObject({ status: 429 });
  const dropped = resendTransport("re_key", async () => {
    throw new TypeError("fetch failed");
  });
  await expect(dropped(message)).rejects.not.toBeInstanceOf(MailRefused);
});

const ended = {
  key: "ATL-7",
  title: "Export drops the last row",
  status: "done" as const,
  comment: {
    author: "Atlas",
    body: "Fixed in the CSV writer: the last row was never flushed.",
  },
  url: "https://trail.example/issues/ATL-7",
  unsubscribeUrl: "https://trail.example/unsubscribe/issue-end?t=tok",
};

test("the issue-ended email names the key, title and final status, quotes the owner bot's comment and links the issue and the unsubscribe page", () => {
  const { subject, html, text } = issueEndedEmail(ended);
  expect(subject).toBe("ATL-7 is done: Export drops the last row");
  expect(text).toBe(`The issue filed for you is done.

ATL-7  Export drops the last row

Atlas wrote:

Fixed in the CSV writer: the last row was never flushed.

Open it in trail:
https://trail.example/issues/ATL-7

You get this email each time an issue filed for you is done or canceled. Stop these emails:
https://trail.example/unsubscribe/issue-end?t=tok
`);
  for (const part of [
    "The issue filed for you is done.",
    "ATL-7",
    "Export drops the last row",
    "Atlas wrote:",
    "Fixed in the CSV writer: the last row was never flushed.",
    `href="${ended.url}"`,
    `href="${ended.unsubscribeUrl}"`,
  ]) {
    expect(html).toContain(part);
  }
  expect(html).not.toMatch(/<img|<link|<script|url\(/i);
  // no address but the two links, and nothing appended to them
  expect(
    html
      .match(/https?:\/\/[^\s"<]+/g)
      ?.every((u) => u === ended.url || u === ended.unsubscribeUrl),
  ).toBe(true);
  expect(html).not.toMatch(/utm_|[?&](ref|src)=/);
});

test("a canceled issue says so, and one with no owner-bot comment has no comment block", () => {
  const { subject, html, text } = issueEndedEmail({
    ...ended,
    status: "canceled",
    comment: null,
  });
  expect(subject).toBe("ATL-7 was canceled: Export drops the last row");
  expect(text).toMatch(/^The issue filed for you was canceled\.\n/);
  expect(text).not.toContain("wrote:");
  expect(html).toContain("The issue filed for you was canceled.");
  expect(html).not.toContain("wrote:");
});

test("a hostile title and comment arrive escaped, the comment as plain text and cut with an ellipsis", () => {
  const { subject, html, text } = issueEndedEmail({
    ...ended,
    title: `<script>alert("t")</script>`,
    comment: {
      author: "<b>Atlas</b>",
      body: `**bold** <img src="https://evil.example/p.png"> [x](https://evil.example) ${"long ".repeat(400)}`,
    },
  });
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>Atlas");
  expect(html).toContain("&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;");
  expect(html).toContain(
    "&lt;img src=&quot;https://evil.example/p.png&quot;&gt;",
  );
  expect(html).toContain("**bold**");
  expect(html).not.toMatch(/href="https:\/\/evil/);
  expect(subject).toBe(`ATL-7 is done: <script>alert("t")</script>`);
  const quoted = text.split("wrote:\n\n")[1]?.split("\n\nOpen it")[0] ?? "";
  expect(quoted.endsWith("…")).toBe(true);
  expect([...quoted].length).toBeLessThanOrEqual(1001);
});
