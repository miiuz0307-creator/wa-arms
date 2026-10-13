'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Distribution lists moved into "ניהול קבוצות והפצה" (/groups).
export default function ListsMoved() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/groups');
  }, [router]);
  return null;
}
