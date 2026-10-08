import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SiteHeader } from "@/components/site-header";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { GHSSH_ORIGIN } from "@/lib/config";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "resuki-nic — personal domains under resukisu.org",
    template: "%s · resuki-nic",
  },
  description: `Sign in with your GitHub SSH key via ${GHSSH_ORIGIN} and register one personal domain under verified.resukisu.org.`,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <SiteHeader />
          <div className="flex flex-1 flex-col">{children}</div>
          <footer className="border-t px-4 py-6 text-xs text-muted-foreground">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
              <span>
                Identity verification by{" "}
                <a className="underline underline-offset-4 hover:text-foreground" href={GHSSH_ORIGIN}>
                  {GHSSH_ORIGIN.replace(/^https?:\/\//, "")}
                </a>
              </span>
              <span>DNS delegated through Cloudflare. Hosted on Vercel.</span>
            </div>
          </footer>
          <Toaster position="top-center" richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
