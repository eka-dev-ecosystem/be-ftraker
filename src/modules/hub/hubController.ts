import { Request, Response } from "express";
import mongoose from "mongoose";
import TransactionModel from "../transaction/transactionModel";
import CategoryModel from "../category/categoryModel";
import UserModel from "../user/userModel";
import { verifyJwt } from "../../utils/jwt";
import logger from "../../utils/logger";

export class HubController {
    /**
     * Resolves the user identity from JWT header or X-Hub-User-UID header.
     */
    private static resolveUser(req: Request): { userId: string | null; userEmail: string } {
        let userId = req.user?.id_user || null;
        let userEmail = req.user?.email || "user@ftracker.app";

        const authHeader = req.headers["authorization"];
        if (!userId && authHeader && authHeader.startsWith("Bearer ")) {
            const token = authHeader.split(" ")[1];
            try {
                const decoded = verifyJwt(token, true, "access");
                if (decoded && decoded.id_user) {
                    userId = String(decoded.id_user);
                    userEmail = decoded.email || userEmail;
                }
            } catch (err) {
                logger.warn("JWT verification skipped in HubController: " + (err as Error).message);
            }
        }

        if (!userId && req.headers["x-hub-user-uid"]) {
            userId = String(req.headers["x-hub-user-uid"]);
        }

        return { userId, userEmail };
    }

    /**
     * GET /api/v1/hub/summary
     * Modular life aggregator summary contract for Personal AI Hub.
     */
    static async getSummary(req: Request, res: Response): Promise<Response> {
        try {
            const { userId, userEmail } = HubController.resolveUser(req);
            if (!userId) {
                return res.status(401).json({
                    code: 401,
                    message: "Unauthorized: User context required for Hub summary",
                });
            }

            const now = new Date();
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
            const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

            const userObjId = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : null;

            let totalSpent = 0;
            let topCategoryName = "General";

            if (userObjId) {
                const spendingAgg = await TransactionModel.aggregate([
                    {
                        $match: {
                            user: userObjId,
                            type: { $regex: /^expense$/i },
                            $or: [
                                { date: { $gte: startOfMonth, $lte: endOfMonth } },
                                { date: { $exists: false }, createdAt: { $gte: startOfMonth, $lte: endOfMonth } },
                            ],
                        },
                    },
                    {
                        $group: {
                            _id: "$category",
                            total: { $sum: "$amount" },
                        },
                    },
                    { $sort: { total: -1 } },
                ]);

                if (spendingAgg && spendingAgg.length > 0) {
                    totalSpent = spendingAgg.reduce((acc, curr) => acc + curr.total, 0);
                    const topCatId = spendingAgg[0]._id;
                    if (topCatId) {
                        const cat = await CategoryModel.findById(topCatId);
                        if (cat && cat.name) {
                            topCategoryName = cat.name;
                        }
                    }
                }
            }

            const budgetLimit = 10000000; // standard monthly budget limit default
            const remainingBudget = Math.max(0, budgetLimit - totalSpent);
            const formattedSpent = `Rp ${totalSpent.toLocaleString("id-ID")}`;

            return res.status(200).json({
                app_id: "ftracker",
                app_name: "F-Tracker",
                connected_uid: userId,
                connected_email: userEmail,
                highlight_metric: formattedSpent,
                highlight_label: "Pengeluaran Bulan Ini",
                ai_context_data: {
                    monthly_spent: totalSpent,
                    budget_limit: budgetLimit,
                    remaining_budget: remainingBudget,
                    top_category: topCategoryName,
                    overbudget_warning: totalSpent > budgetLimit,
                },
                deep_link: `ftracker://expenses?category=all&expected_uid=${userId}`,
            });
        } catch (error) {
            logger.error("Error in HubController.getSummary", error);
            return res.status(500).json({
                code: 500,
                message: "Internal server error: " + (error as Error).message,
            });
        }
    }

    /**
     * POST /api/v1/hub/mcp
     * JSON-RPC 2.0 endpoint handling Model Context Protocol tool calls from Eka-Hub.
     */
    static async handleMCP(req: Request, res: Response): Promise<Response> {
        const { userId, userEmail } = HubController.resolveUser(req);
        const { id, method, params } = req.body || {};

        const baseResponse = {
            jsonrpc: "2.0",
            id: id || 1,
        };

        if (method === "initialize") {
            return res.json({
                ...baseResponse,
                result: {
                    protocolVersion: "2024-11-05",
                    serverInfo: {
                        name: "ftracker-mcp",
                        version: "1.0.0",
                    },
                    capabilities: {
                        tools: {},
                    },
                },
            });
        }

        if (method === "ping") {
            return res.json({ ...baseResponse, result: {} });
        }

        if (method === "tools/list") {
            return res.json({
                ...baseResponse,
                result: {
                    tools: [
                        {
                            name: "create_transaction",
                            description: "Record a new expense or income in F-Tracker finance app.",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    amount: { type: "number", description: "Numerical amount" },
                                    type: { type: "string", enum: ["expense", "income"], description: "Transaction type" },
                                    description: { type: "string", description: "Transaction notes/description" },
                                    category: { type: "string", description: "Category name" },
                                    date: { type: "string", description: "Date YYYY-MM-DD" },
                                },
                                required: ["amount", "type", "description"],
                            },
                        },
                        {
                            name: "list_transactions",
                            description: "List recent transactions in F-Tracker.",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    type: { type: "string", description: "expense, income, or all" },
                                    limit: { type: "number", description: "Limit results" },
                                },
                            },
                        },
                        {
                            name: "get_financial_summary",
                            description: "Get monthly spending, budget, and top categories.",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    month: { type: "string", description: "YYYY-MM" },
                                },
                            },
                        },
                    ],
                },
            });
        }

        if (method === "tools/call") {
            if (!userId) {
                return res.json({
                    ...baseResponse,
                    error: {
                        code: -32000,
                        message: "Unauthorized: Valid user token or X-Hub-User-UID required",
                    },
                });
            }

            const toolName = params?.name;
            const args = params?.arguments || {};

            try {
                const userObjId = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : null;
                if (!userObjId) {
                    throw new Error("Invalid User ID format");
                }

                if (toolName === "create_transaction") {
                    let amount = 0;
                    if (typeof args.amount === "number") {
                        amount = args.amount;
                    } else if (typeof args.amount === "string") {
                        const cleaned = args.amount.replace(/[^0-9.,]/g, "").replace(/\./g, "").replace(/,/g, ".");
                        amount = parseFloat(cleaned) || 0;
                    }

                    const rawType = String(args.type || "expense").toLowerCase().trim();
                    const transType = (rawType === "income" || rawType === "pemasukan") ? "Income" : "Expense";
                    const description = String(args.description || "Transaksi AI Hub").trim();
                    const categoryName = String(args.category || "General").trim();
                    
                    let dateVal = new Date();
                    if (args.date) {
                        const dStr = String(args.date).toLowerCase().trim();
                        if (dStr === "yesterday" || dStr === "kemarin") {
                            dateVal.setDate(dateVal.getDate() - 1);
                        } else if (dStr !== "today" && dStr !== "hari ini") {
                            const parsed = new Date(args.date);
                            if (!isNaN(parsed.getTime())) {
                                dateVal = parsed;
                            }
                        }
                    }

                    // Find or create category
                    let categoryId = null;
                    if (categoryName) {
                        let cat = await CategoryModel.findOne({
                            user: userObjId,
                            name: { $regex: new RegExp(`^${categoryName}$`, "i") },
                        });
                        if (!cat) {
                            cat = await CategoryModel.create({
                                user: userObjId,
                                name: categoryName,
                                type: transType.toLowerCase(),
                                color: transType === "Income" ? "#10b981" : "#ef4444",
                                icon: transType === "Income" ? "i-heroicons-arrow-down-left" : "i-heroicons-arrow-up-right",
                            });
                        }
                        categoryId = cat._id;
                    }

                    const newTrans = await TransactionModel.create({
                        user: userObjId,
                        amount,
                        type: transType,
                        description,
                        category: categoryId,
                        date: dateVal,
                    });

                    return res.json({
                        ...baseResponse,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({
                                        message: "Transaction created successfully",
                                        transaction: newTrans,
                                    }),
                                },
                            ],
                        },
                    });
                }

                if (toolName === "list_transactions") {
                    const limit = Math.min(Number(args.limit) || 10, 50);
                    const filter: Record<string, any> = { user: userObjId };
                    if (args.type && args.type !== "all") {
                        filter.type = new RegExp(`^${args.type}$`, "i");
                    }

                    if (args.date) {
                        const dateStr = String(args.date).toLowerCase();
                        let targetDate = new Date();
                        if (dateStr === "yesterday") {
                            targetDate.setDate(targetDate.getDate() - 1);
                        } else if (dateStr !== "today") {
                            targetDate = new Date(args.date);
                        }
                        const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
                        const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);
                        filter.$or = [
                            { date: { $gte: startOfDay, $lte: endOfDay } },
                            { date: { $exists: false }, createdAt: { $gte: startOfDay, $lte: endOfDay } }
                        ];
                    }

                    const items = await TransactionModel.find(filter)
                        .populate("category", "name color icon")
                        .sort({ date: -1, createdAt: -1 })
                        .limit(limit);

                    return res.json({
                        ...baseResponse,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({
                                        count: items.length,
                                        transactions: items,
                                    }),
                                },
                            ],
                        },
                    });
                }

                if (toolName === "get_financial_summary") {
                    const now = new Date();
                    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
                    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

                    const spendingAgg = await TransactionModel.aggregate([
                        {
                            $match: {
                                user: userObjId,
                                type: { $regex: /^expense$/i },
                                $or: [
                                    { date: { $gte: startOfMonth, $lte: endOfMonth } },
                                    { date: { $exists: false }, createdAt: { $gte: startOfMonth, $lte: endOfMonth } },
                                ],
                            },
                        },
                        {
                            $group: {
                                _id: null,
                                total: { $sum: "$amount" },
                            },
                        },
                    ]);

                    const totalSpent = spendingAgg.length > 0 ? spendingAgg[0].total : 0;
                    const budgetLimit = 10000000;

                    return res.json({
                        ...baseResponse,
                        result: {
                            content: [
                                {
                                    type: "text",
                                    text: JSON.stringify({
                                        monthly_spent: totalSpent,
                                        budget_limit: budgetLimit,
                                        remaining_budget: Math.max(0, budgetLimit - totalSpent),
                                        highlight_metric: `Rp ${totalSpent.toLocaleString("id-ID")}`,
                                    }),
                                },
                            ],
                        },
                    });
                }

                return res.json({
                    ...baseResponse,
                    error: {
                        code: -32601,
                        message: `Method or tool not found: ${toolName}`,
                    },
                });
            } catch (err) {
                return res.json({
                    ...baseResponse,
                    result: {
                        isError: true,
                        content: [
                            {
                                type: "text",
                                text: `Error executing tool ${toolName}: ${(err as Error).message}`,
                            },
                        ],
                    },
                });
            }
        }

        return res.json({
            ...baseResponse,
            error: {
                code: -32601,
                message: `Method not found: ${method}`,
            },
        });
    }
}

export default HubController;
