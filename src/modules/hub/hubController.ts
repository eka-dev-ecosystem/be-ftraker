import { Request, Response } from "express";
import mongoose from "mongoose";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import TransactionModel from "../transaction/transactionModel";
import CategoryModel from "../category/categoryModel";
import UserModel from "../user/userModel";
import { verifyJwt } from "../../utils/jwt";
import logger from "../../utils/logger";
import { resolveUserTimezone } from "../../utils/timezone";
import { defaultCategories } from "../category/categoryService";

export class HubController {
    /**
     * Resolves matching category by semantic synonyms (e.g. "Food and Drink" <-> "Makanan & Minuman").
     */
    public static matchCategorySynonyms(userCategories: any[], target: string): any | null {
        if (!target) return null;
        const t = target.toLowerCase();
        const synonymGroups = [
            ["makan", "minum", "food", "drink", "beverage", "kopi", "coffee", "kuliner", "culinary", "cafe", "restaurant", "resto", "snack"],
            ["transport", "trans", "bensin", "fuel", "gas", "ojol", "grab", "gojek", "parkir", "parking", "tol", "toll", "travel"],
            ["belanja", "shop", "shopping", "grocer", "retail", "mart", "pasar", "supermarket"],
            ["tagihan", "util", "bill", "listrik", "pln", "air", "pdam", "wifi", "internet", "pulsa", "kuota", "langganan", "subscription"],
            ["gaji", "salary", "upah", "payroll", "honor", "income", "pendapatan"],
            ["invest", "investasi", "saham", "crypto", "reksadana", "tabungan", "saving", "deposito"],
            ["bonus", "hadiah", "gift", "thr", "lain", "other", "extra"],
        ];

        const matchedGroup = synonymGroups.find(group => group.some(kw => t.includes(kw)));
        if (!matchedGroup) return null;

        return userCategories.find(c => {
            const catName = (c.name || "").toLowerCase();
            return matchedGroup.some(kw => catName.includes(kw));
        }) || null;
    }

    /**
     * Intelligently infers transaction category from description and input hints.
     */
    public static inferCategory(description: string, rawCategory?: string, transType: string = "Expense"): string {
        const rawCat = (rawCategory || "").trim();
        if (rawCat && !["general", "other", "lainnya", "default", "none", "null"].includes(rawCat.toLowerCase())) {
            const catLower = rawCat.toLowerCase();
            if (catLower.includes("makan") || catLower.includes("minum") || catLower.includes("food") || catLower.includes("beverage") || catLower.includes("kopi") || catLower.includes("coffee")) {
                return "Makanan & Minuman";
            }
            if (catLower.includes("trans") || catLower.includes("bensin") || catLower.includes("fuel") || catLower.includes("ojol") || catLower.includes("parkir")) {
                return "Transportasi";
            }
            if (catLower.includes("belanja") || catLower.includes("shop") || catLower.includes("grocer")) {
                return "Belanja";
            }
            if (catLower.includes("tagihan") || catLower.includes("util") || catLower.includes("bill") || catLower.includes("listrik") || catLower.includes("pulsa")) {
                return "Tagihan & Utilitas";
            }
            if (catLower.includes("gaji") || catLower.includes("salary") || catLower.includes("upah")) {
                return "Gaji & Pendapatan";
            }
            if (catLower.includes("invest") || catLower.includes("saham") || catLower.includes("tabung")) {
                return "Investasi & Tabungan";
            }
            if (catLower.includes("bonus") || catLower.includes("hadiah") || catLower.includes("thr")) {
                return "Bonus & Lain-lain";
            }
            return rawCat;
        }

        const text = description.toLowerCase();
        if (transType === "Expense") {
            if (/kopi|coffee|makan|minum|food|drink|cafe|kafe|resto|warung|snack|sarapan|lunch|dinner|kuliner|bakso|mie|ayam|nasi|teh|jus|boba|roti|burger|pizza/i.test(text)) {
                return "Makanan & Minuman";
            }
            if (/bensin|bbm|spbu|pertamax|pertalite|solar|ojol|gojek|grab|maxim|parkir|tol|transport|kereta|mrt|bus|angkot|taxi|taksi|travel|servis|bengkel|kendaraan/i.test(text)) {
                return "Transportasi";
            }
            if (/belanja|shopping|indomaret|alfamart|supermarket|baju|pakaian|celana|sepatu|toserba|pasar|mall|toko|beli/i.test(text)) {
                return "Belanja";
            }
            if (/listrik|pln|air|pdam|wifi|internet|indihome|pulsa|kuota|tagihan|sewa|iuran|bpjs|asuransi|langganan|netflix|spotify/i.test(text)) {
                return "Tagihan & Utilitas";
            }
            return "Makanan & Minuman";
        } else {
            if (/gaji|salary|upah|payroll|honor|pendapatan/i.test(text)) {
                return "Gaji & Pendapatan";
            }
            if (/investasi|dividen|saham|crypto|reksadana|tabungan|bunga/i.test(text)) {
                return "Investasi & Tabungan";
            }
            return "Bonus & Lain-lain";
        }
    }
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

            let availableCategories: string[] = [];
            let activeIncomes: Array<{ id: string; description: string; amount: number; remaining_amount: number; date: string }> = [];

            if (userObjId) {
                const cats = await CategoryModel.find({ user: userObjId }).select("name");
                availableCategories = cats.map(c => c.name);

                // Fetch recent/active incomes with remaining amounts so Hub AI knows available sources of funds
                const recentIncomes = await TransactionModel.find({
                    user: userObjId,
                    type: { $regex: /^income$/i },
                })
                    .sort({ date: -1, createdAt: -1 })
                    .limit(10)
                    .lean();

                if (recentIncomes.length > 0) {
                    const incIds = recentIncomes.map(i => i._id);
                    const expenseAggs = await TransactionModel.aggregate([
                        {
                            $match: {
                                user: userObjId,
                                linkedIncomeId: { $in: incIds },
                                type: { $regex: /^expense$/i },
                            },
                        },
                        {
                            $group: {
                                _id: "$linkedIncomeId",
                                totalUsed: { $sum: "$amount" },
                                count: { $sum: 1 },
                            },
                        },
                    ]);

                    const expMap = new Map<string, number>();
                    for (const agg of expenseAggs) {
                        expMap.set(String(agg._id), agg.totalUsed || 0);
                    }

                    activeIncomes = recentIncomes.map((inc: any) => {
                        const used = expMap.get(String(inc._id)) || 0;
                        const remaining = (inc.amount || 0) - used;
                        const dateStr = inc.date
                            ? (inc.date instanceof Date ? inc.date.toISOString().split("T")[0] : String(inc.date).split("T")[0])
                            : (inc.createdAt ? String(inc.createdAt).split("T")[0] : "");

                        return {
                            id: String(inc._id),
                            description: inc.description,
                            amount: inc.amount,
                            remaining_amount: remaining,
                            date: dateStr,
                        };
                    });
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
                    available_categories: availableCategories,
                    active_incomes: activeIncomes,
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
                                    linked_income_id: { type: "string", description: "Optional ObjectId of the Income transaction this expense is deducted from (use matching ID from active_incomes)" },
                                    source_income: { type: "string", description: "Optional name/keyword of the income source to deduct from (e.g. 'gaji', 'freelance'). If linked_income_id is not given, will search for a matching active income by description" },
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

                    // Timezone resolution
                    const userTimezone = await resolveUserTimezone(req, userId);
                    const now = new Date();
                    const userZonedNow = toZonedTime(now, userTimezone);

                    let dateVal: Date = now;
                    if (args.date) {
                        const dStr = String(args.date).toLowerCase().trim();
                        if (dStr === "yesterday" || dStr === "kemarin") {
                            const yesterdayZoned = new Date(userZonedNow);
                            yesterdayZoned.setDate(yesterdayZoned.getDate() - 1);
                            dateVal = fromZonedTime(yesterdayZoned, userTimezone);
                        } else if (dStr === "today" || dStr === "hari ini") {
                            dateVal = now;
                        } else {
                            const matchYmd = String(args.date).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
                            if (matchYmd) {
                                const year = parseInt(matchYmd[1]);
                                const month = parseInt(matchYmd[2]) - 1;
                                const day = parseInt(matchYmd[3]);
                                const constructedZoned = new Date(year, month, day, userZonedNow.getHours(), userZonedNow.getMinutes(), userZonedNow.getSeconds());
                                dateVal = fromZonedTime(constructedZoned, userTimezone);
                            } else {
                                const parsed = new Date(args.date);
                                if (!isNaN(parsed.getTime())) {
                                    dateVal = parsed;
                                }
                            }
                        }
                    }

                    // Smart Category Resolution
                    const resolvedCatName = HubController.inferCategory(description, args.category, transType);
                    let categoryId: mongoose.Types.ObjectId | null = null;

                    let cat = await CategoryModel.findOne({
                        user: userObjId,
                        name: { $regex: new RegExp(`^${resolvedCatName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, "i") },
                    });

                    if (!cat) {
                        const userCategories = await CategoryModel.find({ user: userObjId });
                        if (userCategories.length > 0) {
                            cat = userCategories.find(c =>
                                c.name.toLowerCase().includes(resolvedCatName.toLowerCase()) ||
                                resolvedCatName.toLowerCase().includes(c.name.toLowerCase())
                            ) || null;

                            // Bilingual & Semantic Synonym Match (e.g. "Food and Drink" <-> "Makanan & Minuman")
                            if (!cat) {
                                cat = HubController.matchCategorySynonyms(userCategories, resolvedCatName) ||
                                      HubController.matchCategorySynonyms(userCategories, args.category || description);
                            }
                        }
                    }

                    if (!cat) {
                        const defaultCatMeta = defaultCategories.find(c =>
                            c.name.toLowerCase() === resolvedCatName.toLowerCase()
                        ) || {
                            name: resolvedCatName,
                            type: transType.toLowerCase(),
                            color: transType === "Income" ? "#10B981" : "#F43F5E",
                            icon: transType === "Income" ? "account_balance_wallet" : (resolvedCatName === "Makanan & Minuman" ? "fastfood" : "tag"),
                        };

                        cat = await CategoryModel.create({
                            user: userObjId,
                            name: defaultCatMeta.name,
                            type: defaultCatMeta.type || transType.toLowerCase(),
                            color: defaultCatMeta.color || (transType === "Income" ? "#10B981" : "#F43F5E"),
                            icon: defaultCatMeta.icon || "tag",
                        });
                    }

                    if (cat) {
                        categoryId = cat._id as mongoose.Types.ObjectId;
                    }

                    // Resolve linked income if this is an Expense
                    let linkedIncomeId: mongoose.Types.ObjectId | null = null;
                    if (transType === "Expense") {
                        const rawIncomeId = args.linked_income_id || args.linkedIncomeId;
                        if (rawIncomeId && mongoose.isValidObjectId(rawIncomeId)) {
                            const incDoc = await TransactionModel.findOne({
                                _id: new mongoose.Types.ObjectId(rawIncomeId),
                                user: userObjId,
                                type: { $regex: /^income$/i },
                            });
                            if (incDoc) {
                                linkedIncomeId = incDoc._id as mongoose.Types.ObjectId;
                            }
                        } else if (args.source_income || args.linked_income_name) {
                            const sourceQuery = String(args.source_income || args.linked_income_name).trim();
                            const incDoc = await TransactionModel.findOne({
                                user: userObjId,
                                type: { $regex: /^income$/i },
                                description: { $regex: sourceQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: "i" },
                            }).sort({ date: -1, createdAt: -1 });
                            if (incDoc) {
                                linkedIncomeId = incDoc._id as mongoose.Types.ObjectId;
                            }
                        }
                    }

                    const newTrans = await TransactionModel.create({
                        user: userObjId,
                        amount,
                        type: transType,
                        description,
                        category: categoryId,
                        date: dateVal,
                        ...(linkedIncomeId ? { linkedIncomeId } : {}),
                    });

                    await newTrans.populate("category");
                    if (linkedIncomeId) {
                        await newTrans.populate("linkedIncomeId", "description amount date type");
                    }

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
                        .populate("linkedIncomeId", "description amount date type")
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
