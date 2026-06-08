import "./styles.css";
import { createBabySplatApp } from "./app/createBabySplatApp";

const canvas = document.querySelector<HTMLCanvasElement>("#renderCanvas");
const status = document.querySelector<HTMLDivElement>("#status");

if (!canvas || !status) {
  throw new Error("BabySplat shell is missing required DOM nodes.");
}

createBabySplatApp(canvas, status).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = `Startup failed: ${message}`;
  console.error(error);
});
