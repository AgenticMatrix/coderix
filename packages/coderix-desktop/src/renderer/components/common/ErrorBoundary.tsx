import React, { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] Caught error:', error, info);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          padding: '16px',
          background: 'var(--color-bg-primary, #FAF9F5)',
          color: 'var(--color-text-primary, #1D1D1F)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
            Something went wrong
          </h2>
          <p style={{
            fontSize: '13px',
            color: 'var(--color-text-secondary, #6E6E73)',
            marginBottom: '16px',
            maxWidth: '400px',
            textAlign: 'center',
          }}>
            {this.state.error?.message ?? 'An unexpected error occurred'}
          </p>
          <button
            onClick={this.handleRetry}
            style={{
              padding: '8px 16px',
              background: 'var(--color-brand, #D97757)',
              color: 'var(--color-text-inverse, #FFFFFF)',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
