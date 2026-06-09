import "./styles.css";
import { createApp } from "./app/createApp";

const canvas = document.querySelector<HTMLCanvasElement>("#renderCanvas");
const status = document.querySelector<HTMLDivElement>("#status");

if (!canvas || !status) {
  throw new Error("SplatShop shell is missing required DOM nodes.");
}

createApp(canvas, status).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = `Startup failed: ${message}`;
  console.error(error);
});
