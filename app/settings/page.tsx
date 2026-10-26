import AppShell from "../components/app-shell";
import TradeControls from "../components/trade-controls";
import OpenAiConnection from "../components/openai-connection";
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <AppShell
      title="Settings"
      subtitle="Verified account. Protected execution."
      active="Settings"
    >
      <OpenAiConnection />
      <TradeControls />
    </AppShell>
  );
}
