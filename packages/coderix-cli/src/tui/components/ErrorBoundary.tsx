import { Component, type ReactNode } from 'react';
import { Box, Text } from '@coderix/tui';

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
    // `console.error`, not `process.stderr.write`: ink patches the console and
    // replays it above the current frame, keeping its cursor accounting intact.
    // A raw write would move the cursor behind ink's back, so its next repaint
    // would rewind to the wrong row and strand the frame it meant to erase.
    console.error(
      `[ErrorBoundary:${this.props.name}] ${error.message}\n` +
      `  Component stack: ${cs.replace(/\n/g, '\n  ')}`,
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
