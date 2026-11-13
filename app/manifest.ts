import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ROCKET1000",
    short_name: "ROCKET1000",
    description:
      "OpenAI-powered MT5 trading, verified broker data and hard risk controls.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0b0b14",
    theme_color: "#0b0b14",
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
