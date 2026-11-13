import AppShell from "../components/app-shell";
import AccountAccess from "./account-access";

export default function AccountPage() {
  return (
    <AppShell title="Your account">
      <AccountAccess />
    </AppShell>
  );
}
