import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import "./databases/mongodb";
import UserRoutes from "./modules/user/userRoutes";
import UserProtectedRoutes from "./modules/user/userProtectedRoutes";
import TransactionRoutes from "./modules/transaction/transactionRoutes";
import TransactionWebhookRoutes from "./modules/transaction/transactionWebhookRoutes";
import CategoryRoutes from "./modules/category/categoryRoutes";
import DashboardRoutes from "./modules/dashboard/dashboardRoutes";
import HubRoutes from "./modules/hub/hubRoutes";
import { logRouting } from "./middleware/logrouting";
import { logRequest } from "./middleware/logrequest";
import { validateToken } from "./middleware/validateToken";
import { cancelContextMiddleware } from "./middleware/cancelContext";
import Config from "./config";

dotenv.config();

const app = express();

// middlewares
app.use(cors());
app.use(express.json());
app.use(cancelContextMiddleware);

// log request
app.use(logRequest);

// routing logger
logRouting(app);

// public routes
app.use("/auth/v1", UserRoutes);
app.use("/api", TransactionWebhookRoutes);

// hub modular & mcp routes
app.use("/api/v1", HubRoutes);

// protected routes
app.use("/api/v1", validateToken, TransactionRoutes);
app.use("/api/v1", validateToken, CategoryRoutes);
app.use("/api/v1", validateToken, DashboardRoutes);
app.use("/api/v1", validateToken, UserProtectedRoutes);

// 404 handler
app.all("*", (req, res) => {
    res.status(404).json({ message: "Route not found" });
});

// start server
app.listen(Config.PORT, () => {
    console.log(`🚀 Express running on port ${Config.PORT}`);
});
