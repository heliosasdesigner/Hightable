import { useEffect, useRef, type ReactElement } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentId, TerminalStatus } from "../../shared/types";

export interface TerminalPaneProps {
  terminalId: string;
  agent: AgentId;
  title: string;
  status: TerminalStatus;
}

const XTERM_THEME = {
  background: "#06040a",
  foreground: "#f0f0f2",
  cursor: "#e83c8a",
  cursorAccent: "#06040a",
  selectionBackground: "rgba(232, 60, 138, 0.28)",
  black: "#1a1a20",
  red: "#e8455f",
  green: "#5ac29a",
  yellow: "#e8c24b",
  blue: "#0d9be0",
  magenta: "#e83c8a",
  cyan: "#6bd8c5",
  white: "#c2c6ce",
  brightBlack: "#4a4a52",
  brightRed: "#ff6f80",
  brightGreen: "#80d6b4",
  brightYellow: "#ffd46a",
  brightBlue: "#49b7ed",
  brightMagenta: "#ff79b8",
  brightCyan: "#8ee6d8",
  brightWhite: "#f0f0f2",
} as const;

export function TerminalPane({ terminalId, title }: TerminalPaneProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily:
        'SFMono-Regular, "JetBrains Mono", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      letterSpacing: 0,
      cursorBlink: true,
      allowTransparency: false,
      scrollback: 5000,
      theme: XTERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const safeFit = (): void => {
      // xterm's renderer isn't ready the instant after term.open(); reading
      // dimensions before the first paint throws "Cannot read properties of
      // undefined (reading 'dimensions')". Check the container has non-zero
      // size before fitting and swallow any transient read error.
      if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0) {
          void window.hightable.resizeTerminal({
            terminalId,
            cols: term.cols,
            rows: term.rows,
          });
        }
      } catch {
        /* renderer not ready yet — next ResizeObserver tick will retry */
      }
    };
    const initialFitHandle = requestAnimationFrame(() => {
      requestAnimationFrame(safeFit);
    });

    const unsubscribeData = window.hightable.onTerminalData((event) => {
      if (event.terminalId === terminalId) {
        term.write(event.data);
      }
    });

    const unsubscribeExit = window.hightable.onTerminalExit((event) => {
      if (event.terminalId === terminalId) {
        term.writeln(
          `\r\n\x1b[2m[terminal exited: code ${event.exitCode}${
            event.signal !== undefined ? `, signal ${event.signal}` : ""
          }]\x1b[0m`,
        );
      }
    });

    const inputDisposable = term.onData((data) => {
      void window.hightable.writeTerminal({ terminalId, data });
    });

    const observer = new ResizeObserver(() => safeFit());
    observer.observe(host);

    return () => {
      cancelAnimationFrame(initialFitHandle);
      observer.disconnect();
      inputDisposable.dispose();
      unsubscribeData();
      unsubscribeExit();
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div
      ref={containerRef}
      className="terminal-canvas"
      role="region"
      aria-label={`${title} terminal`}
    />
  );
}
