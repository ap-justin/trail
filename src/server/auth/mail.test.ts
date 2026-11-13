import { expect, test } from "vitest";
import { type MailMessage, resendTransport, signInEmail } from "./mail.js";

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

const url =
  "https://trail.example/sign-in/confirm?token=b7Xk2mQe9Ls4PvTa8Ncd5JhWrU3yZo0G&callbackURL=%2F&email=dana%40example.com";

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
