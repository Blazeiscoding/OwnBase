import {
  render as renderAlone,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import type { JSXElementConstructor, ReactNode } from "react";
import { ConfirmProvider } from "../src/components/Confirm.js";
import { ToastProvider } from "../src/components/Toast.js";

/**
 * Renders inside the notices and questions the app puts around every screen
 * (`AppBoundary`), so a component drawn alone can report and ask as it does
 * in the app. A test's own `wrapper` goes inside them.
 */
export function render(ui: ReactNode, options: RenderOptions = {}): RenderResult {
  const Inner: JSXElementConstructor<{ children: ReactNode }> =
    options.wrapper ?? (({ children }) => children);
  return renderAlone(ui, {
    ...options,
    wrapper: ({ children }) => (
      <ToastProvider>
        <ConfirmProvider>
          <Inner>{children}</Inner>
        </ConfirmProvider>
      </ToastProvider>
    ),
  });
}
