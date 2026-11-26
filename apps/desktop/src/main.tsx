import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import "./styles.css";

/** True for elements where the native cut/copy/paste menu belongs. */
function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input, textarea, [contenteditable='true']") !== null;
}

// Native feel: no WebView "Reload / Inspect Element" menu in shipped builds; dev keeps it for the inspector.
if (import.meta.env.PROD) {
  document.addEventListener("contextmenu", (event) => {
    if (!isEditable(event.target)) event.preventDefault();
  });
}

const container = document.getElementById("root");
if (!container) throw new Error("root element missing from index.html");

createRoot(container).render(
  <StrictMode>
    {/* "user": the OS "reduce motion" setting also stops motion's JS animations, which the CSS guard cannot reach. */}
    <MotionConfig reducedMotion="user">
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </MotionConfig>
  </StrictMode>,
);
