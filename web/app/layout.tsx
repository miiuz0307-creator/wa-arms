import type { Metadata, Viewport } from 'next';
import { Rubik } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/lib/auth';
import { SwRegister } from '@/components/SwRegister';

const rubik = Rubik({ subsets: ['hebrew', 'latin'], variable: '--font-rubik', display: 'swap' });

export const metadata: Metadata = {
  title: 'זרועות – ניהול הפצות WhatsApp',
  description: 'מערכת ניהול רב-זרועית להפצת הודעות בקבוצות WhatsApp',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'זרועות', statusBarStyle: 'default' },
  icons: { icon: '/icon-192.png', apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  themeColor: '#4f46e5',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={rubik.variable}>
      <body className="font-sans antialiased">
        <AuthProvider>{children}</AuthProvider>
        <SwRegister />
      </body>
    </html>
  );
}
