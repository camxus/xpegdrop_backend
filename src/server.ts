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
  request: (_: Request, event: APIGatewayProxyEvent) => {
    console.log("EVENT", event.body, event)
    if (event.isBase64Encoded && event.body) {
      event.body = Buffer.from(event.body, "base64").toString("utf8");
    }
  },
});
