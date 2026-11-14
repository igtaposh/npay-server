import test from "node:test";
import assert from "node:assert/strict";
import { createSmepayClient } from "./controllers/retailer/smepayClient.js";
const config = () => ({
  baseUrl: "https://staging.smepay.in",
  clientId: "id",
  clientSecret: "secret",
  environment: "test",
});
const response = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
test("SMEPay shares authentication and adds bearer and client ID", async () => {
  let auth = 0;
  const calls = [];
  const client = createSmepayClient({
    config,
    transport: async (url, options) => {
      if (url.endsWith("/auth")) {
        auth++;
        await new Promise((r) => setTimeout(r, 10));
        return response({
          access_token: "token",
          expires_in: 600,
          environment: "test",
        });
      }
      calls.push(options);
      return response({ status: true });
    },
  });
  await Promise.all([
    client.request("/api/external/order/status", {}),
    client.request("/api/external/order/status", {}),
  ]);
  assert.equal(auth, 1);
  assert.equal(calls[0].headers.Authorization, "Bearer token");
  assert.equal(JSON.parse(calls[0].body).client_id, "id");
});
test("SMEPay does not replay an ambiguous create timeout", async () => {
  let creates = 0;
  const client = createSmepayClient({
    config,
    transport: async (url) => {
      if (url.endsWith("/auth")) return response({ access_token: "token" });
      creates++;
      throw Error("timeout");
    },
  });
  await assert.rejects(client.request("/api/external/order/create", {}), {
    status: 503,
  });
  assert.equal(creates, 1);
});
test("SMEPay refreshes rejected authentication once", async () => {
  let auth = 0,
    calls = 0;
  const client = createSmepayClient({
    config,
    transport: async (url) => {
      if (url.endsWith("/auth"))
        return response({ access_token: `token-${++auth}` });
      return ++calls === 1 ? response({}, 401) : response({ status: true });
    },
  });
  assert.equal(
    (await client.request("/api/external/order/status", {})).status,
    true,
  );
  assert.equal(auth, 2);
  assert.equal(calls, 2);
});
