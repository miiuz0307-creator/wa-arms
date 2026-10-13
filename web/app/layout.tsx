import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Hebrew, Rubik } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '@/lib/auth';
import { SwRegister } from '@/components/SwRegister';

const plex = IBM_Plex_Sans_Hebrew({ subsets: ['hebrew', 'latin'], weight: ['400', '500', '600', '700'], variable: '--font-plex', display: 'swap' });
const rubik = Rubik({ subsets: ['hebrew', 'latin'], variable: '--font-rubik', display: 'swap' });

export const metadata: Metadata = {
  title: 'BotiX – הפצת נסיעות לתחנות מוניות',
  description: 'BotiX: הפצת נסיעות לקבוצות WhatsApp, ניהול זרועות, קבוצות ורשימות הפצה לתחנות מוניות',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'BotiX', statusBarStyle: 'default' },
  icons: { icon: '/icon-192.png', apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f1f3f5' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1217' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

// set the theme before the first paint (no flash): saved choice, else the device setting
const THEME_INIT = `try{var t=localStorage.getItem('botix-theme');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={`${plex.variable} ${rubik.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="font-sans antialiased">
        <AuthProvider>{children}</AuthProvider>
        <SwRegister />
      </body>
    </html>
  );
}
