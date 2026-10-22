import Link from "next/link";
import type { ReactNode } from "react";
import DeadpoolAvatar from "./deadpool-avatar";
import BottomNav from "./bottom-nav";
import "../robot-home.css";
export default function AppShell({
  title,
  subtitle,
  children,
  active = "",
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  active?: string;
}) {
  return (
    <div className="robot-stage">
      <main className="robot-home robot-inner">
        <header className="robot-top">
          <Link href="/" className="robot-wordmark">
            ROCKET<span>1000</span>
          </Link>
          <Link
            href="/settings"
            className="inner-avatar"
            aria-label="Risk settings"
          >
            <DeadpoolAvatar />
          </Link>
        </header>
        <div className="inner-heading">
          <Link href="/" className="inner-back">
            ← Home
          </Link>
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <div className="inner-content">{children}</div>
        <BottomNav active={active} />
      </main>
    </div>
  );
}
