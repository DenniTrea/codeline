import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../src/api.ts";
test("an empty proxy error produces a useful retry message rather than a JSON parser failure", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("", { status: 502 });
    await assert.rejects(
      api("/api/exercises"),
      /temporarily unavailable \(502\)/,
    );
  } finally {
    globalThis.fetch = previous;
  }
});
test("connection failures do not retry a mutation", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError("network");
    };
    await assert.rejects(
      api("/api/games/1/submit", { method: "POST", body: "{}" }),
      /Check the connection/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous;
  }
});
test("no-content success and structured validation errors are handled correctly", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal(await api("/auth/logout", { method: "POST" }), null);
    globalThis.fetch = async () =>
      Response.json(
        { error: "A ready exercise needs a BLANK line" },
        { status: 400 },
      );
    await assert.rejects(
      api("/api/exercises", { method: "POST" }),
      /BLANK line/,
    );
  } finally {
    globalThis.fetch = previous;
  }
});
