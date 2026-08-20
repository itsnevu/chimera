import type { Metadata } from "next";
import { Martian_Mono, Archivo } from "next/font/google";
import "./globals.css";

const mono = Martian_Mono({
  subsets: ["latin"],
  weight: ["400", "600", "800"],
  variable: "--font-mono",
});
const body = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "Chimera Studio",
  description: "Roll a collection, hold one character steady, and watch every dollar.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
