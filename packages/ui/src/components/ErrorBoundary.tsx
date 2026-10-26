import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/**
 * Keeps one broken view from taking the workspace with it.
 *
 * Dismissing it re-renders the same tree rather than reloading the page: the
 * socket, the loaded history and anything half-typed are all still in memory,
 * and a reload would throw them away to fix a problem that is usually in the
 * rendering alone.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("OwnBase hit a rendering error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="card-warm max-w-[440px] rounded-2xl p-6 text-center">
          <h1 className="text-lg font-semibold">Something in this screen stopped working</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-dim">
            You are still signed in and connected. Nothing that was sent has been lost.
          </p>
          <p className="mt-3 break-words rounded-lg bg-ground px-3 py-2 text-left font-mono text-xs text-ink-faint">
            {error.message || String(error)}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="btn-shape bg-copper px-4 py-2 text-sm font-semibold text-ground transition-colors hover:bg-copper-deep"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg border border-edge px-4 py-2 text-sm text-ink-dim transition-colors hover:text-ink"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
