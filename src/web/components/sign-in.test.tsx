import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, test, vi } from "vitest";
import {
  ConfirmSignInView,
  EMAIL_HINT,
  NotInvitedView,
  SignInView,
} from "@/components/sign-in";

type Props = ComponentProps<typeof SignInView>;

function renderSignIn(overrides: Partial<Props> = {}) {
  const props: Props = {
    onSignIn: vi.fn(),
    emailSignIn: true,
    onEmailLink: vi.fn(),
    onUseDifferentAddress: vi.fn(),
    ...overrides,
  };
  const view = render(<SignInView {...props} />);
  return {
    props,
    rerender: (next: Partial<Props>) =>
      view.rerender(<SignInView {...props} {...next} />),
  };
}

const emailBox = () => screen.getByRole("textbox", { name: "Email" });
const sendButton = () =>
  screen.getByRole("button", { name: "Email me a sign-in link" });

test("a failed sign-in start shows its message above the button, announced", () => {
  const { rerender } = renderSignIn();
  const [status] = screen.getAllByRole("status");
  expect(status).toBeEmptyDOMElement();

  rerender({ error: "GitHub sign-in isn't set up on this server." });
  expect(status).toHaveTextContent(
    "GitHub sign-in isn't set up on this server.",
  );
  const button = screen.getByRole("button", { name: "Continue with GitHub" });
  expect(status?.compareDocumentPosition(button)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

test("the sign-in card shows the mark beside the wordmark", () => {
  renderSignIn();
  const main = screen.getByRole("main");
  const mark = main.querySelector("svg");
  expect(mark).toHaveAttribute("aria-hidden", "true");
  expect(mark?.querySelectorAll("rect")).toHaveLength(3);
  expect(mark?.nextElementSibling).toHaveTextContent("trail.");
});

describe("email sign-in", () => {
  test("offers an email field and its button below GitHub, for GitHub accounts or invited addresses", () => {
    renderSignIn();
    expect(screen.getByRole("main")).toHaveTextContent(
      "Sign in with the GitHub account or email address you were invited with.",
    );
    expect(emailBox()).toHaveAttribute("placeholder", "you@example.com");
    expect(
      screen
        .getByRole("button", { name: "Continue with GitHub" })
        .compareDocumentPosition(emailBox()),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(sendButton()).toBeInTheDocument();
    expect(
      screen.getByText("Only invited people can sign in."),
    ).toBeInTheDocument();
  });

  test("sends the address, trimmed", async () => {
    const user = userEvent.setup();
    const { props } = renderSignIn();
    await user.type(emailBox(), "  dana@example.com ");
    await user.click(sendButton());
    expect(props.onEmailLink).toHaveBeenCalledWith("dana@example.com");
  });

  test("Enter in the field sends too", async () => {
    const user = userEvent.setup();
    const { props } = renderSignIn();
    await user.type(emailBox(), "dana@example.com{Enter}");
    expect(props.onEmailLink).toHaveBeenCalledWith("dana@example.com");
  });

  test("something that isn't an address is refused at the field, with focus, and nothing is sent", async () => {
    const user = userEvent.setup();
    const { props } = renderSignIn();
    await user.type(emailBox(), "dana@");
    await user.click(sendButton());
    expect(props.onEmailLink).not.toHaveBeenCalled();
    expect(emailBox()).toHaveFocus();
    expect(emailBox()).toHaveAttribute("aria-invalid", "true");
    expect(emailBox()).toHaveAccessibleDescription(EMAIL_HINT);
    // the correction pass is on change
    await user.type(emailBox(), "example.com");
    expect(emailBox()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(EMAIL_HINT)).not.toBeInTheDocument();
  });

  test("an untouched field marks nothing while it is typed into", async () => {
    const user = userEvent.setup();
    renderSignIn();
    await user.type(emailBox(), "dana");
    expect(emailBox()).not.toHaveAttribute("aria-invalid");
  });

  test("the server refusing the address marks the field and moves focus to it", async () => {
    const user = userEvent.setup();
    const { rerender } = renderSignIn();
    await user.type(emailBox(), "dana@example.com");
    await user.click(sendButton());
    rerender({ emailLink: { status: "sending" } });
    rerender({ emailLink: { status: "refused" } });
    expect(emailBox()).toHaveFocus();
    expect(emailBox()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(EMAIL_HINT)).toBeInTheDocument();
  });

  test("while sending: the button reads Sending… and holds, the field keeps the address", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderSignIn();
    await user.type(emailBox(), "dana@example.com");
    await user.click(sendButton());
    rerender({ emailLink: { status: "sending" } });
    const sending = screen.getByRole("button", { name: "Sending…" });
    expect(sending).toHaveAttribute("aria-disabled", "true");
    expect(sending).toHaveAttribute("aria-busy", "true");
    expect(emailBox()).toHaveAttribute("readonly");
    expect(emailBox()).toHaveValue("dana@example.com");
    await user.click(sending);
    expect(props.onEmailLink).toHaveBeenCalledTimes(1);
  });

  test("link sent: Check your email takes the form's place and focus, and GitHub stays", async () => {
    const user = userEvent.setup();
    const { rerender } = renderSignIn();
    await user.type(emailBox(), "dana@example.com");
    await user.click(sendButton());
    rerender({ emailLink: { status: "sent" } });
    const panel = screen.getByText("Check your email").closest("div[tabindex]");
    expect(panel).toHaveFocus();
    expect(panel).toHaveTextContent(
      "If that address is invited, a link is on its way. It works for 15 minutes.",
    );
    expect(
      screen.queryByRole("textbox", { name: "Email" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeInTheDocument();
  });

  test("Use a different address brings back an empty field, focused", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderSignIn({ emailLink: { status: "sent" } });
    await user.click(
      screen.getByRole("button", { name: "Use a different address" }),
    );
    expect(props.onUseDifferentAddress).toHaveBeenCalledTimes(1);
    rerender({ emailLink: { status: "idle" } });
    expect(emailBox()).toHaveFocus();
    expect(emailBox()).toHaveValue("");
  });

  test("the field isn't focused on arrival", () => {
    renderSignIn();
    expect(emailBox()).not.toHaveFocus();
  });

  test("rate-limited: says so under the button through a status already in place", () => {
    const { rerender } = renderSignIn();
    const status = screen.getAllByRole("status")[1];
    expect(status).toBeEmptyDOMElement();
    rerender({
      emailLink: { status: "rate_limited", retryAfterSeconds: null },
    });
    expect(status).toHaveTextContent(
      "Too many requests, try again in a few minutes.",
    );
    expect(sendButton().compareDocumentPosition(status as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test("any other failure shows its message in the same place", () => {
    renderSignIn({
      emailLink: {
        status: "failed",
        message: "Couldn't reach trail. Check your connection, then try again.",
      },
    });
    expect(screen.getAllByRole("status")[1]).toHaveTextContent(
      "Couldn't reach trail. Check your connection, then try again.",
    );
  });
});

describe("email sign-in off", () => {
  test("GitHub only: no field, no way to ask for a link, and the line says why", () => {
    renderSignIn({ emailSignIn: false });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Email me a sign-in link" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("or")).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent(
      "Sign in with the GitHub account you were invited with.",
    );
    expect(
      screen.getByText(
        "Email sign-in isn't available right now. Only invited accounts can sign in.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeEnabled();
  });
});

describe("a sign-in link that didn't work", () => {
  test("an alert takes the intro's place, and both ways in stay", () => {
    renderSignIn({ expired: true });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That link didn't work");
    expect(alert).toHaveTextContent(
      "Sign-in links work once and expire after 15 minutes. Request a new one below.",
    );
    expect(
      screen.queryByText(/trail is where the bots track their work/),
    ).not.toBeInTheDocument();
    expect(emailBox()).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    ).toBeInTheDocument();
  });

  test("once a new link is sent, the alert gives way to Check your email", () => {
    renderSignIn({ expired: true, emailLink: { status: "sent" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Check your email")).toBeInTheDocument();
  });
});

describe("not invited", () => {
  test("a GitHub account: its @login, and the owner asked for a username or address", () => {
    render(
      <NotInvitedView
        stranger={{ login: "devon-r" }}
        ownerName="Justin Salas"
        onSignInAgain={vi.fn()}
      />,
    );
    expect(screen.getByText("@devon-r")).toHaveClass("font-mono");
    expect(screen.getByRole("main")).toHaveTextContent(
      "@devon-r signed in with GitHub, but that account isn't on the list. Ask Justin Salas to invite your GitHub username or email address, then sign in again.",
    );
  });

  test("an email address: the address, and signing in again is offered", async () => {
    const user = userEvent.setup();
    const onSignInAgain = vi.fn();
    render(
      <NotInvitedView
        stranger={{ email: "dana@example.com" }}
        ownerName="Justin Salas"
        onSignInAgain={onSignInAgain}
      />,
    );
    expect(screen.getByText("dana@example.com")).toHaveClass("font-mono");
    expect(screen.getByRole("main")).toHaveTextContent(
      "dana@example.com signed in by email, but that address isn't on the list. Ask Justin Salas to invite your GitHub username or email address, then sign in again.",
    );
    await user.click(
      screen.getByRole("button", { name: "Sign in with a different account" }),
    );
    expect(onSignInAgain).toHaveBeenCalledTimes(1);
  });
});

describe("rate-limited with the server's wait", () => {
  test.each([
    [1, "Too many requests, try again in 1 minute."],
    [60, "Too many requests, try again in 1 minute."],
    [61, "Too many requests, try again in 2 minutes."],
    [600, "Too many requests, try again in 10 minutes."],
  ])("%i seconds reads %j", (seconds, line) => {
    renderSignIn({
      emailLink: { status: "rate_limited", retryAfterSeconds: seconds },
    });
    expect(screen.getAllByRole("status")[1]).toHaveTextContent(line);
  });

  test("without a wait, the designed line stands", () => {
    renderSignIn({
      emailLink: { status: "rate_limited", retryAfterSeconds: null },
    });
    expect(screen.getAllByRole("status")[1]).toHaveTextContent(
      "Too many requests, try again in a few minutes.",
    );
  });
});

describe("confirming a sign-in link", () => {
  type ConfirmProps = ComponentProps<typeof ConfirmSignInView>;
  function renderConfirm(overrides: Partial<ConfirmProps> = {}) {
    const props: ConfirmProps = {
      email: "dana@example.com",
      onConfirm: vi.fn(),
      pending: false,
      ...overrides,
    };
    const view = render(<ConfirmSignInView {...props} />);
    return {
      props,
      rerender: (next: Partial<ConfirmProps>) =>
        view.rerender(<ConfirmSignInView {...props} {...next} />),
    };
  }

  test("names the address and offers Sign in on the sign-in card", () => {
    renderConfirm();
    expect(
      screen.getByRole("heading", { name: "Sign in to trail" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent(
      "Continue to sign in as dana@example.com.",
    );
    expect(screen.getByText("dana@example.com")).toHaveClass("font-mono");
  });

  test("without the address, says what the link does without naming one", () => {
    renderConfirm({ email: undefined });
    expect(screen.getByRole("main")).toHaveTextContent(
      "Continue to sign in with the link from your email.",
    );
  });

  test("Sign in confirms once; while in flight it reads Signing in… and holds", async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderConfirm();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    rerender({ pending: true });
    const held = screen.getByRole("button", { name: "Signing in…" });
    expect(held).toHaveAttribute("aria-disabled", "true");
    await user.click(held);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  test("a failure is announced on the card through a status already in place", () => {
    const { rerender } = renderConfirm();
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    rerender({ error: "Something went wrong on our side. Try again." });
    expect(status).toHaveTextContent(
      "Something went wrong on our side. Try again.",
    );
  });
});
