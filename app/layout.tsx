import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lecture Recorder",
  description: "Record lectures, bookmark moments, and review AI summaries.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
