/**
 * The browser entrypoint. Everything below it observes; nothing below it
 * decides (R3).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./components/App";

const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root — the bundle and the page disagree");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
