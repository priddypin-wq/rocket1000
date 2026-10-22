import Link from "next/link";
export default function BottomNav({ active = "" }: { active?: string }) {
  return (
    <nav className="robot-nav inner-nav" aria-label="Main navigation">
      {[
        ["/", "⌂", "Home"],
        ["/dashboard", "▥", "Market"],
        ["/mt5", "⇄", "MT5"],
        ["/settings", "⚙", "Settings"],
      ].map(([href, icon, label]) => (
        <Link
          key={href}
          href={href}
          className={
            active === label || (active === "Markets" && label === "Market")
              ? "robot-nav-active"
              : ""
          }
          aria-current={
            active === label || (active === "Markets" && label === "Market")
              ? "page"
              : undefined
          }
        >
          <span className="inner-nav-icon" aria-hidden="true">
            {icon}
          </span>
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
