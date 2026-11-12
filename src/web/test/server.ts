import { setupServer } from "msw/node";

// No handlers by default: a test adds its own with server.use(...). One server per test
// process: a second setupServer's close() turns interception off for this one too.
export const server = setupServer();

// Unanswered requests, recorded for setup.ts to fail the test on. The server's 'error'
// strategy only rejects the fetch, which app code with an error state catches and renders.
export const leaks: string[] = [];
server.events.on("request:unhandled", ({ request }) => {
  leaks.push(`unhandled ${request.method} ${request.url}`);
});
server.events.on("response:bypass", ({ request }) => {
  leaks.push(`real network ${request.method} ${request.url}`);
});
server.events.on("unhandledException", ({ request, error }) => {
  leaks.push(`handler threw on ${request.method} ${request.url}: ${error}`);
});
