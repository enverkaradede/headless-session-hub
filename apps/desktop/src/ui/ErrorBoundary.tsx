/** Last line of defence: a render error shows a recoverable screen instead of a blank window. */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("UI crashed", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center bg-harbor-950 p-8">
        <div className="max-w-md rounded-2xl border border-rose-glow/30 bg-harbor-900 p-6 text-center">
          <h1 className="font-display text-[18px] font-semibold text-ink-50">Arayüzde bir hata oluştu</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-400">Oturumların etkilenmedi; motor arka planda çalışmaya devam ediyor.</p>
          <pre className="mt-4 max-h-32 overflow-auto rounded-lg bg-harbor-950 p-3 text-left font-mono text-[11.5px] whitespace-pre-wrap text-rose-glow">{this.state.error.message}</pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 h-9 rounded-lg bg-gradient-to-b from-beacon-300 to-beacon-500 px-4 text-[13px] font-medium text-harbor-950"
          >
            Yeniden yükle
          </button>
        </div>
      </div>
    );
  }
}
