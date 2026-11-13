"use client";

import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type Account = {
  userId: string;
  role: "owner" | "customer";
  legacyClaimAvailable: boolean;
  reauthenticationRequired?: boolean;
};

async function accountRequest(path: string, body?: object) {
  const response = await fetch(`/api/account/${path}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (
    response.status === 401 &&
    !body &&
    data.code === "ACCOUNT_SESSION_REQUIRED"
  )
    return { account: null };
  if (!response.ok)
    throw new Error(
      data.error || "The account service could not complete this action.",
    );
  return data;
}

export default function AccountAccess() {
  const [account, setAccount] = useState<Account | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const operation = useRef(false);

  useEffect(() => {
    let mounted = true;
    void accountRequest("session").then(
      (data) => {
        if (mounted) setAccount(data.account);
      },
      (error: Error) => {
        if (mounted) setError(error.message);
      },
    );
    return () => {
      mounted = false;
    };
  }, []);

  async function perform(
    action: "login" | "register" | "passkeys" | "claim" | "skip" | "logout",
  ) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "logout") {
        await accountRequest(action, {});
        window.location.replace("/account");
      } else if (action === "claim" || action === "skip") {
        const data = await accountRequest(
          "claim",
          action === "claim" ? { confirm: true } : { skip: true },
        );
        setAccount(data.account);
        setNotice(
          action === "claim"
            ? "Existing workspace linked to this account."
            : "Your separate workspace is ready.",
        );
      } else {
        const options = await accountRequest(action, {
          action: "options",
          ...(action === "register" && name.trim()
            ? { name: name.trim() }
            : {}),
        });
        const response = await (action === "login"
          ? startAuthentication({ optionsJSON: options.options })
          : startRegistration({ optionsJSON: options.options }));
        const data = await accountRequest(action, {
          action: "verify",
          response,
        });
        setAccount(data.account);
        setNotice(action === "passkeys" ? "Passkey added." : "Signed in.");
      }
    } catch (error) {
      setError(
        error instanceof Error && error.name === "NotAllowedError"
          ? "Passkey verification was cancelled or timed out."
          : error instanceof Error
            ? error.message
            : "The account action failed.",
      );
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="inner-card openai-connection" aria-busy={busy}>
      <div className="inner-card-title">
        <span>PRIVATE WORKSPACE</span>
        {account !== undefined ? (
          <span>{account ? "SIGNED IN" : "SIGNED OUT"}</span>
        ) : null}
      </div>
      {account ? (
        <>
          {account.legacyClaimAvailable ? (
            <>
              <p>
                This browser can link its existing MT5 connection, settings and
                history to this account. Use this option on the computer where
                ROCKET1000 is already connected.
              </p>
              <div className="engine-actions">
                <button
                  className="action-red"
                  type="button"
                  disabled={busy || account.reauthenticationRequired}
                  onClick={() => void perform("claim")}
                >
                  Link existing workspace
                </button>
                <button
                  className="action-outline"
                  type="button"
                  disabled={busy || account.reauthenticationRequired}
                  onClick={() => void perform("skip")}
                >
                  Continue separately
                </button>
              </div>
            </>
          ) : (
            <p>
              Use your saved passkey on your phone and computer to open the same
              workspace. A device without the passkey can use another device’s
              passkey if supported by its browser.
            </p>
          )}
          <div className="engine-actions">
            {account.reauthenticationRequired ? (
              <button
                className="action-outline"
                type="button"
                disabled={busy}
                onClick={() => void perform("login")}
              >
                Verify passkey again
              </button>
            ) : (
              <button
                className="action-outline"
                type="button"
                disabled={busy}
                onClick={() => void perform("passkeys")}
              >
                Add passkey
              </button>
            )}
            <button
              className="action-outline"
              type="button"
              disabled={busy}
              onClick={() => void perform("logout")}
            >
              Sign out
            </button>
          </div>
          {!account.legacyClaimAvailable ? (
            <p>
              <Link className="inner-text-link" href="/">
                Open dashboard
              </Link>
              {" · "}
              <Link className="inner-text-link" href="/billing">
                Subscription
              </Link>
              {account.role === "owner" ? (
                <>
                  {" · "}
                  <Link className="inner-text-link" href="/owner">
                    Owner dashboard
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
          <p className="inner-note">Account reference {account.userId}</p>
        </>
      ) : account === null ? (
        <>
          <p>Use a passkey to access your private ROCKET1000 workspace.</p>
          <div className="engine-actions">
            <button
              className="action-red"
              type="button"
              disabled={busy}
              onClick={() => void perform("login")}
            >
              Sign in with a passkey
            </button>
          </div>
          <details>
            <summary>Create an account</summary>
            <label className="trade-field">
              Passkey label (optional)
              <input
                maxLength={48}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
              />
            </label>
            <button
              className="action-outline"
              type="button"
              disabled={busy}
              onClick={() => void perform("register")}
            >
              Create account with a passkey
            </button>
          </details>
        </>
      ) : !error ? (
        <p role="status">Checking your session…</p>
      ) : null}
      {error ? (
        <p className="inner-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="inner-notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
