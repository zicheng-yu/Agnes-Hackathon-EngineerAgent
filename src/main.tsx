import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import {ThemeProvider} from "./Theme";
import "./app.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider><App /></ThemeProvider>
  </React.StrictMode>,
);
