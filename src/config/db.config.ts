import { Pool } from "pg";
import { Env } from "./env.config.js";

const pool = new Pool({
  user: Env.DB_USER,
  host: Env.DB_HOST,
  database: Env.DB_NAME,
  port: Number(Env.DB_PORT),
  password: Env.DB_PASSWORD,
});

pool.on("connect", () => {
  console.log("Postgres pool is connected");
});

pool.on("error", (error) => {
  console.log(
    "An unexpected error has been occured while connecting to pg pool: ",
    error,
  );
  process.exit(1);
});

export const connectPool = async () => {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT NOW()");
    console.log("Postgres connected at:", result.rows[0].now);
  } catch (error) {
    console.error("Postgres connection failed:", error);
    throw error;
  } finally {
    client.release();
  }
};
