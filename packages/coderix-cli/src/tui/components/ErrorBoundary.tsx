import { Component, type ReactNode } from 'react';
import { Box, Text } from '@coderix/ink';

interface Props {
  children: ReactNode;
  name: string;
}

interface State {
  error: Error | null;
  info: string;
  componentStack: string;
}

/**
 * Error boundary that catches render errors and logs component info.
 * Used to identify the source of "Rendered fewer hooks than expected" errors.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '', componentStack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, info: error.stack?.split('\n').slice(0, 5).join('\n') ?? error.message };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    const cs = errorInfo.componentStack ?? 'N/A';
    this.setState({ componentStack: cs });
    process.stderr.write(
      `[ErrorBoundary:${this.props.name}] ${error.message}\n` +
      `  Component stack: ${cs.replace(/\n/g, '\n  ')}\n`,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <Box flexDirection="column" marginY={1} paddingX={1}>
          <Text color="ansi:red" bold>
            [ErrorBoundary:{this.props.name}] {this.state.error.message}
          </Text>
          <Text dimColor>{this.state.info}</Text>
          <Text dimColor>Component stack: {this.state.componentStack || 'N/A'}</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
