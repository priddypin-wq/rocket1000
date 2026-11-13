import { createEngineControls } from "./engine-control-client.mjs";
import { mt5Api } from "./mt5-client";

export const engineControls = createEngineControls({
  request: mt5Api,
  onStopped: () => {
    window.dispatchEvent(new Event("rocket-trading-stopped"));
  },
});
