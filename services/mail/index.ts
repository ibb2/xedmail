import { Elysia } from "elysia";

const PORT = Number(process.env.PORT ?? 3001);

const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  .listen(PORT);

console.log(`Mail service running on port ${PORT}`);

export type App = typeof app;
