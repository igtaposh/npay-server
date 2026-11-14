import { mrobotics } from "./controllers/retailer/mroboticsClient.js";
import { smepay } from "./controllers/retailer/smepayClient.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { app } from "./app.js";
import { pool, initializeDatabase } from "./config/db.js";
import { money, id, hashPassword } from "./controllers/controllerHelpers.js";
const integration = process.env.RUN_API_INTEGRATION === "1";
test("amounts reject invalid precision and keep exact decimal values", () => {
  assert.equal(money("299.10"), "299.10");
  assert.equal(money(100), "100.00");
  for (const value of ["NaN", "1e2", "-1", "0", "1.001", {}, null])
    assert.throws(() => money(value));
  assert.throws(() => id("not-a-uuid"));
});
test(
  "API integration with isolated PostgreSQL",
  {
    skip: !integration,
  },
  async (t) => {
    assert.match(
      process.env.DB_NAME || "",
      /^npay_test_/,
      "Use a dedicated disposable npay_test_* database.",
    );
    process.env.DEMO_MODE = "false";
    process.env.PAYMENT_GATEWAY = "";
    process.env.RECHARGE_PROVIDER = "";
    process.env.JWT_SECRET = "test-only-jwt-secret-with-at-least-32-bytes";
    process.env.OTP_SECRET = "test-only-otp-secret-with-at-least-32-bytes";
    process.env.SALT_ROUNDS = "10";
    process.env.GIFT_CODE_KEY = "ab".repeat(32);
    const deliveries = new Map();
    const otpServer = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      deliveries.set(data.destination, data.otp);
      res.writeHead(200, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify({
          success: true,
        }),
      );
    });
    await new Promise((resolve) => otpServer.listen(0, "127.0.0.1", resolve));
    process.env.OTP_API_URL = `http://127.0.0.1:${otpServer.address().port}`;
    process.env.OTP_API_KEY = "test";
    let server;
    t.after(async () => {
      if (server) await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => otpServer.close(resolve));
      await pool.end();
    });
    await initializeDatabase();
    // Ensure all migrations support a second startup too.
    await initializeDatabase();
    const suffix = randomUUID().slice(0, 8);
    let counter = Math.floor(Math.random() * 9000);
    const partner = () => {
      const value = ++counter;
      return {
        name: "Test Partner",
        business_name: "Test Shop",
        phone: String(9800000000 + value),
        email: `${suffix}-${value}@example.com`,
        business_address: "Test address",
        pan: `ABCDE${String(value).padStart(4, "0")}F`,
        adhar: String(100000000000 + value),
        password: "Password123!",
        mpin: "1234",
        distributor_slug: `${suffix}-${value}`,
        retailer_slug: `${suffix}-${value}`,
        distributor_image_link: "https://example.com/image.png",
      };
    };
    const adminPhone = String(9700000000 + counter);
    await pool.query(
      `INSERT INTO admins (name, phone, email, password_hash) VALUES ('Test Admin', $1, $2, $3)`,
      [
        adminPhone,
        `${suffix}-admin@example.com`,
        await hashPassword("Password123!"),
      ],
    );
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body, token, headers = {}) => {
      const response = await fetch(`${base}/api${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token
            ? {
                authorization: `Bearer ${token}`,
              }
            : {}),
          ...headers,
        },
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
            }),
      });
      return {
        status: response.status,
        ...(await response.json()),
      };
    };
    let adminToken,
      distributorToken,
      otherDistributorToken,
      retailerToken,
      secondToken,
      retailer,
      otherRetailer;
    let retailerInput,
      otherInput,
      distributorId,
      otherDistributorId,
      prepaid,
      gift,
      circle,
      plan;
    await t.test(
      "admin login, required name, protected admin creation and secret filtering",
      async () => {
        assert.equal((await call("POST", "/admin/admins", {})).status, 401);
        assert.equal((await call("GET", "/admin/profile")).status, 401);
        assert.equal(
          (await call("POST", "/admin/password", {
            current_password: "Password123!",
            new_password: "NewPassword123!",
          })).status,
          401,
        );
        const login = await call("POST", "/admin/login", {
          phone: adminPhone,
          password: "Password123!",
        });
        assert.equal(login.status, 200);
        adminToken = login.data.access_token;
        assert.equal(login.data.account.password_hash, undefined);
        const missing = await call(
          "POST",
          "/admin/admins",
          {
            phone: "9999999999",
            email: "new@example.com",
            password: "Password123!",
          },
          adminToken,
        );
        assert.equal(missing.status, 400);
        const created = await call(
          "POST",
          "/admin/admins",
          {
            name: "Another admin",
            phone: "9999999999",
            email: `${suffix}-new@example.com`,
            password: "Password123!",
          },
          adminToken,
        );
        assert.equal(created.status, 201);
        assert.equal(created.data.password_hash, undefined);
      },
    );
    await t.test("distributor onboarding and account status", async () => {
      for (let index = 0; index < 2; index++) {
        const body = partner();
        const created = await call(
          "POST",
          "/admin/distributors",
          body,
          adminToken,
        );
        assert.equal(created.status, 201, JSON.stringify(created));
        assert.equal(created.data.adhar, undefined);
        const pending = await call("POST", "/distributor/login", body);
        assert.equal(pending.status, 401);
        assert.equal(
          (
            await call(
              "PATCH",
              `/admin/distributors/${created.data.id}/status`,
              {
                status: "active",
              },
              adminToken,
            )
          ).status,
          200,
        );
        const login = await call("POST", "/distributor/login", body);
        assert.equal(login.status, 200);
        if (index === 0) {
          distributorToken = login.data.access_token;
          distributorId = created.data.id;
        } else {
          otherDistributorToken = login.data.access_token;
          otherDistributorId = created.data.id;
        }
      }
      assert.equal(
        (await call("GET", "/admin/dashboard", undefined, distributorToken))
          .status,
        403,
      );
    });
    await t.test(
      "retailer onboarding creates wallets and enforces distributor scope",
      async () => {
        retailerInput = partner();
        const created = await call(
          "POST",
          "/distributor/retailers",
          {
            ...retailerInput,
            distributor_id: otherDistributorId,
          },
          distributorToken,
        );
        assert.equal(created.status, 201, JSON.stringify(created));
        retailer = created.data;
        assert.equal(retailer.distributor_id, distributorId);
        assert.equal(
          (
            await call(
              "PATCH",
              `/distributor/retailers/${retailer.id}/status`,
              {
                status: "active",
              },
              otherDistributorToken,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await call(
              "PATCH",
              `/distributor/retailers/${retailer.id}/status`,
              {
                status: "active",
              },
              distributorToken,
            )
          ).status,
          200,
        );
        const login = await call("POST", "/retailer/login", retailerInput);
        assert.equal(login.status, 200);
        retailerToken = login.data.access_token;
        assert.equal(login.data.account.mpin_hash, undefined);
        assert.equal(login.data.account.password_hash, undefined);
        assert.equal(
          (await call("GET", "/retailer/wallet", undefined, retailerToken)).data
            .balance,
          "0.00",
        );
        otherInput = partner();
        const second = await call(
          "POST",
          "/distributor/retailers",
          otherInput,
          otherDistributorToken,
        );
        assert.equal(second.status, 201);
        otherRetailer = second.data;
        await call(
          "PATCH",
          `/distributor/retailers/${otherRetailer.id}/status`,
          {
            status: "active",
          },
          otherDistributorToken,
        );
        secondToken = (await call("POST", "/retailer/login", otherInput)).data
          .access_token;
      },
    );
    await t.test("catalog and commission administration", async () => {
      const operators = await call(
        "GET",
        "/retailer/operators",
        undefined,
        retailerToken,
      );
      prepaid = operators.data.find((row) => row.code === "jio");
      gift = operators.data.find((row) => row.code === "google-play");
      circle = (
        await call("GET", "/retailer/circles", undefined, retailerToken)
      ).data.find((row) => row.code === "west-bengal");
      const created = await call(
        "POST",
        "/admin/plans",
        {
          operator_id: prepaid.id,
          circle_id: circle.id,
          code: `plan-${suffix}`,
          name: "Test 299",
          category: "popular",
          amount: "299.00",
        },
        adminToken,
      );
      assert.equal(created.status, 201, JSON.stringify(created));
      plan = created.data;
      assert.equal(
        (
          await call(
            "POST",
            "/admin/plans",
            {
              operator_id: gift.id,
              name: "Bad",
              code: "bad",
              category: "popular",
              amount: 100,
            },
            adminToken,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            "PUT",
            "/admin/commissions",
            {
              operator_id: prepaid.id,
              rate: "2.4",
            },
            adminToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            "PUT",
            "/admin/commissions",
            {
              operator_id: prepaid.id,
              retailer_id: retailer.id,
              rate: "3",
            },
            adminToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            "GET",
            `/retailer/plans?operator_id=${prepaid.id}&circle_id=${circle.id}`,
            undefined,
            retailerToken,
          )
        ).data.length,
        1,
      );
      assert.equal(
        (
          await call(
            "POST",
            "/admin/faqs",
            {
              question: "Test?",
              answer: "Answer",
              unexpected: "value",
            },
            adminToken,
          )
        ).status,
        400,
      );
      const faq = await call(
        "POST",
        "/admin/faqs",
        {
          question: "Test?",
          answer: "Answer",
        },
        adminToken,
      );
      assert.equal(faq.status, 201);
      assert.equal(
        (
          await call(
            "PATCH",
            `/admin/faqs/${faq.data.id}`,
            {
              answer: "Updated",
            },
            adminToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            "DELETE",
            `/admin/faqs/${faq.data.id}`,
            undefined,
            adminToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (await call("GET", "/retailer/help", undefined, retailerToken)).data
          .faqs.length,
        0,
      );
    });
    let topupId;
    await t.test(
      "top-up requests require admin verification; concurrent settlement credits once",
      async () => {
        const topup = await call(
          "POST",
          "/retailer/wallet/topups",
          {
            amount: 1000,
          },
          retailerToken,
          {
            "Idempotency-Key": "test-topup",
          },
        );
        assert.equal(topup.status, 202);
        topupId = topup.data.id;
        assert.equal(
          (await call("GET", "/retailer/wallet", undefined, retailerToken)).data
            .balance,
          "0.00",
        );
        const body = {
          status: "Successful",
          amount: "1000",
          currency: "INR",
          reference: `${suffix}-bank-1`,
          reason: "Bank receipt independently verified",
        };
        assert.equal(
          (
            await call(
              "POST",
              `/admin/transactions/${topupId}/settle`,
              body,
              retailerToken,
            )
          ).status,
          403,
        );
        const settled = await Promise.all([
          call(
            "POST",
            `/admin/transactions/${topupId}/settle`,
            body,
            adminToken,
          ),
          call(
            "POST",
            `/admin/transactions/${topupId}/settle`,
            body,
            adminToken,
          ),
        ]);
        assert.ok(
          settled.every((result) => result.status === 200),
          JSON.stringify(settled),
        );
        assert.equal(
          (await call("GET", "/retailer/wallet", undefined, retailerToken)).data
            .balance,
          "1000.00",
        );
        assert.equal(
          (
            await call(
              "POST",
              "/retailer/wallet/topups",
              {
                amount: 1001,
              },
              retailerToken,
              {
                "Idempotency-Key": "test-topup",
              },
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await call(
              "GET",
              `/retailer/transactions/${topupId}`,
              undefined,
              secondToken,
            )
          ).status,
          404,
        );
      },
    );
    const rechargeBody = () => ({
      service: "prepaid",
      operator_id: prepaid.id,
      circle_id: circle.id,
      plan_id: plan.id,
      recipient: "9876543210",
      amount: "299",
      mpin: "1234",
    });
    await t.test(
      "concurrent recharge retries reserve funds once and credit snapshotted commission",
      async () => {
        const requests = await Promise.all([
          call("POST", "/retailer/recharges", rechargeBody(), retailerToken, {
            "Idempotency-Key": "recharge-once",
          }),
          call("POST", "/retailer/recharges", rechargeBody(), retailerToken, {
            "Idempotency-Key": "recharge-once",
          }),
        ]);
        assert.deepEqual(requests.map((r) => r.status).sort(), [200, 202]);
        assert.equal(requests[0].data.id, requests[1].data.id);
        assert.equal(
          (await call("GET", "/retailer/wallet", undefined, retailerToken)).data
            .balance,
          "701.00",
        );
        assert.equal(
          (
            await call(
              "POST",
              "/retailer/recharges",
              {
                ...rechargeBody(),
                recipient: "9876543211",
              },
              retailerToken,
              {
                "Idempotency-Key": "recharge-once",
              },
            )
          ).status,
          409,
        );
        const transactionId = requests[0].data.id;
        const settled = await call(
          "POST",
          `/admin/transactions/${transactionId}/settle`,
          {
            status: "Successful",
            amount: 299,
            currency: "INR",
            reference: `${suffix}-recharge-1`,
            reason: "Verified external completion",
          },
          adminToken,
        );
        assert.equal(settled.status, 200, JSON.stringify(settled));
        assert.equal(settled.data.commission_amount, "8.97");
        assert.equal(
          (await call("GET", "/retailer/wallet", undefined, retailerToken)).data
            .balance,
          "709.97",
        );
        assert.equal(
          (
            await call(
              "POST",
              `/admin/transactions/${transactionId}/settle`,
              {
                status: "Failed",
                amount: 299,
                currency: "INR",
                reference: "different",
                reason: "Conflicting event",
              },
              adminToken,
            )
          ).status,
          409,
        );
        const events = await call(
          "GET",
          `/admin/transactions/${transactionId}/events`,
          undefined,
          adminToken,
        );
        assert.equal(events.data.length, 1);
      },
    );
    await t.test(
      "failed recharges refund once and low-balance failures leave no transaction",
      async () => {
        const created = await call(
          "POST",
          "/retailer/recharges",
          rechargeBody(),
          retailerToken,
          {
            "Idempotency-Key": "refund-once",
          },
        );
        assert.equal(created.status, 202);
        const body = {
          status: "Failed",
          amount: 299,
          currency: "INR",
          reference: `${suffix}-failed-1`,
          reason: "External recharge rejected",
        };
        assert.equal(
          (
            await call(
              "POST",
              `/admin/transactions/${created.data.id}/settle`,
              body,
              adminToken,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              "POST",
              `/admin/transactions/${created.data.id}/settle`,
              body,
              adminToken,
            )
          ).status,
          200,
        );
        assert.equal(
          (await call("GET", "/retailer/wallet", undefined, retailerToken)).data
            .balance,
          "709.97",
        );
        assert.equal(
          (
            await call(
              "POST",
              "/retailer/recharges",
              rechargeBody(),
              secondToken,
              {
                "Idempotency-Key": "no-funds",
              },
            )
          ).status,
          400,
        );
        const existing = await pool.query(
          `SELECT id FROM transactions WHERE retailer_id = $1 AND idempotency_key = 'no-funds'`,
          [otherRetailer.id],
        );
        assert.equal(existing.rowCount, 0);
      },
    );
    await t.test(
      "gift codes are encrypted and visible only to their owner after settlement",
      async () => {
        const created = await call(
          "POST",
          "/retailer/recharges",
          {
            service: "google-play",
            operator_id: gift.id,
            amount: 100,
            mpin: "1234",
          },
          retailerToken,
          {
            "Idempotency-Key": "gift-once",
          },
        );
        assert.equal(created.status, 202, JSON.stringify(created));
        assert.equal(created.data.category, "google-play");
        assert.equal(
          (
            await call(
              "GET",
              `/retailer/transactions/${created.data.id}/gift-code`,
              undefined,
              retailerToken,
            )
          ).status,
          404,
        );
        const settled = await call(
          "POST",
          `/admin/transactions/${created.data.id}/settle`,
          {
            status: "Successful",
            amount: 100,
            currency: "INR",
            reference: `${suffix}-gift-1`,
            reason: "Code obtained externally",
            gift_code: "TEST-ISSUED-CODE",
          },
          adminToken,
        );
        assert.equal(settled.status, 200, JSON.stringify(settled));
        const saved = await pool.query(
          `SELECT code_ciphertext FROM google_play_codes WHERE transaction_id = $1`,
          [created.data.id],
        );
        assert.ok(!saved.rows[0].code_ciphertext.includes("TEST-ISSUED-CODE"));
        assert.equal(
          (
            await call(
              "GET",
              `/retailer/transactions/${created.data.id}/gift-code`,
              undefined,
              retailerToken,
            )
          ).data.code,
          "TEST-ISSUED-CODE",
        );
        assert.equal(
          (
            await call(
              "GET",
              `/retailer/transactions/${created.data.id}/gift-code`,
              undefined,
              secondToken,
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      "profile changes validate the current password and hide identity numbers",
      async () => {
        assert.equal(
          (
            await call(
              "PATCH",
              "/retailer/profile",
              {
                name: "New name",
                current_password: "incorrect",
              },
              retailerToken,
            )
          ).status,
          401,
        );
        const changed = await call(
          "PATCH",
          "/retailer/profile",
          {
            name: "New name",
            current_password: "Password123!",
          },
          retailerToken,
        );
        assert.equal(changed.status, 200);
        assert.equal(changed.data.name, "New name");
        assert.equal(changed.data.adhar, undefined);
      },
    );
    await t.test(
      "OTP attempts persist; verified email changes bind destination and cannot replay",
      async () => {
        const nextEmail = `${suffix}-changed@example.com`;
        const request = await call(
          "POST",
          "/retailer/security/otp/request",
          {
            purpose: "email_change",
            email: nextEmail,
            current_password: "Password123!",
          },
          retailerToken,
        );
        assert.equal(request.status, 200, JSON.stringify(request));
        assert.equal(request.data.otp, undefined);
        const challengeId = request.data.challenge_id;
        const bad = await call(
          "POST",
          "/retailer/security/otp/verify",
          {
            challenge_id: challengeId,
            otp: "000000",
          },
          retailerToken,
        );
        assert.equal(bad.status, 400);
        assert.equal(
          (
            await pool.query(
              `SELECT attempts FROM retailer_verifications WHERE id = $1`,
              [challengeId],
            )
          ).rows[0].attempts,
          1,
        );
        const verified = await call(
          "POST",
          "/retailer/security/otp/verify",
          {
            challenge_id: challengeId,
            otp: deliveries.get(nextEmail),
          },
          retailerToken,
        );
        assert.equal(verified.status, 200, JSON.stringify(verified));
        const proof = {
          verification_token: verified.data.verification_token,
        };
        assert.equal(
          (
            await call(
              "POST",
              "/retailer/security/mpin/reset",
              {
                ...proof,
                new_mpin: "4321",
              },
              retailerToken,
            )
          ).status,
          403,
        );
        const completed = await call(
          "POST",
          "/retailer/security/email",
          {
            ...proof,
            email: "attacker@example.com",
          },
          retailerToken,
        );
        assert.equal(completed.status, 200);
        assert.equal(
          (await call("GET", "/retailer/profile", undefined, retailerToken))
            .data.email,
          nextEmail,
        );
        assert.equal(
          (await call("POST", "/retailer/security/email", proof, retailerToken))
            .status,
          401,
        );
      },
    );
    await t.test(
      "password reset revokes sessions; refresh rotates and logout invalidates access",
      async () => {
        await pool.query(
          `UPDATE retailer_verifications SET created_at = created_at - INTERVAL '2 minutes' WHERE retailer_id = $1`,
          [retailer.id],
        );
        const requested = await call(
          "POST",
          "/retailer/password-reset/request",
          {
            phone: retailerInput.phone,
          },
        );
        assert.equal(requested.status, 200, JSON.stringify(requested));
        const verified = await call("POST", "/retailer/password-reset/verify", {
          challenge_id: requested.data.challenge_id,
          otp: deliveries.get(retailerInput.phone),
        });
        assert.equal(verified.status, 200);
        assert.equal(
          (
            await call("POST", "/retailer/password-reset/complete", {
              verification_token: verified.data.verification_token,
              new_password: "NewPassword123!",
            })
          ).status,
          200,
        );
        assert.equal(
          (await call("GET", "/retailer/profile", undefined, retailerToken))
            .status,
          401,
        );
        const login = await call("POST", "/retailer/login", {
          phone: retailerInput.phone,
          password: "NewPassword123!",
        });
        assert.equal(login.status, 200);
        const refreshed = await call("POST", "/retailer/refresh", {
          refresh_token: login.data.refresh_token,
        });
        assert.equal(refreshed.status, 200);
        assert.equal(
          (
            await call("POST", "/retailer/refresh", {
              refresh_token: login.data.refresh_token,
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await call(
              "GET",
              "/retailer/profile",
              undefined,
              login.data.access_token,
            )
          ).status,
          401,
        );
        assert.equal(
          (
            await call(
              "POST",
              "/retailer/logout",
              {},
              refreshed.data.access_token,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await call(
              "GET",
              "/retailer/profile",
              undefined,
              refreshed.data.access_token,
            )
          ).status,
          401,
        );
      },
    );
    await t.test(
      "M-PIN lockout blocks guessing and password setup/change revokes sessions",
      async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const result = await call(
            "POST",
            "/retailer/recharges",
            {
              ...rechargeBody(),
              mpin: "0000",
            },
            secondToken,
            {
              "Idempotency-Key": `bad-mpin-${attempt}`,
            },
          );
          assert.equal(result.status, 401);
        }
        const locked = await call(
          "POST",
          "/retailer/recharges",
          rechargeBody(),
          secondToken,
          {
            "Idempotency-Key": "locked-mpin",
          },
        );
        assert.equal(locked.status, 401);
        assert.match(locked.msg, /locked/);
        await pool.query(
          `UPDATE retailers SET failed_mpin_attempts = 0, mpin_locked_until = NULL WHERE id = $1`,
          [otherRetailer.id],
        );
        const changed = await call(
          "POST",
          "/retailer/security/mpin",
          {
            current_mpin: "1234",
            new_mpin: "4321",
          },
          secondToken,
        );
        assert.equal(changed.status, 200, JSON.stringify(changed));
        assert.equal(
          (await call("GET", "/retailer/profile", undefined, secondToken))
            .status,
          401,
        );
        secondToken = (await call("POST", "/retailer/login", otherInput)).data
          .access_token;
      },
    );
    await t.test(
      "OTP lockout and expiry are enforced without exposing OTPs",
      async () => {
        const requested = await call(
          "POST",
          "/retailer/security/otp/request",
          {
            purpose: "mpin_reset",
            current_password: "Password123!",
          },
          secondToken,
        );
        assert.equal(requested.status, 200);
        const challengeId = requested.data.challenge_id;
        for (let attempt = 0; attempt < 5; attempt++) {
          assert.equal(
            (
              await call(
                "POST",
                "/retailer/security/otp/verify",
                {
                  challenge_id: challengeId,
                  otp: "000000",
                },
                secondToken,
              )
            ).status,
            400,
          );
        }
        assert.equal(
          (
            await call(
              "POST",
              "/retailer/security/otp/verify",
              {
                challenge_id: challengeId,
                otp: deliveries.get(otherInput.phone),
              },
              secondToken,
            )
          ).status,
          400,
        );
        await pool.query(
          `UPDATE retailer_verifications SET created_at = created_at - INTERVAL '10 minutes', expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
          [challengeId],
        );
        const next = await call(
          "POST",
          "/retailer/security/otp/request",
          {
            purpose: "mpin_reset",
            current_password: "Password123!",
          },
          secondToken,
        );
        assert.equal(next.status, 200);
        const verified = await call(
          "POST",
          "/retailer/security/otp/verify",
          {
            challenge_id: next.data.challenge_id,
            otp: deliveries.get(otherInput.phone),
          },
          secondToken,
        );
        assert.equal(verified.status, 200);
        await pool.query(
          `UPDATE retailer_verifications SET created_at = created_at - INTERVAL '10 minutes', expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
          [next.data.challenge_id],
        );
        assert.equal(
          (
            await call(
              "POST",
              "/retailer/security/mpin/reset",
              {
                verification_token: verified.data.verification_token,
                new_mpin: "1111",
              },
              secondToken,
            )
          ).status,
          401,
        );
      },
    );
    await t.test(
      "login lockout persists and staff password changes revoke old tokens",
      async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
          assert.equal(
            (
              await call("POST", "/retailer/login", {
                phone: otherInput.phone,
                password: "WrongPassword!",
              })
            ).status,
            401,
          );
        }
        const locked = await call("POST", "/retailer/login", otherInput);
        assert.equal(locked.status, 401);
        assert.match(locked.msg, /locked/);
        assert.equal(
          (
            await call(
              "POST",
              "/admin/password",
              {
                current_password: "Password123!",
                new_password: "AdminNewPassword123!",
              },
              adminToken,
            )
          ).status,
          200,
        );
        assert.equal(
          (await call("GET", "/admin/profile", undefined, adminToken)).status,
          401,
        );
        const login = await call("POST", "/admin/login", {
          phone: adminPhone,
          password: "AdminNewPassword123!",
        });
        assert.equal(login.status, 200);
        adminToken = login.data.access_token;
      },
    );
    await t.test(
      "invalid JSON, bad UUIDs and skipped provider endpoints return structured errors",
      async () => {
        assert.equal(
          (
            await call(
              "GET",
              "/admin/transactions?retailer_id=bad",
              undefined,
              adminToken,
            )
          ).status,
          400,
        );
        assert.equal(
          (await call("POST", "/retailer/dth/lookup", {}, secondToken)).status,
          503,
        );
        const malformed = await fetch(`${base}/api/admin/login`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: "{",
        });
        assert.equal(malformed.status, 400);
        assert.equal((await malformed.json()).success, false);
      },
    );
    await t.test("development providers settle wallet/recharge requests and return real OTP challenges", async () => {
      process.env.DEMO_MODE = "true";
      const config=await call("GET","/retailer/config");assert.equal(config.data.demo,true);
      const topup=await call("POST","/retailer/wallet/topups",{amount:"1000.00"},secondToken,{"Idempotency-Key":"demo-topup"});
      assert.equal(topup.status,202);assert.equal(topup.data.status,"Successful");assert.equal(topup.data.provider,"demo-provider");
      const repeated=await call("POST","/retailer/wallet/topups",{amount:"1000.00"},secondToken,{"Idempotency-Key":"demo-topup"});assert.equal(repeated.data.id,topup.data.id);
      const recharge=await call("POST","/retailer/recharges",{service:"prepaid",operator:"jio",circle:"West Bengal",plan_code:"pop-299",amount:"299.00",recipient:"9876543210",mpin:"4321"},secondToken,{"Idempotency-Key":"demo-recharge"});
      assert.equal(recharge.status,202,JSON.stringify(recharge));assert.equal(recharge.data.status,"Successful");
      assert.equal((await call("GET","/retailer/wallet",undefined,secondToken)).data.balance,"708.18");
      const code=await call("POST","/retailer/recharges",{service:"google-play",operator:"google-play",amount:"100.00",mpin:"4321"},secondToken,{"Idempotency-Key":"demo-gift"});
      assert.equal(code.data.status,"Successful",JSON.stringify(code));assert.match((await call("GET",`/retailer/transactions/${code.data.id}/gift-code`,undefined,secondToken)).data.code,/^DEMO-/);
      const lookup=await call("POST","/retailer/dth/lookup",{operator:"airtel-dth",subscriber:"3012345678"},secondToken);assert.equal(lookup.status,200);assert.equal(lookup.data.demo,true);
      await pool.query(`UPDATE retailer_verifications SET created_at = created_at - INTERVAL '2 minutes' WHERE retailer_id=$1`,[otherRetailer.id]);
      const challenge=await call("POST","/retailer/security/otp/request",{purpose:"phone_verify",current_password:"Password123!"},secondToken);
      assert.equal(challenge.status,200,JSON.stringify(challenge));assert.equal(challenge.data.demo_otp,"123456");
      const proof=await call("POST","/retailer/security/otp/verify",{challenge_id:challenge.data.challenge_id,otp:"123456"},secondToken);assert.equal(proof.status,200);
      assert.equal((await call("POST","/retailer/security/phone",{verification_token:proof.data.verification_token},secondToken)).status,200);
      process.env.NODE_ENV="production";
      assert.equal((await call("GET","/retailer/config")).data.demo,false);
      const pending=await call("POST","/retailer/wallet/topups",{amount:"100.00"},secondToken,{"Idempotency-Key":"production-topup"});assert.equal(pending.data.status,"Pending");
      assert.equal((await call("GET","/retailer/wallet",undefined,secondToken)).data.balance,"608.18");
      delete process.env.NODE_ENV;delete process.env.DEMO_MODE;
    });

    await t.test("SMEPay verifies payments, rejects forged callbacks and credits exactly once", async () => {
      const saved = {...process.env}; const original = smepay.request;
      Object.assign(process.env,{PAYMENT_GATEWAY:"smepay",SMEPAY_ENVIRONMENT:"test",SMEPAY_CLIENT_ID:"test-client",SMEPAY_CLIENT_SECRET:"test-secret",SMEPAY_CALLBACK_URL:"https://example.com/api/retailer/payments/smepay/webhook",SMEPAY_VALIDATE_PATH:"/api/external/order/validate",DEMO_MODE:"true"});
      let reference, createCount=0, initiateCount=0, state="PENDING", valid=true, gatewayAmount="100.50";
      smepay.request=async(path,body)=>{
        if(path.endsWith("/create")){createCount++;reference=body.order_id;assert.equal(body.amount,"100.50");return {status:true,order_id:`INT-${reference}`,order_slug:`slug-${reference}`};}
        if(path.endsWith("/initiate")){initiateCount++;return {status:true,payment_link:"upi://pay?pa=test@example",qr_code:"data:image/png;base64,AA==",payment_status:"INITIATED",expires_at:Math.floor(Date.now()/1000)+300};}
        if(path.endsWith("/status"))return {payment_status:state,amount:gatewayAmount,order_id:`INT-${reference}`,external_reference_id:reference};
        if(path.endsWith("/validate"))return {status:true,valid,payment_status:"TEST_SUCCESS"};
        throw Error("Unexpected API");
      };
      try {
        const before=(await call("GET","/retailer/wallet",undefined,secondToken)).data.balance;
        const create=()=>call("POST","/retailer/wallet/topups",{amount:"100.50"},secondToken,{"Idempotency-Key":"smepay-topup"});
        const [a,b]=await Promise.all([create(),create()]);assert.equal(a.status,202,JSON.stringify(a));assert.equal(b.data.id,a.data.id);assert.equal(createCount,1);assert.equal(initiateCount,1);assert.equal(a.data.status,"Pending");assert.equal(a.data.checkout.environment,"test");
        const path=`/retailer/wallet/topups/${a.data.id}`;
        process.env.PAYMENT_GATEWAY="";
        const disabledRetry=await create();assert.equal(disabledRetry.data.status,"Pending");assert.equal(disabledRetry.demo,undefined);
        process.env.PAYMENT_GATEWAY="smepay";
        const {loginRetailer}=await import("./controllers/retailer/authController.js");
        let ownerLogin; await loginRetailer({body:{phone:retailerInput.phone,password:"NewPassword123!"}}, {status(){return this;},json(body){ownerLogin=body;return this;}});
        assert.equal(ownerLogin.success,true);
        assert.equal((await call("GET",`${path}/checkout`,undefined,ownerLogin.data.access_token)).status,404);
        assert.equal((await call("POST",`${path}/status`,{},secondToken)).data.status,"Pending");
        assert.equal((await call("POST","/retailer/payments/smepay/webhook",{ref_id:a.data.id,status:"SUCCESS",amount:"100.50"})).status,200);
        assert.equal((await call("GET","/retailer/wallet",undefined,secondToken)).data.balance,before);
        state="TEST_SUCCESS";valid=false;
        assert.equal((await call("POST",`${path}/status`,{},secondToken)).status,502);
        valid=true;gatewayAmount="999.00";
        assert.equal((await call("POST",`${path}/status`,{},secondToken)).status,502);
        gatewayAmount="100.50";
        const paid=await call("POST",`${path}/status`,{},secondToken);assert.equal(paid.data.status,"Successful",JSON.stringify(paid));
        assert.equal((await call("POST","/retailer/payments/smepay/webhook",{ref_id:a.data.id})).status,200);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM wallet_entries WHERE transaction_id=$1 AND kind='topup'",[a.data.id])).rows[0].count,1);
        const events=await pool.query("SELECT payload FROM provider_events WHERE transaction_id=$1",[a.data.id]);assert.equal(events.rows[0].payload.demo,undefined);
        process.env.NODE_ENV="production";
        assert.equal((await create()).status,503);
      } finally {
        smepay.request=original;
        for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];
        Object.assign(process.env,saved);
      }
    });

    await t.test("MRobotics submits once, reconciles timeouts and refunds only confirmed failures", async () => {
      // A separate loopback client keeps this scenario independent of earlier rate-limit buckets.
      const providerCall=(method,path,body,token,headers={})=>new Promise((resolve,reject)=>{
        const req=httpRequest(`${base}/api${path}`,{method,localAddress:"127.0.0.2",headers:{"content-type":"application/json",...(token?{authorization:`Bearer ${token}`} : {}),...headers}},response=>{
          let text="";response.on("data",chunk=>text+=chunk);response.on("end",()=>{try{resolve({status:response.statusCode,...JSON.parse(text)});}catch(error){reject(error);}});
        });req.on("error",reject);req.end(body===undefined?undefined:JSON.stringify(body));
      });
      const saved={...process.env};const originalSubmit=mrobotics.submit,originalStatus=mrobotics.status;
      Object.assign(process.env,{RECHARGE_PROVIDER:"mrobotics",MROBOTICS_API_TOKEN:"test-only-token",MROBOTICS_COMPANY_IDS:JSON.stringify({jio:5,"tata-play":7}),DEMO_MODE:"true"});
      let submissions=0,checks=0,mode="pending",lastPayload;
      const records=new Map();
      const reply=(payload,status)=>({status,id:`MR${payload.order_id}`,mobile_no:payload.mobile_no,amount:Number(payload.amount),tnx_id:`OP${payload.order_id}`,order_id:payload.order_id});
      mrobotics.submit=async payload=>{submissions++;lastPayload=payload;records.set(String(payload.order_id),payload);if(mode==="timeout")throw Object.assign(Error("timeout"),{status:503});return reply(payload,mode);};
      mrobotics.status=async order=>{checks++;return reply(records.get(String(order)),mode==="timeout"?"pending":mode);};
      try {
        const operator=(await pool.query("SELECT id FROM service_operators WHERE code='jio'")).rows[0].id;
        const circle=(await pool.query("SELECT id FROM telecom_circles WHERE code='west-bengal'")).rows[0].id;
        const plan=(await pool.query("INSERT INTO recharge_plans(operator_id,circle_id,code,name,category,amount,mrobotics_is_stv) VALUES($1,$2,'mr-test','MRobotics test','popular',100,true) RETURNING id",[operator,circle])).rows[0].id;
        const body={service:"prepaid",operator:"jio",circle:"West Bengal",plan_id:plan,amount:"100.00",recipient:"9876543210",mpin:"4321"};
        const listed=await providerCall("GET",`/retailer/plans?operator_id=${operator}&circle_id=${circle}&limit=100`,undefined,secondToken);
        assert.deepEqual(listed.data.map(item=>item.id),[plan]);
        const availableOperators=await providerCall("GET","/retailer/operators",undefined,secondToken);
        assert.deepEqual(availableOperators.data.map(item=>item.code).sort(),["jio","tata-play"]);
        const unconfigured=(await pool.query("INSERT INTO recharge_plans(operator_id,circle_id,code,name,category,amount) VALUES($1,$2,'mr-unconfigured','Unconfigured','popular',100) RETURNING id",[operator,circle])).rows[0].id;
        const invalid=await providerCall("POST","/retailer/recharges",{...body,plan_id:unconfigured},secondToken,{"Idempotency-Key":"mr-invalid-plan"});assert.equal(invalid.status,503);assert.equal(submissions,0);

        const create=key=>providerCall("POST","/retailer/recharges",body,secondToken,{"Idempotency-Key":key});
        const wallet=async()=>Number((await providerCall("GET","/retailer/wallet",undefined,secondToken)).data.balance);
        const before=await wallet();
        const [a,b]=await Promise.all([create("mr-pending"),create("mr-pending")]);
        assert.deepEqual([a.status,b.status].sort(),[200,202],JSON.stringify([a,b]));assert.equal(a.data.id,b.data.id);assert.equal(submissions,1);assert.equal(a.data.status,"Pending");assert.equal(await wallet(),before-100);
        assert.equal(lastPayload.company_id,"5");assert.equal(lastPayload.is_stv,"true");assert.equal(lastPayload.mobile_no,body.recipient);
        assert.equal((await providerCall("GET","/retailer/config")).data.mock_recharge,false);
        const check=id=>providerCall("POST",`/retailer/recharges/${id}/status`,{},secondToken);
        const age=id=>pool.query("UPDATE recharge_submissions SET last_checked_at=NOW()-INTERVAL '20 seconds' WHERE transaction_id=$1",[id]);
        const {loginRetailer}=await import("./controllers/retailer/authController.js");let outsider;
        await loginRetailer({body:{phone:retailerInput.phone,password:"NewPassword123!"}},{status(){return this;},json(data){outsider=data;return this;}});
        assert.equal((await providerCall("POST",`/retailer/recharges/${a.data.id}/status`,{},outsider.data.access_token)).status,404);
        mode="success";await age(a.data.id);assert.equal((await check(a.data.id)).data.status,"Successful");await check(a.data.id);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM wallet_entries WHERE transaction_id=$1 AND kind='recharge'",[a.data.id])).rows[0].n,1);
        const settledBalance=await wallet();
        mode="failure";const failed=await create("mr-failure");assert.equal(failed.data.status,"Failed",JSON.stringify(failed));await check(failed.data.id);assert.equal(await wallet(),settledBalance);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM wallet_entries WHERE transaction_id=$1 AND kind='refund'",[failed.data.id])).rows[0].n,1);
        mode="timeout";const uncertain=await create("mr-timeout");assert.equal(uncertain.data.status,"Pending");assert.ok(uncertain.data.provider_message);const count=submissions;
        await create("mr-timeout");assert.equal(submissions,count);
        mode="success";await pool.query("UPDATE recharge_submissions SET last_checked_at=NOW()-INTERVAL '40 seconds' WHERE transaction_id=$1",[uncertain.data.id]);
        const {reconcilePendingRecharges}=await import("./controllers/retailer/mroboticsController.js");
        const beforeStoppedSweep=checks;assert.equal(await reconcilePendingRecharges({shouldStop:()=>true}),0);assert.equal(checks,beforeStoppedSweep);
        assert.ok(await reconcilePendingRecharges()>=1);assert.equal((await check(uncertain.data.id)).data.status,"Successful");assert.equal(submissions,count);
        mode="success";
        const dth=await providerCall("POST","/retailer/recharges",{service:"dth",operator:"tata-play",recipient:"1001234567",amount:"100.00",mpin:"4321"},secondToken,{"Idempotency-Key":"mr-dth"});
        assert.equal(dth.data.status,"Successful",JSON.stringify(dth));assert.equal(lastPayload.company_id,"7");assert.equal(lastPayload.is_stv,"false");
        mode="pending";const old=await create("mr-old");const countAfterOld=submissions;await pool.query("UPDATE recharge_submissions SET attempted_at=NOW()-INTERVAL '2 days' WHERE transaction_id=$1",[old.data.id]);const previousChecks=checks;
        const dated=await check(old.data.id);assert.equal(dated.data.status,"Pending");assert.match(dated.data.provider_message,/today/);assert.equal(checks,previousChecks);
        process.env.RECHARGE_PROVIDER="";const disabled=await create("mr-old");assert.equal(disabled.data.status,"Pending");assert.equal(submissions,countAfterOld);
        process.env.RECHARGE_PROVIDER="mrobotics";
        const {submit}=mrobotics;mrobotics.submit=async payload=>({...reply(payload,"success"),amount:999});const mismatch=await create("mr-mismatch");assert.equal(mismatch.data.status,"Pending");assert.match(mismatch.data.provider_message,/match/);mrobotics.submit=submit;
        const debits=await pool.query("SELECT kind FROM wallet_entries WHERE transaction_id=$1",[mismatch.data.id]);assert.deepEqual(debits.rows.map(r=>r.kind),["recharge"]);
        delete process.env.MROBOTICS_API_TOKEN;assert.equal((await create("mr-no-config")).status,503);
      } finally {
        mrobotics.submit=originalSubmit;mrobotics.status=originalStatus;
        for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);
      }
    });

  },
);
