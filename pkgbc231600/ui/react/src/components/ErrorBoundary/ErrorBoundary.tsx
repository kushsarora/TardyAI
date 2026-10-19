/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import React, {
  createContext,
  useContext,
  useCallback,
  ReactNode,
} from 'react';

// Context for reporting errors
interface ErrorReporterContextType {
  reportError: (error: unknown) => void;
}

const ErrorReporterContext = createContext<ErrorReporterContextType | null>(
  null,
);

/**
 * Hook to access the error reporting function.
 * Use this to report errors from event handlers and async code.
 *
 * @example
 * const { reportError } = useErrorReporter();
 *
 * const handleClick = async () => {
 *   try {
 *     await someAsyncOperation();
 *   } catch (err) {
 *     reportError(err); // Reports the error to Genesis
 *   }
 * };
 */
export function useErrorReporter(): ErrorReporterContextType {
  const context = useContext(ErrorReporterContext);
  if (!context) {
    throw new Error(
      'useErrorReporter must be used within an ErrorReporterProvider',
    );
  }
  return context;
}

// Keep old name as alias for backwards compatibility
export const useErrorBoundary = useErrorReporter;

interface ErrorReporterProviderProps {
  children: ReactNode;
}

/**
 * Provider component that makes the reportError function available to all children.
 */
class AppErrorBoundary extends React.Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    window.parent?.postMessage(
      {
        type: 'GENESIS_ERROR_REPORT',
        payload: { message: error.message, stack: error.stack },
      },
      '*',
    );
  }
  render() {
    if (this.state.failed)
      return (
        <div className="loading-page" role="alert">
          <h2>Let’s get you back on track.</h2>
          <p>
            The map ran into an unexpected problem. Reload to restore the
            building and try again.
          </p>
          <button
            className="primary-button"
            onClick={() => window.location.reload()}
          >
            Reload map
          </button>
        </div>
      );
    return this.props.children;
  }
}

export default function ErrorReporterProvider({
  children,
}: ErrorReporterProviderProps) {
  const reportError = useCallback((error: unknown): void => {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));

    // Report to parent window for Genesis error reporting
    window.parent?.postMessage(
      {
        type: 'GENESIS_ERROR_REPORT',
        payload: {
          message: normalizedError.message,
          stack: normalizedError.stack,
          file: 'EventHandler',
          line: 0,
          column: 0,
          timestamp: new Date().toISOString(),
        },
      },
      '*',
    );
  }, []);

  return (
    <ErrorReporterContext.Provider value={{ reportError }}>
      <AppErrorBoundary>{children}</AppErrorBoundary>
    </ErrorReporterContext.Provider>
  );
}

/**
 * Higher-order component wrapper for components that need error reporting access.
 * Provides the reportError function as a prop.
 */
export function withErrorReporter<P extends object>(
  WrappedComponent: React.ComponentType<
    P & { reportError: (error: unknown) => void }
  >,
): React.FC<P> {
  return function WithErrorReporterWrapper(props: P) {
    const { reportError } = useErrorReporter();
    return <WrappedComponent {...props} reportError={reportError} />;
  };
}
