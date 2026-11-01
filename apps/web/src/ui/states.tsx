import type { ReactNode } from 'react';
import { ApiError, NetworkError } from '../api/client';
import { Icon } from './Icon';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state" role="status">
      <div className="spinner" aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, icon = 'music' }: { title: string; children?: ReactNode; icon?: Parameters<typeof Icon>[0]['name'] }) {
  return (
    <div className="state">
      <Icon name={icon} size={36} />
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof NetworkError) return "Can't reach the server. Check your connection.";
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong.';
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const offline = error instanceof NetworkError;
  return (
    <div className="state" role="alert">
      <Icon name={offline ? 'wifiOff' : 'alert'} size={36} />
      <h2>{offline ? "Can't reach the server" : "Couldn't load this"}</h2>
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          <Icon name="refresh" size={18} /> Try again
        </button>
      )}
    </div>
  );
}

/** Standard loading/error wrapper for a query. */
export function QueryView<T>({
  query,
  children,
  label,
}: {
  query: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown };
  children: (data: T) => ReactNode;
  label?: string;
}) {
  if (query.isPending) return <Spinner {...(label ? { label } : {})} />;
  if (query.error && query.data === undefined) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data as T)}</>;
}
