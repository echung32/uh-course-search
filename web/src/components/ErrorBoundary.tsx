import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  /** What to render in place of the children after they throw. */
  fallback: ReactNode;
  /**
   * Clears a caught error when it changes (compared with Object.is), so new
   * data gets a fresh render attempt instead of the fallback sticking forever.
   */
  resetKey?: unknown;
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  /** The resetKey the current error was caught under. */
  errorKey: unknown;
}

/**
 * Contains a render error to one region of an island. Without it, a throw
 * anywhere in a React island unmounts the whole island — e.g. one malformed
 * section in the results table blanked the entire search page, form included.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, errorKey: undefined };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState
  ): Partial<ErrorBoundaryState> | null {
    // New data since the error → try rendering the children again.
    if (state.hasError && !Object.is(props.resetKey, state.errorKey)) {
      return { hasError: false, errorKey: props.resetKey };
    }
    if (!state.hasError) return { errorKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Render error contained by ErrorBoundary:", error, info.componentStack);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
