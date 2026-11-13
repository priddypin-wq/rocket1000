import AppShell from "../components/app-shell";
import BillingPanel from "./billing-panel";

export default function Page() {
  return (
    <AppShell title="Subscription">
      <BillingPanel />
    </AppShell>
  );
}
