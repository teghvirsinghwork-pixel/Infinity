// Vercel serverless entry point.
// Exports the Express app directly — Vercel calls it as a request handler.
// Does NOT call app.listen() (serverless functions don't bind to a port).
export { default } from "./app.js";
