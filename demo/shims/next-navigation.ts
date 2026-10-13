import { useMemo } from 'react';
import { useLoc, navigate, useRouteParams } from '../router';

const router = {
  push: (u: string, _o?: any) => navigate(u),
  replace: (u: string, _o?: any) => navigate(u, true),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => {},
  prefetch: () => {},
};
export const useRouter = () => router;
export const usePathname = () => useLoc().path;
export function useSearchParams() {
  const { search } = useLoc();
  return useMemo(() => new URLSearchParams(search), [search]);
}
export const useParams = () => useRouteParams();
export const useSelectedLayoutSegment = () => null;
export const useSelectedLayoutSegments = () => [];
export function redirect(u: string): never {
  navigate(u, true);
  throw new Error('NEXT_REDIRECT');
}
export function notFound(): never {
  throw new Error('NEXT_NOT_FOUND');
}
