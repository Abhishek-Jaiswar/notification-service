import { getEnv } from "../utils/get-env.js";

export const Env = {
  NODE_ENV: getEnv("NODE_ENV", "development"),
  PORT: getEnv("PORT", "8000"),

  DB_USER: getEnv("DB_USER", "postgres"),
  DB_PASSWORD: getEnv("DB_PASSWORD", "root"),
  DB_NAME: getEnv("DB_NAME", "notification-service"),
  DB_PORT: getEnv("DB_PORT", ""),
  DB_HOST: getEnv("DB_HOST", "localhost"),

  FRONTEND_URL: getEnv("FRONTEND_URL", "http://localhost:8000"),
};
