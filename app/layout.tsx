import type { Metadata, Viewport } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "ROCKET1000 | Trading command center",
  description: "Live MT5 connectivity, market analysis, and risk controls.",
  applicationName: "ROCKET1000",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ROCKET1000",
  },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0b14",
};
export default function Layout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
