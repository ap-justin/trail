import { expect, test } from "vitest";
import {
  checkWebhookUrl,
  isInternalAddress,
  UnsafeUrlError,
} from "./address.js";

const publicHost = async () => ["93.184.216.34"];

test.each([
  "https://127.0.0.1/hook",
  "https://127.1.2.3/hook",
  "https://10.0.0.1/hook",
  "https://172.16.0.1/hook",
  "https://172.31.255.255/hook",
  "https://192.168.1.1/hook",
  "https://100.64.0.1/hook",
  "https://169.254.169.254/latest/meta-data",
  "https://0.0.0.0/hook",
  "https://224.0.0.1/hook",
  "https://255.255.255.255/hook",
  "https://[::1]/hook",
  "https://[::]/hook",
  "https://[fe80::1]/hook",
  "https://[fd00:ec2::254]/latest",
  "https://[fc00::1]/hook",
  "https://[::ffff:127.0.0.1]/hook",
  "https://[::ffff:7f00:1]/hook",
  "https://[::ffff:10.0.0.1]/hook",
  "https://[64:ff9b::a00:1]/hook",
  "https://[2002:7f00:1::]/hook",
  "https://[2001:db8::1]/hook",
  "https://[ff02::1]/hook",
  // the URL parser reads these as 127.0.0.1
  "https://2130706433/hook",
  "https://0x7f.1/hook",
  "https://0177.0.0.1/hook",
])("%s is refused", async (url) => {
  await expect(checkWebhookUrl(url, publicHost)).rejects.toThrow(
    UnsafeUrlError,
  );
});

test.each([
  ["http://example.com/hook", /https/],
  ["ftp://example.com/hook", /https/],
  ["https://user:pw@example.com/hook", /username or password/],
  ["not a url", /not valid/],
])("%s is refused before any lookup", async (url, message) => {
  const resolve = async () => {
    throw new Error("must not resolve");
  };
  await expect(checkWebhookUrl(url, resolve)).rejects.toThrow(message);
});

test("a host that resolves to a private address is refused, however the name looks", async () => {
  await expect(
    checkWebhookUrl("https://bot.example.com/hook", async () => ["10.1.2.3"]),
  ).rejects.toThrow(/internal address/);
  await expect(
    checkWebhookUrl("https://localhost/hook", async () => ["::1"]),
  ).rejects.toThrow(/internal address/);
});

test("a host that resolves to a public and an internal address is refused", async () => {
  await expect(
    checkWebhookUrl("https://bot.example.com/hook", async () => [
      "93.184.216.34",
      "127.0.0.1",
    ]),
  ).rejects.toThrow(/internal address/);
});

test("a host that does not resolve is refused", async () => {
  await expect(
    checkWebhookUrl("https://nope.example.com/hook", async () => {
      throw new Error("ENOTFOUND");
    }),
  ).rejects.toThrow(/did not resolve/);
  await expect(
    checkWebhookUrl("https://nope.example.com/hook", async () => []),
  ).rejects.toThrow(/did not resolve/);
});

test.each([
  ["https://93.184.216.34/hook", "93.184.216.34"],
  ["https://8.8.8.8:8443/hook", "8.8.8.8"],
  ["https://[2606:4700:4700::1111]/hook", "2606:4700:4700::1111"],
  ["https://bot.example.com/hook", "93.184.216.34"],
])("%s is accepted and connects to %s", async (url, address) => {
  const checked = await checkWebhookUrl(url, publicHost);
  expect(checked.address).toBe(address);
});

test("isInternalAddress refuses what is not an address", () => {
  expect(isInternalAddress("example.com")).toBe(true);
  expect(isInternalAddress("93.184.216.34")).toBe(false);
});
