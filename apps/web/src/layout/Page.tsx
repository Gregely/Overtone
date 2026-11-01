import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';

let firstPage = true;

/**
 * Sets the document title and, after client-side navigation, moves focus to
 * the page heading so screen-reader and keyboard users land on the new content.
 */
export function Page({ title, heading, actions, children }: { title: string; heading?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const h1 = useRef<HTMLHeadingElement>(null);
  const location = useLocation();
  useEffect(() => {
    document.title = `${title} · Overtone`;
  }, [title]);
  useEffect(() => {
    if (firstPage) {
      firstPage = false;
      return;
    }
    h1.current?.focus({ preventScroll: false });
  }, [location.pathname]);
  return (
    <div className="stack">
      <div className="row wrap">
        <h1 ref={h1} tabIndex={-1}>
          {heading ?? title}
        </h1>
        <span className="spacer" />
        {actions}
      </div>
      {children}
    </div>
  );
}
