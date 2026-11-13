import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { billingService, verifyBillingWebhook } from "../server/billing.mjs";
import { fixture } from "./helpers.mjs";

const env = {
  ROCKET_DASHBOARD_URL: "https://rocket1000.example",
  PAYSTACK_SECRET_KEY: "sk_test_fixture",
  ROCKET_PAYSTACK_PLANS: JSON.stringify([
    {
      id: "monthly",
      name: "Monthly",
      amount: 19900,
      code: "PLN_fixture",
      aiMonthlyBudgetUsd: 2,
    },
  ]),
};
const owner = { workspaceId: "alice", userId: "alice" };
const other = { workspaceId: "bob", userId: "bob" };
const email = "fixture@example.test";
const customer = { id: 4, customer_code: "CUS_fixture", email };
const plan = {
  id: 5,
  domain: "test",
  plan_code: "PLN_fixture",
  currency: "ZAR",
  interval: "monthly",
  amount: 19900,
};
const authorization = { authorization_code: "AUTH_fixture" };
const sign = (key, data) =>
  createHmac("sha512", key).update(data).digest("hex");

test("a signed, independently verified sandbox payment activates only its owner, deduplicates renewals, and expires after cancellation", async () => {
  const f = await fixture();
  let reference,
    paidAt = f.now(),
    state = "active",
    paymentAmount = 19900;
  let initializes = 0;
  const subscription = () => ({
    domain: "test",
    subscription_code: "SUB_fixture",
    amount: 19900,
    status: state,
    customer,
    plan,
    authorization,
    email_token: "fixture",
    createdAt: new Date(paidAt).toISOString(),
    next_payment_date: new Date(paidAt + 28 * 86400000).toISOString(),
  });
  const billing = billingService(f.db, {
    env,
    now: f.now,
    fetcher: async (url, options) => {
      const path = new URL(url).pathname;
      let data;
      if (path.startsWith("/plan/")) data = plan;
      else if (path === "/transaction/initialize") {
        initializes++;
        const body = JSON.parse(options.body);
        reference = body.reference;
        assert.equal(body.currency, "ZAR");
        data = {
          reference,
          authorization_url: "https://checkout.paystack.com/fixture",
        };
      } else if (path.startsWith("/transaction/verify/")) {
        data = {
          domain: "test",
          status: "success",
          reference: path.split("/").at(-1),
          currency: "ZAR",
          amount: paymentAmount,
          customer,
          authorization,
          plan_object: plan,
          paid_at: new Date(paidAt).toISOString(),
        };
      } else if (path === "/subscription") data = [subscription()];
      else if (path === "/subscription/SUB_fixture") data = subscription();
      else if (path === "/subscription/disable") {
        state = "non-renewing";
        data = {};
      } else throw Error("Unexpected sandbox fixture route");
      return Response.json({ status: true, data });
    },
  });
  async function webhook(event, data, key = env.PAYSTACK_SECRET_KEY) {
    const body = Buffer.from(
      JSON.stringify({ event, data: { domain: "test", ...data } }),
    );
    return billing.webhook(
      body,
      new Headers({ "x-paystack-signature": sign(key, body) }),
    );
  }
  try {
    const checkout = await billing.checkout(owner, {
      planId: "monthly",
      email,
    });
    assert.equal(
      (await billing.checkout(owner, { planId: "monthly", email })).reference,
      checkout.reference,
    );
    assert.equal(initializes, 1);
    assert.equal((await billing.status(owner)).entitlement.allowed, false);
    await assert.rejects(billing.verify(other, reference), {
      code: "BILLING_REFERENCE_NOT_FOUND",
    });
    await assert.rejects(webhook("charge.success", { reference }, "wrong"), {
      code: "BILLING_SIGNATURE_INVALID",
    });
    paymentAmount = 100;
    await assert.rejects(webhook("charge.success", { reference }), {
      code: "BILLING_VERIFICATION_FAILED",
    });
    paymentAmount = 19900;
    await webhook("charge.success", { reference });
    await webhook("charge.success", { reference });
    assert.equal((await billing.status(owner)).entitlement.allowed, true);
    assert.equal((await billing.status(other)).entitlement.allowed, false);
    f.advance(28 * 86400000);
    paidAt = f.now();
    const renewal = {
      status: "success",
      paid: true,
      customer,
      subscription: subscription(),
      transaction: { reference: "renewal-1" },
    };
    await webhook("invoice.update", renewal);
    await webhook("invoice.update", renewal);
    const active = await billing.status(owner);
    assert.deepEqual(
      active.history.map((event) => event.type),
      ["renewal", "initial_payment"],
    );
    const cancelled = await billing.cancel(owner);
    assert.equal(cancelled.subscription.state, "non-renewing");
    assert.equal(cancelled.entitlement.allowed, true);
    f.advance(33 * 86400000);
    assert.equal((await billing.status(owner)).entitlement.allowed, false);
  } finally {
    await f.db.close();
  }
});

test("timestamped Paystack signatures bind the raw body and reject a stale delivery", () => {
  const now = () => 1800000000000;
  const time = String(now() / 1000);
  const secret = "whsec_fixture";
  const body = Buffer.from('{"event":"test"}');
  const signature = sign(
    secret,
    Buffer.concat([Buffer.from(time + "."), body]),
  );
  const headers = new Headers({
    "paystack-signature": `t=${time},v1=whk_fixture:${signature}`,
  });
  const config = { PAYSTACK_WEBHOOK_SECRET: secret };
  assert.equal(verifyBillingWebhook(body, headers, config, now), true);
  assert.equal(
    verifyBillingWebhook(Buffer.from("changed"), headers, config, now),
    false,
  );
  assert.equal(
    verifyBillingWebhook(body, headers, config, () => now() + 301000),
    false,
  );
});
