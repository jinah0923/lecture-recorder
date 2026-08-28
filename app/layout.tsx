import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "next-themes";
import { AccountButton } from "@/components/AccountButton";
import { AuthProvider } from "@/components/AuthProvider";
import { ServiceWorkerRegister } from "@/components/ServiceWorkerRegister";
import { ThemeToggle } from "@/components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lecture Recorder",
  description: "Record lectures, bookmark moments, and review AI summaries.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "강의노트",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
  other: {
    // Next's appleWebApp.capable only emits the newer, unprefixed
    // "mobile-web-app-capable" — add the legacy Apple-prefixed name too so
    // "Add to Home Screen" launches standalone (no Safari chrome) on older
    // iOS versions that don't yet recognize the unprefixed one.
    "apple-mobile-web-app-capable": "yes",
  },
};

// Split from `metadata` per Next.js's App Router convention — viewport/theme-
// color are their own export, not nested metadata fields.
export const viewport: Viewport = {
  themeColor: "#4f46e5",
  // Tells the mobile browser (Samsung Internet's "다크 모드로 전환", Chrome's
  // "Force dark") that this page already handles both schemes itself via the
  // .dark class + next-themes — without this, those "helpful" OS/browser
  // dark-mode-everything features can repaint an explicitly light-mode page
  // as dark underneath our own light styles, which is exactly the reported
  // "background stuck dark" bug.
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: next-themes sets the .dark class on <html>
    // via an inline script that runs before hydration (avoiding a flash of
    // the wrong theme) — React would otherwise warn about that class not
    // matching the server-rendered markup.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-white text-zinc-900 antialiased transition-colors dark:bg-zinc-950 dark:text-zinc-100">
        <AuthProvider>
          <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
            <AccountButton />
            <ThemeToggle />
            {children}
          </ThemeProvider>
        </AuthProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
