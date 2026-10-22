import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "ROCKET1000 | Trading command center",
  description: "Live MT5 connectivity, market analysis, and risk controls.",
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
