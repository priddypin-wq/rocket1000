"use client";

import { useEffect, useState } from "react";

type Summary = {
  billing: {
    subscribers: number;
    active: number;
    successfulPayments: number;
    paidAmountCents: number;
  };
  usage: { requests: number; chargedUsd: number; reservedUsd: number };
  workerCheckIn: boolean;
  customers: {
    reference: string;
    subscribed: boolean;
    connected: boolean;
    analysis: string;
  }[];
};

export default function OwnerPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/account/owner", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Owner status is unavailable.");
        if (!controller.signal.aborted) setSummary(data);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Owner status is unavailable.",
          );
      }
    })();
    return () => controller.abort();
  }, []);
  if (!summary)
    return (
      <section className="inner-card" role={error ? "alert" : "status"}>
        {error || "Loading owner status…"}
      </section>
    );
  return (
    <>
      <section className="inner-card">
        <h2>Platform status</h2>
        <p>
          Worker check-in {summary.workerCheckIn ? "recent" : "unavailable"}
        </p>
        <p>
          Paystack sandbox · {summary.billing.active} active ·{" "}
          {summary.billing.successfulPayments} verified test payments
        </p>
        <p>
          AI today · {summary.usage.requests} requests · US${" "}
          {summary.usage.chargedUsd.toFixed(4)} estimated · US${" "}
          {summary.usage.reservedUsd.toFixed(4)} reserved
        </p>
      </section>
      <section className="inner-card">
        <h2>Recent accounts</h2>
        {summary.customers.length ? (
          <ul>
            {summary.customers.map((customer) => (
              <li key={customer.reference}>
                <p>Account {customer.reference}</p>
                <p>
                  {customer.subscribed
                    ? "Subscribed"
                    : "No active subscription"}{" "}
                  · MT5 {customer.connected ? "connected" : "disconnected"} · AI{" "}
                  {customer.analysis}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p>No accounts found.</p>
        )}
      </section>
    </>
  );
}
