import type { Metadata } from "next";
import { Heebo } from "next/font/google";
import { appName } from "@/lib/i18n/he";
import "./globals.css";

const heebo = Heebo({
  variable: "--font-heebo",
  subsets: ["hebrew", "latin"],
});

export const metadata: Metadata = {
  title: appName,
  description: "מערכת תיאום ימי צילום",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl">
      <body className={`${heebo.variable} font-sans antialiased`}>{children}</body>
    </html>
  );
}
