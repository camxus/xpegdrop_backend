import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import authRoutes from "./routes/authRoutes";
import projectRoutes from "./routes/projectRoutes";
import dropboxRoutes from "./routes/dropboxRoutes";
import usersRoutes from "./routes/usersRoutes";
import { APIGatewayProxyEvent } from "aws-lambda";
import { errorHandler } from "./middleware/errorMiddleware";
import serverless from "serverless-http";
import multipart from "lambda-multipart-parser";

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "",
      "http://xpegdrop.eba-enjhhiwz.eu-west-1.elasticbeanstalk.com",
    ],
    credentials: true,
  })
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/dropbox", dropboxRoutes);
app.use("/api/users", usersRoutes);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ message: "Server is running" });
});

// Error handling middleware
app.use(errorHandler);

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

export const handler = serverless(app, {
  request: async (req: Request, event: APIGatewayProxyEvent) => {
    let body = event.body;

    if (body) {
      // Decode base64
      if (event.isBase64Encoded) {
        body = Buffer.from(body, "base64").toString("utf8");
      }

      // If JSON content
      if (event.headers["content-type"]?.includes("application/json")) {
        try {
          body = JSON.parse(body);
        } catch {}
      }

      // If multipart/form-data
      if (event.headers["content-type"]?.includes("multipart/form-data")) {
        try {
          const parsed = await multipart.parse(event);
          body = parsed; // parsed.files and parsed.fields
        } catch (err) {
          console.error("Multipart parse error:", err);
        }
      }
    }

    // Assign to Express req.body
    (req as any).body = body;
  },
});
