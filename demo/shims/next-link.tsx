import { forwardRef } from 'react';
import { navigate } from '../router';

function toUrl(href: any): string {
  if (typeof href === 'string') return href;
  const q = href?.query ? '?' + new URLSearchParams(href.query).toString() : '';
  return (href?.pathname || '/') + q + (href?.hash ? '#' + href.hash : '');
}
const Link = forwardRef<HTMLAnchorElement, any>(function Link({ href, replace, scroll, prefetch, shallow, passHref, legacyBehavior, locale, onClick, ...rest }, ref) {
  const url = toUrl(href);
  const external = /^[a-z]+:/i.test(url);
  return (
    <a
      ref={ref}
      href={external ? url : '#' + url}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || external || e.metaKey || e.ctrlKey || e.shiftKey || rest.target === '_blank') return;
        e.preventDefault();
        navigate(url, !!replace);
      }}
      {...rest}
    />
  );
});
export default Link;
