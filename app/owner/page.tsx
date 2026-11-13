import AppShell from "../components/app-shell";
import OwnerPanel from "./owner-panel";

export default function OwnerPage() {
  return (
    <AppShell title="Owner dashboard">
      <OwnerPanel />
    </AppShell>
  );
}
