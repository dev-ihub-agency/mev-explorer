import type { Metadata } from "next";
import { Poppins, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "MEV Scanner",
  description: "Ethereum MEV arbitrage transaction explorer",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const ossBase = "https://mev-explorer-data.oss-ap-southeast-1.aliyuncs.com";
  return (
    <html lang="en" className={`${poppins.variable} ${jetbrains.variable}`}>
      <head>
        <link rel="dns-prefetch" href={ossBase} />
        <link rel="preconnect" href={ossBase} crossOrigin="anonymous" />
        <link rel="preload" href={`${ossBase}/eth/data.json`} as="fetch" crossOrigin="anonymous" />
        <link rel="preload" href={`${ossBase}/bsc/data.json`} as="fetch" crossOrigin="anonymous" />
        <link rel="preload" href={`${ossBase}/sol/data.json`} as="fetch" crossOrigin="anonymous" />
        <link rel="preload" href={`${ossBase}/eth/sandwich-history.json`} as="fetch" crossOrigin="anonymous" />
        <link rel="preload" href={`${ossBase}/bsc/sandwich-history.json`} as="fetch" crossOrigin="anonymous" />
        <link rel="preload" href={`${ossBase}/sol/sandwich-history.json`} as="fetch" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
