import { Buffer } from "buffer";
import BN from "bn.js";

import React from "react";
import ReactDOM from "react-dom/client";

(window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
(window as unknown as { BN?: typeof BN }).BN = BN;

import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
