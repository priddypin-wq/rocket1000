"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";

type Plan = { id: string; name: string; amount: number };
type Billing = {
  checkoutAvailable: boolean;
  plans: Plan[];
  entitlement: { allowed: boolean };
  subscription: { planName: string; state: string; expiresAt: number } | null;
  pending: {
    reference: string;
    checkoutUrl: string | null;
    planId: string;
  } | null;
  history: { type: string; timestamp: number; amount: number }[];
};
type BillingAction =
  | { action: "checkout"; planId: string; email: string }
  | { action: "verify"; reference: string }
  | { action: "cancel" };

class BillingRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function billingRequest<T>(
  action?: BillingAction,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/billing", {
    method: action ? "POST" : "GET",
    cache: "no-store",
    signal,
    ...(action
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new BillingRequestError(
      data.error || "Billing is unavailable.",
      response.status,
    );
  return data;
}

const price = new Intl.NumberFormat("en-ZA", {
  style: "currency",
  currency: "ZAR",
});
const eventNames: Record<string, string> = {
  initial_payment: "Subscription payment",
  renewal: "Renewal payment",
  payment_failed: "Payment failed",
  cancellation: "Renewal cancelled",
};

function dateLabel(value: number) {
  return new Date(value).toLocaleDateString();
}

export default function BillingPanel() {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [problem, setProblem] = useState("");
  const [signIn, setSignIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const inFlight = useRef(false);
  const planRef = useRef<HTMLSelectElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const initial = await billingRequest<Billing>(
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setBilling(initial);
        const params = new URLSearchParams(window.location.search);
        const reference = params.get("reference");
        if (params.has("reference") || params.has("trxref"))
          window.history.replaceState(null, "", "/billing");
        if (reference && initial.pending?.reference === reference) {
          const updated = await billingRequest<Billing>(
            { action: "verify", reference },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          setBilling(updated);
          setNotice(
            updated.subscription && !updated.pending
              ? "Subscription payment verified."
              : "Waiting for verified payment.",
          );
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof BillingRequestError && error.status === 401)
          setSignIn(true);
        setProblem(
          error instanceof Error ? error.message : "Could not load billing.",
        );
      }
    }
    void load();
    return () => controller.abort();
  }, []);

  async function submit(action: BillingAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action.action);
    setProblem("");
    setNotice("");
    try {
      if (action.action === "checkout") {
        const result = await billingRequest<{ checkoutUrl: string }>(action);
        window.location.assign(result.checkoutUrl);
        return;
      }
      const next = await billingRequest<Billing>(action);
      setBilling(next);
      if (action.action === "cancel") {
        setCancelConfirm(false);
        setNotice("Renewal cancelled.");
      } else {
        setNotice(
          next.subscription && !next.pending
            ? "Subscription payment verified."
            : next.pending
              ? "Waiting for verified payment."
              : "This checkout ended without a verified payment.",
        );
      }
    } catch (error) {
      if (error instanceof BillingRequestError && error.status === 401)
        setSignIn(true);
      setProblem(
        error instanceof Error
          ? error.message
          : "Billing action could not be completed.",
      );
    } finally {
      inFlight.current = false;
      setBusy("");
    }
  }

  function startCheckout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit({
      action: "checkout",
      planId: planRef.current?.value || "",
      email: emailRef.current?.value || "",
    });
  }

  if (signIn)
    return (
      <section className="inner-card">
        <p role="status">Sign in to view your private subscription.</p>
        <Link className="inner-back" href="/account">
          Sign in with a passkey
        </Link>
      </section>
    );

  const subscription = billing?.subscription;
  const renewalActive =
    subscription && ["active", "attention"].includes(subscription.state);
  const hasSubscription = renewalActive || !!billing?.entitlement.allowed;

  return (
    <>
      <section className="inner-card">
        <h2>Paystack sandbox</h2>
        {problem && <p role="alert">{problem}</p>}
        {notice && <p role="status">{notice}</p>}
        {!billing && !problem && <p role="status">Loading subscription…</p>}
        {subscription && (
          <>
            <p>{subscription.planName}</p>
            <p>
              {billing.entitlement.allowed
                ? "Access until " + dateLabel(subscription.expiresAt)
                : "Subscription access expired."}
            </p>
            {subscription.state === "attention" && (
              <p>Paystack could not collect the latest renewal.</p>
            )}
            {subscription.state === "non-renewing" && (
              <p>Automatic renewal is off.</p>
            )}
            {renewalActive &&
              (cancelConfirm ? (
                <>
                  <p>
                    Cancel future renewals? Paid access continues until{" "}
                    {dateLabel(subscription.expiresAt)}.
                  </p>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={!!busy}
                    onClick={() => void submit({ action: "cancel" })}
                  >
                    {busy === "cancel" ? "Cancelling…" : "Confirm cancellation"}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={!!busy}
                    onClick={() => setCancelConfirm(false)}
                  >
                    Keep subscription
                  </button>
                </>
              ) : (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={!!busy}
                  onClick={() => setCancelConfirm(true)}
                >
                  Cancel renewal
                </button>
              ))}
          </>
        )}
        {billing?.pending && (
          <>
            <p>Checkout is awaiting payment verification.</p>
            {billing.pending.checkoutUrl && (
              <a
                className="secondary-button"
                href={billing.pending.checkoutUrl}
                rel="noreferrer"
              >
                Continue to Paystack
              </a>
            )}
            <button
              className="secondary-button"
              type="button"
              disabled={!!busy}
              onClick={() => {
                if (billing.pending)
                  void submit({
                    action: "verify",
                    reference: billing.pending.reference,
                  });
              }}
            >
              {busy === "verify" ? "Checking…" : "Check payment status"}
            </button>
          </>
        )}
        {billing &&
          !billing.pending &&
          !hasSubscription &&
          (billing.checkoutAvailable && billing.plans.length ? (
            <form onSubmit={startCheckout} className="inner-form">
              <label>
                Monthly plan
                <select ref={planRef} required defaultValue="">
                  <option value="" disabled>
                    Select a plan
                  </option>
                  {billing.plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name} · {price.format(plan.amount / 100)} per month
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Billing email
                <input
                  ref={emailRef}
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  required
                />
              </label>
              <p>Paystack uses this address for your checkout and receipts.</p>
              <button
                className="primary-button"
                type="submit"
                disabled={!!busy}
              >
                {busy === "checkout"
                  ? "Opening Paystack…"
                  : "Open test checkout"}
              </button>
            </form>
          ) : (
            <p>Paystack sandbox checkout is awaiting platform configuration.</p>
          ))}
      </section>
      <section className="inner-card">
        <h2>Billing history</h2>
        {billing &&
          (billing.history.length ? (
            <dl>
              {billing.history.map((event, index) => (
                <div
                  key={event.type + ":" + event.timestamp + ":" + index}
                  className="inner-row"
                >
                  <dt>
                    {eventNames[event.type]} · {dateLabel(event.timestamp)}
                  </dt>
                  <dd>
                    {event.amount > 0 ? price.format(event.amount / 100) : "—"}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p>No billing activity yet.</p>
          ))}
      </section>
    </>
  );
}
