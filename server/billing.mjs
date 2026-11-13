import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.mjs";

export const billingSchema = [
  `CREATE TABLE IF NOT EXISTS rocket_billing_checkouts (
    reference TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    email TEXT NOT NULL, plan_id TEXT NOT NULL, plan_name TEXT NOT NULL,
    plan_code TEXT NOT NULL, amount INTEGER NOT NULL, allowance BIGINT NOT NULL,
    checkout_url TEXT, state TEXT NOT NULL, created_at BIGINT NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS rocket_billing_checkouts_workspace
    ON rocket_billing_checkouts(workspace_id,created_at)`,
  `CREATE TABLE IF NOT EXISTS rocket_billing_subscriptions (
    code TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
    checkout_ref TEXT NOT NULL UNIQUE, customer_code TEXT NOT NULL,
    state TEXT NOT NULL, changed_at BIGINT NOT NULL,
    period_start BIGINT NOT NULL, expires_at BIGINT NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY(checkout_ref) REFERENCES rocket_billing_checkouts(reference) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS rocket_billing_subscriptions_workspace
    ON rocket_billing_subscriptions(workspace_id,expires_at)`,
  `CREATE TABLE IF NOT EXISTS rocket_billing_history (
    event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subscription_code TEXT NOT NULL,
    event_type TEXT NOT NULL, amount INTEGER NOT NULL, occurred_at BIGINT NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES rocket_workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY(subscription_code) REFERENCES rocket_billing_subscriptions(code) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS rocket_billing_history_workspace
    ON rocket_billing_history(workspace_id,occurred_at)`,
];

const DAY = 86_400_000;
const API_ORIGIN = "https://api.paystack.co";
const CHECKOUT_ORIGIN = "https://checkout.paystack.com";
const PROVIDER_TIMEOUT_MS = 4_000;
const REQUEST_LOCK_MS = 15_000;
const planCode = /^PLN_[A-Za-z0-9]{1,80}$/;
const customerCode = /^CUS_[A-Za-z0-9]{1,80}$/;
const subscriptionCode = /^SUB_[A-Za-z0-9]{1,80}$/;
const transactionRef = /^[A-Za-z0-9.=-]{1,128}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const endedStates = ["cancelled", "completed"];
const waitingStates = ["initializing", "pending"];

function unavailable(message = "Paystack sandbox billing is not configured.") {
  return new ApiError(503, message, "BILLING_UNAVAILABLE");
}

function validResponse(condition) {
  if (!condition)
    throw new ApiError(
      502,
      "Paystack could not verify this subscription or payment.",
      "BILLING_VERIFICATION_FAILED",
    );
}

function selectPlans(env) {
  if (!env.ROCKET_PAYSTACK_PLANS) return [];
  let plans;
  try {
    plans = JSON.parse(env.ROCKET_PAYSTACK_PLANS);
  } catch {
    throw unavailable("Paystack subscription plans are misconfigured.");
  }
  if (!Array.isArray(plans) || plans.length > 20)
    throw unavailable("Paystack subscription plans are misconfigured.");
  const ids = new Set();
  const codes = new Set();
  return plans.map((p) => {
    const allowance = Math.round(p?.aiMonthlyBudgetUsd * 1_000_000);
    if (
      typeof p?.id !== "string" ||
      !/^[a-z0-9-]{1,40}$/.test(p.id) ||
      typeof p.name !== "string" ||
      !p.name.trim() ||
      p.name.length > 60 ||
      typeof p.code !== "string" ||
      !planCode.test(p.code) ||
      !Number.isInteger(p.amount) ||
      p.amount < 100 ||
      p.amount > 100_000_000 ||
      typeof p.aiMonthlyBudgetUsd !== "number" ||
      !Number.isSafeInteger(allowance) ||
      allowance < 1 ||
      ids.has(p.id) ||
      codes.has(p.code)
    )
      throw unavailable("Paystack subscription plans are misconfigured.");
    ids.add(p.id);
    codes.add(p.code);
    return {
      id: p.id,
      name: p.name.trim(),
      code: p.code,
      amount: p.amount,
      allowance,
    };
  });
}

function sandboxKey(env) {
  return /^sk_test_[A-Za-z0-9]+$/.test(env.PAYSTACK_SECRET_KEY || "")
    ? env.PAYSTACK_SECRET_KEY
    : null;
}

function checkoutCallback(env) {
  try {
    const url = new URL(env.ROCKET_DASHBOARD_URL);
    if (
      url.protocol !== "https:" ||
      url.origin !== url.href.replace(/\/$/, "") ||
      url.username ||
      url.password
    )
      return null;
    return new URL("/billing", url).href;
  } catch {
    return null;
  }
}

function checkoutAddress(value) {
  try {
    const url = new URL(value);
    validResponse(
      url.origin === CHECKOUT_ORIGIN &&
        !url.username &&
        !url.password &&
        /^\/[A-Za-z0-9]+$/.test(url.pathname) &&
        !url.search &&
        !url.hash,
    );
    return url.href;
  } catch {
    validResponse(false);
  }
}

function timestamp(value) {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

function providerState(state) {
  return ["active", "non-renewing", "attention", ...endedStates].includes(state)
    ? state
    : state === "complete"
      ? "completed"
      : null;
}

function validSubscription(subscription, payment, checkout, code) {
  return (
    subscription?.domain === "test" &&
    subscriptionCode.test(subscription.subscription_code || "") &&
    (!code || code === subscription.subscription_code) &&
    subscription.customer?.customer_code === payment.customer.customer_code &&
    subscription.customer?.email?.toLowerCase() === checkout.email &&
    subscription.plan?.plan_code === checkout.plan_code &&
    subscription.plan?.currency === "ZAR" &&
    subscription.plan?.interval === "monthly" &&
    subscription.amount === Number(checkout.amount) &&
    providerState(subscription.status)
  );
}

function endOfPaidPeriod(paidAt, nextBilling) {
  const paid = new Date(paidAt);
  const monthBoundary = Date.UTC(
    paid.getUTCFullYear(),
    paid.getUTCMonth() + 1,
    Math.min(paid.getUTCDate(), 28),
    paid.getUTCHours(),
    paid.getUTCMinutes(),
    paid.getUTCSeconds(),
  );
  const next = timestamp(nextBilling);
  // Accept a plausible provider billing time. An old event cannot use a next
  // invoice date several billing cycles ahead to extend the paid window.
  return next > paidAt && next <= paidAt + 32 * DAY ? next : monthBoundary;
}

async function lockWorkspace(tx, workspaceId) {
  const [row] = await tx.query(
    `SELECT id FROM rocket_workspaces WHERE id=?${tx.kind === "postgres" ? " FOR UPDATE" : ""}`,
    [workspaceId],
  );
  if (!row)
    throw new ApiError(
      404,
      "Billing workspace unavailable.",
      "BILLING_WORKSPACE_MISSING",
    );
}

async function currentEntitlement(tx, workspaceId, now) {
  const [subscription] = await tx.query(
    `SELECT s.period_start,s.expires_at,c.allowance
     FROM rocket_billing_subscriptions s JOIN rocket_billing_checkouts c ON c.reference=s.checkout_ref
     WHERE s.workspace_id=? AND s.expires_at>? ORDER BY s.expires_at DESC LIMIT 1`,
    [workspaceId, now()],
  );
  if (!subscription)
    return {
      allowed: false,
      allowanceMicrousd: null,
      periodStart: null,
      expiresAt: null,
      reason:
        "A current subscription is required for new AI analysis and entries.",
    };
  return {
    allowed: true,
    allowanceMicrousd: Number(subscription.allowance),
    periodStart: Number(subscription.period_start),
    expiresAt: Number(subscription.expires_at),
    reason: null,
  };
}

export async function billingEntitlement(
  tx,
  workspaceId,
  { env = process.env, now = Date.now } = {},
) {
  const [owner] =
    env.ROCKET_SUBSCRIPTIONS_REQUIRED === "1" && env.ROCKET_OWNER_USER_ID
      ? await tx.query(
          "SELECT id FROM rocket_users WHERE id=? AND workspace_id=?",
          [env.ROCKET_OWNER_USER_ID, workspaceId],
        )
      : [];
  if (env.ROCKET_SUBSCRIPTIONS_REQUIRED !== "1" || owner) {
    return {
      allowed: true,
      allowanceMicrousd: null,
      periodStart: null,
      expiresAt: null,
      reason: null,
    };
  }
  return currentEntitlement(tx, workspaceId, now);
}

export async function billingAdminSummary(db, { now = Date.now } = {}) {
  const [counts] = await db.query(
    `SELECT COUNT(DISTINCT CASE WHEN expires_at>? THEN workspace_id END) AS active,
      COUNT(DISTINCT workspace_id) AS subscribers
     FROM rocket_billing_subscriptions`,
    [now()],
  );
  const [payments] = await db.query(
    `SELECT COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount
      FROM rocket_billing_history WHERE event_type IN ('initial_payment','renewal')`,
  );
  return {
    sandbox: true,
    active: Number(counts.active),
    subscribers: Number(counts.subscribers),
    successfulPayments: Number(payments.count),
    paidAmountCents: Number(payments.amount),
  };
}

export function assertBillingAccount(session, workspaceId) {
  if (
    session?.kind !== "account" ||
    !session.userId ||
    session.id !== workspaceId
  )
    throw new ApiError(
      401,
      "Sign in with a ROCKET1000 passkey to manage billing.",
      "ACCOUNT_REQUIRED",
    );
  return { workspaceId, userId: session.userId };
}

export async function readBillingWebhook(req) {
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new ApiError(415, "JSON content type required.");
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "Missing webhook body.");
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return Buffer.concat(chunks);
    bytes += value.length;
    if (bytes > 131_072) {
      await reader.cancel();
      throw new ApiError(413, "Webhook body exceeds the size limit.");
    }
    chunks.push(value);
  }
}

function matchingHmac(secret, raw, supplied, prefix = "") {
  return (
    /^[a-f0-9]{128}$/.test(supplied || "") &&
    timingSafeEqual(
      createHmac("sha512", secret).update(prefix).update(raw).digest(),
      Buffer.from(supplied, "hex"),
    )
  );
}

export function verifyBillingWebhook(
  raw,
  headers,
  env = process.env,
  now = Date.now,
) {
  const signingSecret = env.PAYSTACK_WEBHOOK_SECRET;
  if (signingSecret) {
    if (!/^whsec_[A-Za-z0-9_=-]+$/.test(signingSecret))
      throw unavailable("Paystack webhook signing is misconfigured.");
    const parts = (headers.get("paystack-signature") || "")
      .split(",")
      .map((v) => v.trim());
    const timestamps = parts.filter((part) => part.startsWith("t="));
    const seconds = timestamps[0]?.slice(2);
    return (
      timestamps.length === 1 &&
      /^\d{10}$/.test(seconds) &&
      Math.abs(Math.floor(now() / 1000) - Number(seconds)) <= 300 &&
      parts.some((part) => {
        const match = /^v1=whk_[A-Za-z0-9]+:([a-f0-9]{128})$/.exec(part);
        return (
          !!match && matchingHmac(signingSecret, raw, match[1], seconds + ".")
        );
      })
    );
  }
  const key = sandboxKey(env);
  if (!key) throw unavailable();
  return matchingHmac(key, raw, headers.get("x-paystack-signature"));
}

export function billingService(
  db,
  { env = process.env, now = Date.now, fetcher = fetch } = {},
) {
  const plans = () => selectPlans(env);

  async function provider(path, { body, allowMissing = false } = {}) {
    const key = sandboxKey(env);
    if (!key) throw unavailable();
    let response;
    let payload;
    try {
      response = await fetcher(API_ORIGIN + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + key,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (response.status === 404 && allowMissing) return null;
      payload = await response.json();
    } catch {
      throw unavailable("Paystack did not respond. Try again shortly.");
    }
    if (!response.ok || payload?.status !== true)
      throw new ApiError(
        502,
        "Paystack could not complete the request.",
        "BILLING_PROVIDER_FAILED",
      );
    return payload.data;
  }

  async function getCheckout(reference) {
    const [checkout] = await db.query(
      "SELECT * FROM rocket_billing_checkouts WHERE reference=?",
      [reference],
    );
    return checkout;
  }

  async function paymentFor(reference, checkout, allowMissing = false) {
    const payment = await provider(
      "/transaction/verify/" + encodeURIComponent(reference),
      { allowMissing },
    );
    if (!payment) {
      validResponse(allowMissing);
      return null;
    }
    validResponse(
      payment.domain === "test" &&
        payment.reference === reference &&
        payment.amount === Number(checkout.amount) &&
        payment.currency === "ZAR" &&
        payment.customer?.email?.toLowerCase() === checkout.email,
    );
    if (payment.status === "success") {
      const paidAt = timestamp(payment.paid_at || payment.paidAt);
      validResponse(
        customerCode.test(payment.customer?.customer_code || "") &&
          Number.isFinite(paidAt) &&
          paidAt >= Number(checkout.created_at) - 5 * 60_000 &&
          paidAt <= now() + 5 * 60_000,
      );
    }
    return payment;
  }

  async function status({ workspaceId, userId }) {
    const [subscription] = await db.query(
      `SELECT s.state,s.expires_at,c.plan_id,c.plan_name
       FROM rocket_billing_subscriptions s JOIN rocket_billing_checkouts c ON c.reference=s.checkout_ref
       WHERE s.workspace_id=? AND c.user_id=? ORDER BY s.expires_at DESC LIMIT 1`,
      [workspaceId, userId],
    );
    const [pending] = await db.query(
      `SELECT reference,checkout_url,plan_id FROM rocket_billing_checkouts
       WHERE workspace_id=? AND user_id=? AND state IN ('initializing','pending')
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, userId],
    );
    const history = await db.query(
      `SELECT event_type,amount,occurred_at FROM rocket_billing_history
        WHERE workspace_id=? ORDER BY occurred_at DESC,event_id DESC LIMIT 30`,
      [workspaceId],
    );
    return {
      sandbox: true,
      checkoutAvailable: !!sandboxKey(env) && !!checkoutCallback(env),
      plans: plans().map(({ id, name, amount }) => ({ id, name, amount })),
      entitlement: await currentEntitlement(db, workspaceId, now),
      subscription: subscription
        ? {
            planId: subscription.plan_id,
            planName: subscription.plan_name,
            state: subscription.state,
            expiresAt: Number(subscription.expires_at),
          }
        : null,
      pending: pending
        ? {
            reference: pending.reference,
            checkoutUrl: pending.checkout_url,
            planId: pending.plan_id,
          }
        : null,
      history: history.map((row) => ({
        type: row.event_type,
        amount: Number(row.amount),
        timestamp: Number(row.occurred_at),
      })),
    };
  }

  async function checkout({ workspaceId, userId }, { planId, email }) {
    const plan = plans().find((candidate) => candidate.id === planId);
    if (!plan)
      throw new ApiError(
        400,
        "Select a current subscription plan.",
        "BILLING_PLAN_INVALID",
      );
    if (
      typeof email !== "string" ||
      email.length > 254 ||
      !emailPattern.test(email.trim())
    )
      throw new ApiError(
        400,
        "Enter a valid billing email address.",
        "BILLING_EMAIL_INVALID",
      );
    const contact = email.trim().toLowerCase();
    const callback = checkoutCallback(env);
    if (!sandboxKey(env) || !callback) throw unavailable();

    const attempt = await db.transaction(async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const [subscription] = await tx.query(
        `SELECT code FROM rocket_billing_subscriptions
          WHERE workspace_id=? AND (expires_at>? OR state NOT IN ('cancelled','completed'))
          LIMIT 1`,
        [workspaceId, now()],
      );
      if (subscription)
        throw new ApiError(
          409,
          "This workspace already has a subscription.",
          "BILLING_SUBSCRIPTION_EXISTS",
        );
      const [existing] = await tx.query(
        `SELECT reference,state,checkout_url,created_at FROM rocket_billing_checkouts
          WHERE workspace_id=? AND user_id=? AND state IN ('initializing','pending')
          ORDER BY created_at DESC LIMIT 1`,
        [workspaceId, userId],
      );
      if (existing) return { ...existing, existing: true };
      const reference = "rocket1000-" + randomUUID();
      await tx.query(
        `INSERT INTO rocket_billing_checkouts
          (reference,workspace_id,user_id,email,plan_id,plan_name,plan_code,amount,allowance,state,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,'initializing',?)`,
        [
          reference,
          workspaceId,
          userId,
          contact,
          plan.id,
          plan.name,
          plan.code,
          plan.amount,
          plan.allowance,
          now(),
        ],
      );
      return { reference, existing: false };
    });
    if (attempt.existing) {
      if (attempt.checkout_url)
        return {
          checkoutUrl: attempt.checkout_url,
          reference: attempt.reference,
        };
      throw new ApiError(
        409,
        "Checkout is being prepared. Refresh billing to check its status.",
        "BILLING_CHECKOUT_PENDING",
      );
    }

    let initializationSent = false;
    try {
      const remotePlan = await provider(
        "/plan/" + encodeURIComponent(plan.code),
      );
      validResponse(
        remotePlan?.domain === "test" &&
          remotePlan.plan_code === plan.code &&
          remotePlan.currency === "ZAR" &&
          remotePlan.interval === "monthly" &&
          remotePlan.amount === plan.amount,
      );
      initializationSent = true;
      const result = await provider("/transaction/initialize", {
        body: {
          email: contact,
          amount: String(plan.amount),
          currency: "ZAR",
          plan: plan.code,
          channels: ["card"],
          reference: attempt.reference,
          callback_url: callback,
          metadata: JSON.stringify({ cancel_action: callback }),
        },
      });
      validResponse(result?.reference === attempt.reference);
      const checkoutUrl = checkoutAddress(result.authorization_url);
      await db.query(
        `UPDATE rocket_billing_checkouts SET checkout_url=?,state='pending'
          WHERE reference=? AND state='initializing'`,
        [checkoutUrl, attempt.reference],
      );
      return { checkoutUrl, reference: attempt.reference };
    } catch (error) {
      if (!initializationSent)
        await db.query(
          "UPDATE rocket_billing_checkouts SET state='failed' WHERE reference=?",
          [attempt.reference],
        );
      throw error;
    }
  }

  async function findInitialSubscription(payment, attempt) {
    const customerId = payment.customer.id;
    const checkoutPlan = payment.plan_object;
    validResponse(Number.isSafeInteger(customerId) && customerId > 0);
    if (checkoutPlan?.plan_code)
      validResponse(checkoutPlan.plan_code === attempt.plan_code);
    const plan =
      checkoutPlan?.plan_code && Number.isSafeInteger(checkoutPlan.id)
        ? checkoutPlan
        : await provider("/plan/" + encodeURIComponent(attempt.plan_code));
    validResponse(
      plan?.plan_code === attempt.plan_code &&
        Number.isSafeInteger(plan.id) &&
        plan.id > 0,
    );
    const entries = await provider(
      `/subscription?customer=${customerId}&plan=${plan.id}&perPage=50`,
    );
    validResponse(Array.isArray(entries));
    const paidAt = timestamp(payment.paid_at || payment.paidAt);
    const auth = payment.authorization?.authorization_code;
    validResponse(typeof auth === "string" && auth.startsWith("AUTH_"));
    const matching = entries.filter(
      (entry) =>
        validSubscription(entry, payment, attempt) &&
        entry.authorization?.authorization_code === auth &&
        Math.abs(timestamp(entry.createdAt || entry.created_at) - paidAt) <=
          5 * 60_000,
    );
    validResponse(matching.length === 1);
    return matching[0];
  }

  async function appendPayment(
    tx,
    subscription,
    reference,
    amount,
    paidAt,
    type,
  ) {
    return tx.query(
      `INSERT INTO rocket_billing_history
        (event_id,workspace_id,subscription_code,event_type,amount,occurred_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
      [
        "charge:" + reference,
        subscription.workspace_id,
        subscription.code,
        type,
        amount,
        paidAt,
      ],
    );
  }

  async function activate(reference, attempt, payment) {
    if (attempt.state === "paid") return;
    const subscription = await findInitialSubscription(payment, attempt);
    const paidAt = timestamp(payment.paid_at || payment.paidAt);
    const expiresAt = endOfPaidPeriod(paidAt, subscription.next_payment_date);
    await db.transaction(async (tx) => {
      await lockWorkspace(tx, attempt.workspace_id);
      const [fresh] = await tx.query(
        "SELECT state FROM rocket_billing_checkouts WHERE reference=?",
        [reference],
      );
      if (fresh?.state === "paid") return;
      validResponse(fresh && waitingStates.includes(fresh.state));
      const [current] = await tx.query(
        `SELECT code FROM rocket_billing_subscriptions
          WHERE workspace_id=? AND (expires_at>? OR state NOT IN ('cancelled','completed')) LIMIT 1`,
        [attempt.workspace_id, now()],
      );
      validResponse(!current);
      const [inserted] = await tx.query(
        `INSERT INTO rocket_billing_subscriptions
           (code,workspace_id,checkout_ref,customer_code,state,changed_at,period_start,expires_at)
         VALUES(?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING code`,
        [
          subscription.subscription_code,
          attempt.workspace_id,
          reference,
          payment.customer.customer_code,
          providerState(subscription.status),
          paidAt,
          paidAt,
          expiresAt,
        ],
      );
      validResponse(inserted);
      await appendPayment(
        tx,
        { workspace_id: attempt.workspace_id, code: inserted.code },
        reference,
        Number(attempt.amount),
        paidAt,
        "initial_payment",
      );
      await tx.query(
        "UPDATE rocket_billing_checkouts SET state='paid',checkout_url=NULL WHERE reference=?",
        [reference],
      );
    });
  }

  async function verify(owner, reference) {
    if (typeof reference !== "string" || !transactionRef.test(reference))
      throw new ApiError(
        400,
        "Invalid checkout reference.",
        "BILLING_REFERENCE_INVALID",
      );
    const attempt = await getCheckout(reference);
    if (
      attempt?.workspace_id !== owner.workspaceId ||
      attempt.user_id !== owner.userId
    )
      throw new ApiError(
        404,
        "Checkout was not found.",
        "BILLING_REFERENCE_NOT_FOUND",
      );
    if (!waitingStates.includes(attempt.state)) return status(owner);
    const canRelease =
      attempt.state === "initializing" &&
      now() - Number(attempt.created_at) > REQUEST_LOCK_MS;
    const payment = await paymentFor(reference, attempt, canRelease);
    if (payment?.status === "success")
      await activate(reference, attempt, payment);
    if (payment === null || ["failed", "reversed"].includes(payment.status))
      await db.query(
        `UPDATE rocket_billing_checkouts SET state='failed',checkout_url=NULL
         WHERE reference=? AND state IN ('initializing','pending')`,
        [reference],
      );
    return status(owner);
  }

  async function subscriptionByCode(code) {
    const [subscription] = await db.query(
      `SELECT s.*,c.email,c.amount,c.plan_code,c.created_at
       FROM rocket_billing_subscriptions s JOIN rocket_billing_checkouts c ON c.reference=s.checkout_ref
       WHERE s.code=?`,
      [code],
    );
    return subscription;
  }

  async function noteSubscriptionState(
    subscription,
    state,
    changedAt,
    eventId,
    type,
  ) {
    await db.transaction(async (tx) => {
      await lockWorkspace(tx, subscription.workspace_id);
      await tx.query(
        `INSERT INTO rocket_billing_history
           (event_id,workspace_id,subscription_code,event_type,amount,occurred_at)
         VALUES(?,?,?,?,0,?) ON CONFLICT(event_id) DO NOTHING`,
        [
          eventId,
          subscription.workspace_id,
          subscription.code,
          type,
          changedAt,
        ],
      );
      await tx.query(
        `UPDATE rocket_billing_subscriptions SET state=?,changed_at=?
         WHERE code=? AND changed_at<=? AND state NOT IN ('cancelled','completed')
           AND (state<>'non-renewing' OR ?<>'attention')`,
        [state, changedAt, subscription.code, changedAt, state],
      );
    });
  }

  async function cancel(owner) {
    const [subscription] = await db.query(
      `SELECT s.*,c.email,c.amount,c.plan_code
       FROM rocket_billing_subscriptions s JOIN rocket_billing_checkouts c ON c.reference=s.checkout_ref
       WHERE s.workspace_id=? AND c.user_id=? ORDER BY s.expires_at DESC LIMIT 1`,
      [owner.workspaceId, owner.userId],
    );
    if (!subscription)
      throw new ApiError(
        404,
        "No subscription was found.",
        "BILLING_SUBSCRIPTION_MISSING",
      );
    if (["non-renewing", ...endedStates].includes(subscription.state))
      return status(owner);
    const providerSub = await provider(
      "/subscription/" + encodeURIComponent(subscription.code),
    );
    validResponse(
      validSubscription(
        providerSub,
        {
          customer: { customer_code: subscription.customer_code },
        },
        subscription,
        subscription.code,
      ),
    );
    const state = providerState(providerSub.status);
    if (!["non-renewing", ...endedStates].includes(state)) {
      validResponse(
        typeof providerSub.email_token === "string" &&
          /^[A-Za-z0-9_-]{1,100}$/.test(providerSub.email_token),
      );
      await provider("/subscription/disable", {
        body: { code: subscription.code, token: providerSub.email_token },
      });
    }
    await noteSubscriptionState(
      subscription,
      endedStates.includes(state) ? state : "non-renewing",
      now(),
      "cancel:" + subscription.code,
      "cancellation",
    );
    return status(owner);
  }

  async function renewal(subscription, data) {
    const reference = data.transaction?.reference;
    if (data.status !== "success" || ![true, 1].includes(data.paid)) return;
    validResponse(
      typeof reference === "string" && transactionRef.test(reference),
    );
    validResponse(data.customer?.customer_code === subscription.customer_code);
    const [record] = await db.query(
      "SELECT event_id FROM rocket_billing_history WHERE event_id=?",
      ["charge:" + reference],
    );
    if (record) return;
    const payment = await paymentFor(reference, subscription);
    validResponse(
      payment?.status === "success" &&
        payment.customer.customer_code === subscription.customer_code,
    );
    const remote = await provider(
      "/subscription/" + encodeURIComponent(subscription.code),
    );
    validResponse(
      validSubscription(remote, payment, subscription, subscription.code),
    );
    if (payment.plan_object?.plan_code)
      validResponse(payment.plan_object.plan_code === subscription.plan_code);
    const paidAt = timestamp(payment.paid_at || payment.paidAt);
    const expiresAt = endOfPaidPeriod(
      paidAt,
      data.subscription.next_payment_date,
    );
    await db.transaction(async (tx) => {
      await lockWorkspace(tx, subscription.workspace_id);
      const [record] = await appendPayment(
        tx,
        subscription,
        reference,
        Number(subscription.amount),
        paidAt,
        "renewal",
      );
      if (!record) return;
      await tx.query(
        `UPDATE rocket_billing_subscriptions SET period_start=?,expires_at=?,
         state=CASE WHEN changed_at<=? AND state='attention' THEN 'active' ELSE state END,
         changed_at=CASE WHEN changed_at<? THEN ? ELSE changed_at END
         WHERE code=? AND period_start<? AND expires_at<?`,
        [
          paidAt,
          expiresAt,
          paidAt,
          paidAt,
          paidAt,
          subscription.code,
          paidAt,
          expiresAt,
        ],
      );
    });
  }

  async function webhook(raw, headers) {
    if (!verifyBillingWebhook(raw, headers, env, now))
      throw new ApiError(
        401,
        "Invalid Paystack webhook signature.",
        "BILLING_SIGNATURE_INVALID",
      );
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new ApiError(400, "Invalid Paystack webhook JSON.");
    }
    const data = event?.data;
    if (data?.domain !== "test") return { received: true };
    if (event.event === "charge.success") {
      if (
        typeof data.reference !== "string" ||
        !transactionRef.test(data.reference)
      )
        return { received: true };
      const attempt = await getCheckout(data.reference);
      if (attempt && waitingStates.includes(attempt.state)) {
        const payment = await paymentFor(data.reference, attempt);
        validResponse(payment?.status === "success");
        await activate(data.reference, attempt, payment);
      }
      return { received: true };
    }

    const code = data.subscription?.subscription_code || data.subscription_code;
    if (typeof code !== "string" || !subscriptionCode.test(code))
      return { received: true };
    const subscription = await subscriptionByCode(code);
    if (!subscription) return { received: true };
    if (event.event === "invoice.update") await renewal(subscription, data);
    if (
      event.event === "invoice.payment_failed" &&
      /^INV_[A-Za-z0-9]{1,80}$/.test(data.invoice_code || "")
    ) {
      const changedAt = timestamp(data.created_at || data.createdAt);
      if (Number.isFinite(changedAt) && changedAt <= now() + 5 * 60_000)
        await noteSubscriptionState(
          subscription,
          "attention",
          changedAt,
          "failed:" + data.invoice_code,
          "payment_failed",
        );
    }
    if (
      ["subscription.not_renew", "subscription.disable"].includes(event.event)
    ) {
      const remote = await provider(
        "/subscription/" + encodeURIComponent(code),
      );
      validResponse(
        validSubscription(
          remote,
          {
            customer: { customer_code: subscription.customer_code },
          },
          subscription,
          code,
        ),
      );
      const state = providerState(remote.status);
      if (["non-renewing", ...endedStates].includes(state))
        await noteSubscriptionState(
          subscription,
          state,
          now(),
          "status:" + code + ":" + state,
          "cancellation",
        );
    }
    return { received: true };
  }

  return { checkout, verify, status, cancel, webhook };
}
