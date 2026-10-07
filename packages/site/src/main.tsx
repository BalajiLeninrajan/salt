import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import posthog from "posthog-js";
import { PostHogProvider } from "@posthog/react";
import App from "./App";
import { redactEvent } from "./redact";
import "catppuccin-neu/css/index.css";
import "./styles.css";

posthog.init(import.meta.env.VITE_PUBLIC_POSTHOG_KEY, {
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
  defaults: "2026-05-30",
  cookieless_mode: "always",
  // A report is someone's project names and swear words. Autocapture would
  // send them as the text and attributes of whatever was clicked, so it sends
  // neither, on any page this bundle draws.
  mask_all_text: true,
  mask_all_element_attributes: true,
  before_send: (event) => redactEvent(event, window.location.origin),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PostHogProvider client={posthog}>
      <App />
    </PostHogProvider>
  </StrictMode>,
);
