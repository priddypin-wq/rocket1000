import AppShell from "../components/app-shell";
import Mt5Connection from "../components/mt5-connection";
export default function Page() {
  return (
    <AppShell
      title="MetaTrader 5"
      subtitle="Your terminal. Your connection."
      active="MT5"
    >
      <Mt5Connection />
    </AppShell>
  );
}
