import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Shell } from "@/components/shell";
import { isFixture } from "@/lib/data";
import "./globals.css";
const sans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
export const metadata: Metadata = {
  title: { default: "Lyra · Overview", template: "Lyra · %s" },
  description: "Private Lyra translation workspace",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} dark`}>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <Shell fixture={isFixture()}>{children}</Shell>
      </body>
    </html>
  );
}
