'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui';

// moved into Settings
export default function HelpPage() {
  const router = useRouter();
  useEffect(() => router.replace('/settings?tab=help'), [router]);
  return <Spinner />;
}
