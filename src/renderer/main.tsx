import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

// Self-hosted fonts. Each @fontsource package ships a CSS file with
// @font-face rules that reference bundled WOFF2 assets; Vite inlines
// them into dist/renderer/assets/. This replaces the Google Fonts <link>
// in index.html — no network call on launch, works offline, no privacy
// leak, and a strict CSP can block external font origins.
import "@fontsource/roboto-slab/400.css";
import "@fontsource/roboto-slab/500.css";
import "@fontsource/roboto-slab/700.css";
import "@fontsource/roboto-slab/800.css";
import "@fontsource/roboto-slab/900.css";
import "@fontsource/orbitron/400.css";
import "@fontsource/orbitron/500.css";
import "@fontsource/orbitron/700.css";
import "@fontsource/orbitron/900.css";
import "@fontsource/share-tech-mono/400.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";

import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
