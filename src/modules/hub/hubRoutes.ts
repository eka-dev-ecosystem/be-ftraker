import { Router } from "express";
import HubController from "./hubController";

const router = Router();

// Hub Standard Summary Endpoint (Contract: GET /api/v1/hub/summary)
router.get("/hub/summary", HubController.getSummary);

// Hub MCP Tool Calling Endpoint (JSON-RPC 2.0: POST /api/v1/hub/mcp)
router.post("/hub/mcp", HubController.handleMCP);

export default router;
