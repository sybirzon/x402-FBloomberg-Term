import { StrictMode, Component } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './App.css';
import './dynamicClient';
import App from './App';
import { DynamicProvider } from './dynamic-wallet/DynamicProvider';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', color: 'red', background: '#0a0c10', minHeight: '100vh' }}>
          <h2>Runtime Error</h2>
          <pre>{String(this.state.error)}</pre>
          <pre>{(this.state.error as Error).stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <DynamicProvider>
        <App />
      </DynamicProvider>
    </ErrorBoundary>
  </StrictMode>,
);
