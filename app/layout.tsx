import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ROCKET1000 | Voice Assistant",
  description: "Talk to your ROCKET1000 AI assistant without typing.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
