'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/components/ui';

// moved into Settings
export default function DispatchersPage() {
  const router = useRouter();
  useEffect(() => router.replace('/settings?tab=dispatchers'), [router]);
  return <Spinner />;
}
