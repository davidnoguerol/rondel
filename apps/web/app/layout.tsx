import type { Metadata } from "next";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "Rondel",
  description: "Multi-agent orchestration dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface text-ink font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
