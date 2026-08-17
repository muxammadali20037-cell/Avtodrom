import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // While running `npm run dev`, forward /api calls to the Express server
    // (started separately with `npm run dev:server`) so the frontend and
    // backend can be developed side by side.
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
