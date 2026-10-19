import { Component, type ReactNode } from 'react'
import { ErrorState } from '../ui/State'

/** Keeps a crashing page from taking down the sidebar and the player; remount via `key` on navigation. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <ErrorState message="Something went wrong showing this page." onRetry={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    )
  }
}
