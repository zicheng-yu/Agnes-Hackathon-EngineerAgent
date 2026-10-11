import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      deny: [
        "**/.env*",
        "**/data/**",
        "**/integrations/**",
        "**/.venv/**",
        "**/references/**",
        "**/*.pem",
      ],
    },
    watch: {
      ignored: [
        "**/integrations/**",
        "**/data/**",
        "**/.venv/**",
        "**/assets/**",
      ],
    },
  },
  build: { target: "es2022" },
});
