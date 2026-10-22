import AppShell from "../components/app-shell";
import TradeControls from "../components/trade-controls";
import OpenAiConnection from "../components/openai-connection";
export const dynamic = "force-dynamic";
export default function Page() {
  return (
    <AppShell
      title="Settings"
      subtitle="Your key. Your account. Your control."
      active="Settings"
    >
      <OpenAiConnection />
      <TradeControls />
    </AppShell>
  );
}
