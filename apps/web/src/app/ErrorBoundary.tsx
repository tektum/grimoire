import { Component, type ReactNode } from 'react';
import { log } from '../logging';

interface State {
  failed: boolean;
}

/** Catches a render error so the shell stays up. Only the error's name is logged, never its message (it may hold document text). */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };
  static getDerivedStateFromError(): State {
    return { failed: true };
  }
  override componentDidCatch(error: Error): void {
    log('error', 'web.render_error', { name: error.name });
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="error-boundary">
        <h1>Something went wrong</h1>
        <p>The page could not be shown. Your work on the server is safe.</p>
        <button type="button" onClick={() => this.setState({ failed: false })}>
          Try again
        </button>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
