import express, { type Request, type Response } from "express";
import cors from "cors";
import { configDotenv } from "dotenv";
import path from "node:path";

configDotenv();

import { connectPool } from "./config/db.config.js";
import { Env } from "./config/env.config.js";

const app = express();

// middleware
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use(
  cors({
    origin: Env.FRONTEND_URL, 
    credentials: true,
  }),
);


// routes
app.get("/", (_req: Request, res: Response) => {
  res.json({
    message: "Ready to work on notification system"
  });
});

// server
const startServer = async () => {
  try {
    await connectPool();

    app.listen(Env.PORT, () => {
      console.log(`Server running at http://localhost:${Env.PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
