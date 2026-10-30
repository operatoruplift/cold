import { createRoot } from "react-dom/client";
import { App } from "./app/app";
import { startPwa } from "./app/pwa";

startPwa();
createRoot(document.getElementById("root")!).render(<App />);
