import { Request, Response } from "express";
import logger from "../../utils/logger";
import { formatErrorValidation, validate } from "../../utils/validation";
import { createTransactionBodySchema, getTransactionQuerySchema, updateTransactionBodySchema, n8nWebhookBodySchema } from "./transactionSchema";
import { ErrorResponse, SuccessResponse } from "../../utils/response";
import TransactionModel from "./transactionModel";
import useSelectedViewPeriode from "../../utils/selectedViewPeriode";
import { fromZonedTime } from "date-fns-tz";
import { resolveUserTimezone } from "../../utils/timezone";
import { ZodError } from "zod";
import mongoose from "mongoose";
import { isRequestCancelled } from "../../middleware/cancelContext";


class TransactionService {

    private static buildFilter(query: any, userId: string, timezone: string = "UTC"): Record<string, any> {
        const { view = "All", type, category, search, startDate, endDate, year, month } = query;
        const filter: Record<string, any> = { user: userId };

        if (type && type !== "All") {
            filter.type = new RegExp(`^${type}$`, "i");
        }

        if (category && category !== "all") {
            filter.category = category;
        }

        if (query.linkedIncomeId) {
            filter.linkedIncomeId = query.linkedIncomeId;
        }

        if (search && String(search).trim()) {
            filter.description = { $regex: String(search).trim(), $options: "i" };
        }

        if (startDate && endDate) {
            const sStr = String(startDate).split("T")[0];
            const eStr = String(endDate).split("T")[0];
            const s = fromZonedTime(new Date(`${sStr}T00:00:00.000`), timezone);
            const e = fromZonedTime(new Date(`${eStr}T23:59:59.999`), timezone);
            filter.$or = [
                { date: { $gte: s, $lte: e } },
                { date: { $exists: false }, createdAt: { $gte: s, $lte: e } },
            ];
        } else if (year && month) {
            const y = parseInt(year);
            const m = parseInt(month) - 1;
            const startZoned = new Date(y, m, 1, 0, 0, 0, 0);
            const endZoned = new Date(y, m + 1, 0, 23, 59, 59, 999);
            const s = fromZonedTime(startZoned, timezone);
            const e = fromZonedTime(endZoned, timezone);
            filter.$or = [
                { date: { $gte: s, $lte: e } },
                { date: { $exists: false }, createdAt: { $gte: s, $lte: e } },
            ];
        } else if (year && !month) {
            const y = parseInt(year);
            const startZoned = new Date(y, 0, 1, 0, 0, 0, 0);
            const endZoned = new Date(y, 11, 31, 23, 59, 59, 999);
            const s = fromZonedTime(startZoned, timezone);
            const e = fromZonedTime(endZoned, timezone);
            filter.$or = [
                { date: { $gte: s, $lte: e } },
                { date: { $exists: false }, createdAt: { $gte: s, $lte: e } },
            ];
        } else if (view && view !== "All" && view !== "Custom") {
            const { currentPeriode } = useSelectedViewPeriode(view, timezone);
            const period = currentPeriode();
            if (period.start && period.end) {
                filter.$or = [
                    { date: { $gte: period.start, $lte: period.end } },
                    { date: { $exists: false }, createdAt: { $gte: period.start, $lte: period.end } },
                ];
            }
        }

        return filter;
    }

    static async getTransactions(req: Request, res: Response) {
        try {
            if (isRequestCancelled(req, res)) return;

            validate(req.query, getTransactionQuerySchema);

            const user = req.user!;
            const timezone = await resolveUserTimezone(req, user.id_user);
            const filter = TransactionService.buildFilter(req.query, user.id_user, timezone);
            const { sort = "newest", limit, page, offset } = req.query as any;

            let sortOptions: Record<string, any> = { date: -1, createdAt: -1, _id: -1 };
            if (sort === "oldest") {
                sortOptions = { date: 1, createdAt: 1, _id: 1 };
            } else if (sort === "highest") {
                sortOptions = { amount: -1, date: -1, createdAt: -1, _id: -1 };
            } else if (sort === "lowest") {
                sortOptions = { amount: 1, date: 1, createdAt: 1, _id: 1 };
            }

            const isPaginated = limit !== undefined || page !== undefined || offset !== undefined;

            if (isPaginated) {
                const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));
                let skip = 0;
                let pageNum = 1;

                if (offset !== undefined) {
                    skip = Math.max(0, parseInt(offset) || 0);
                    pageNum = Math.floor(skip / limitNum) + 1;
                } else if (page !== undefined) {
                    pageNum = Math.max(1, parseInt(page) || 1);
                    skip = (pageNum - 1) * limitNum;
                }

                if (isRequestCancelled(req, res)) return;

                const total = await TransactionModel.countDocuments(filter);
                const totalPages = Math.ceil(total / limitNum);
                const hasMore = skip + limitNum < total;

                if (isRequestCancelled(req, res)) return;

                const rawTransactions = await TransactionModel
                    .find(filter)
                    .populate("category")
                    .populate("linkedIncomeId", "description amount date type")
                    .sort(sortOptions as any)
                    .skip(skip)
                    .limit(limitNum)
                    .lean();

                if (isRequestCancelled(req, res)) return;

                const transactions = rawTransactions.map((t: any) => ({
                    ...t,
                    date: t.date || t.createdAt,
                }));

                return res.status(200).json(SuccessResponse({
                    items: transactions,
                    pagination: {
                        page: pageNum,
                        limit: limitNum,
                        offset: skip,
                        total,
                        totalPages,
                        hasMore,
                    },
                }, "Transactions retrieved successfully", 200));
            }

            if (isRequestCancelled(req, res)) return;

            const rawTransactions = await TransactionModel
                .find(filter)
                .populate("category")
                .populate("linkedIncomeId", "description amount date type")
                .sort(sortOptions as any)
                .lean();

            if (isRequestCancelled(req, res)) return;

            const transactions = rawTransactions.map((t: any) => ({
                ...t,
                date: t.date || t.createdAt,
            }));

            return res.status(200).json(SuccessResponse(transactions, "Transactions retrieved successfully", 200));

        } catch (error) {
            if (isRequestCancelled(req, res) || (error as any)?.name === "AbortError") {
                logger.info(`[CancelContext] getTransactions cancelled by client (${req.method} ${req.originalUrl})`);
                return;
            }

            logger.error(error);

            if (error instanceof ZodError) {
                const message = formatErrorValidation(error);
                return res.status(400).json(ErrorResponse("Validation error", message, 400));
            }

            return res.status(500).json(ErrorResponse("Internal server error", (error as Error).message, 500));
        }
    }

    static async getTransactionById(req: Request, res: Response) {
        const { transactionId } = req.params;
        const user = req.user!;

        const transaction = await TransactionModel
            .findOne({ _id: transactionId, user: user.id_user })
            .populate("category")
            .populate("linkedIncomeId", "description amount date type")
            .lean();

        if (!transaction) {
            return res.status(404).json(ErrorResponse("Not Found", "Transaction not found", 404));
        }

        let extraDetails: Record<string, any> = {};
        if (transaction.type?.toLowerCase() === "income") {
            const linkedExpenses = await TransactionModel.find({
                linkedIncomeId: transaction._id,
                user: user.id_user,
            })
                .populate("category")
                .sort({ date: -1, createdAt: -1 })
                .lean();

            const totalLinkedExpense = linkedExpenses.reduce((sum, item: any) => sum + (item.amount || 0), 0);
            const remainingAmount = transaction.amount - totalLinkedExpense;
            const percentageUsed = transaction.amount > 0 ? (totalLinkedExpense / transaction.amount) * 100 : 0;

            extraDetails = {
                linkedExpenses: linkedExpenses.map((e: any) => ({
                    ...e,
                    date: e.date || e.createdAt,
                })),
                totalLinkedExpense,
                totalUsed: totalLinkedExpense,
                remainingAmount,
                expenseCount: linkedExpenses.length,
                percentageUsed: Number(percentageUsed.toFixed(1)),
            };
        } else if (transaction.linkedIncomeId) {
            const incomeDoc: any = transaction.linkedIncomeId;
            if (incomeDoc && incomeDoc._id) {
                const siblingExpenses = await TransactionModel.find({
                    linkedIncomeId: incomeDoc._id,
                    user: user.id_user,
                }).lean();

                const totalUsedOnIncome = siblingExpenses.reduce((sum, item: any) => sum + (item.amount || 0), 0);
                const remainingOnIncome = (incomeDoc.amount || 0) - totalUsedOnIncome;
                const percentageUsedOnIncome = (incomeDoc.amount || 0) > 0 ? (totalUsedOnIncome / incomeDoc.amount) * 100 : 0;

                extraDetails = {
                    linkedIncomeDetails: {
                        _id: incomeDoc._id,
                        description: incomeDoc.description,
                        amount: incomeDoc.amount,
                        date: incomeDoc.date || incomeDoc.createdAt,
                        totalUsed: totalUsedOnIncome,
                        remainingAmount: remainingOnIncome,
                        expenseCount: siblingExpenses.length,
                        percentageUsed: Number(percentageUsedOnIncome.toFixed(1)),
                    },
                };
            }
        }

        return res.status(200).json(SuccessResponse({
            ...transaction,
            date: (transaction as any).date || (transaction as any).createdAt,
            ...extraDetails,
        }, "Transaction retrieved successfully", 200));
    }

    static async getAvailableIncomes(req: Request, res: Response) {
        try {
            const user = req.user!;
            const { page = "1", limit = "10", search = "" } = req.query as any;
            const pageNum = Math.max(1, parseInt(page) || 1);
            const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 10));
            const skip = (pageNum - 1) * limitNum;

            const filter: Record<string, any> = {
                user: user.id_user,
                type: { $regex: /^income$/i },
            };

            if (search && String(search).trim()) {
                filter.description = { $regex: String(search).trim(), $options: "i" };
            }

            const total = await TransactionModel.countDocuments(filter);
            const totalPages = Math.ceil(total / limitNum);
            const hasMore = pageNum < totalPages;

            const incomes = await TransactionModel.find(filter)
                .populate("category")
                .sort({ date: -1, createdAt: -1, _id: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean();

            const incomeIds = incomes.map((inc) => inc._id);
            const expenseAggregations = await TransactionModel.aggregate([
                {
                    $match: {
                        user: new mongoose.Types.ObjectId(user.id_user),
                        linkedIncomeId: { $in: incomeIds },
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

            const expenseMap = new Map<string, { totalUsed: number; count: number }>();
            for (const item of expenseAggregations) {
                expenseMap.set(String(item._id), {
                    totalUsed: item.totalUsed || 0,
                    count: item.count || 0,
                });
            }

            const result = incomes.map((inc: any) => {
                const usage = expenseMap.get(String(inc._id)) || { totalUsed: 0, count: 0 };
                const remaining = inc.amount - usage.totalUsed;
                const percentage = inc.amount > 0 ? (usage.totalUsed / inc.amount) * 100 : 0;

                return {
                    ...inc,
                    date: inc.date || inc.createdAt,
                    totalUsed: usage.totalUsed,
                    remainingAmount: remaining,
                    expenseCount: usage.count,
                    percentageUsed: Number(percentage.toFixed(1)),
                };
            });

            return res.status(200).json(SuccessResponse({
                incomes: result,
                pagination: {
                    page: pageNum,
                    limit: limitNum,
                    total,
                    totalPages,
                    hasMore,
                },
            }, "Available incomes retrieved successfully", 200));
        } catch (error) {
            logger.error(error);
            return res.status(500).json(ErrorResponse("Internal server error", (error as Error).message, 500));
        }
    }

    static async createTransaction(req: Request, res: Response, session: mongoose.ClientSession) {
        validate(req.body, createTransactionBodySchema);

        const { amount, type, description, category, date, createdAt, linkedIncomeId } = req.body;
        const user = req.user!;

        const normalizedType = type.toLowerCase() === "income" ? "Income" : "Expense";

        // Validate linkedIncomeId if provided
        let validLinkedIncomeId: any = null;
        if (linkedIncomeId && normalizedType === "Expense") {
            const parentIncome = await TransactionModel.findOne({
                _id: linkedIncomeId,
                user: user.id_user,
                type: { $regex: /^income$/i },
            }).session(session);

            if (!parentIncome) {
                return res.status(400).json(ErrorResponse("Validation error", "The specified linked income does not exist or is not an Income transaction", 400));
            }
            validLinkedIncomeId = parentIncome._id;
        }

        // Real transaction date (when the transaction occurred)
        const transactionDate = date
            ? new Date(date)
            : (createdAt ? new Date(createdAt) : new Date());

        const transaction = new TransactionModel({
            user: user.id_user,
            amount,
            type: normalizedType,
            description,
            category: category || null,
            linkedIncomeId: validLinkedIncomeId,
            date: transactionDate,
        });

        await transaction.save({ session });
        await transaction.populate("category");
        if (validLinkedIncomeId) {
            await transaction.populate("linkedIncomeId", "description amount date type");
        }

        const responseData = {
            ...transaction.toObject(),
            date: transaction.date || transaction.createdAt,
        };

        return res.status(201).json(SuccessResponse(responseData, "Transaction created successfully", 201));
    }

    static async updateTransaction(req: Request, res: Response, session: mongoose.ClientSession) {
        validate(req.body, updateTransactionBodySchema);

        const { amount, type, description, category, date, createdAt, linkedIncomeId } = req.body;
        const { transactionId } = req.params;
        const user = req.user!;

        const transaction = await TransactionModel.findOne({ _id: transactionId, user: user.id_user }).session(session);

        if (!transaction) {
            return res.status(404).json(ErrorResponse("Not Found", "Transaction not found", 404));
        }

        const previousType = transaction.type;
        const newType = type ? (type.toLowerCase() === "income" ? "Income" : "Expense") : previousType;

        // EDGE CASE 1: Income diubah jadi Expense
        if (previousType?.toLowerCase() === "income" && newType?.toLowerCase() === "expense") {
            // Unlink all child expenses referencing this transaction
            await TransactionModel.updateMany(
                { linkedIncomeId: transaction._id },
                { $unset: { linkedIncomeId: "" } },
                { session }
            );
            transaction.linkedIncomeId = undefined;
        }

        // EDGE CASE 2: Expense diubah jadi Income
        else if (previousType?.toLowerCase() === "expense" && newType?.toLowerCase() === "income") {
            // Income cannot be funded by another income
            transaction.linkedIncomeId = undefined;
        }

        // Handle linkedIncomeId update if currently an Expense
        if (newType?.toLowerCase() === "expense" && linkedIncomeId !== undefined) {
            if (!linkedIncomeId) {
                transaction.linkedIncomeId = undefined;
            } else {
                if (String(linkedIncomeId) === String(transaction._id)) {
                    return res.status(400).json(ErrorResponse("Validation error", "Transaction cannot link to itself", 400));
                }
                const parentIncome = await TransactionModel.findOne({
                    _id: linkedIncomeId,
                    user: user.id_user,
                    type: { $regex: /^income$/i },
                }).session(session);

                if (!parentIncome) {
                    return res.status(400).json(ErrorResponse("Validation error", "The specified linked income does not exist or is not an Income transaction", 400));
                }
                transaction.linkedIncomeId = parentIncome._id as any;
            }
        }

        if (amount !== undefined) transaction.amount = amount;
        if (type !== undefined) transaction.type = newType;
        if (description !== undefined) transaction.description = description;
        if (category !== undefined) transaction.category = category;
        if (date !== undefined) transaction.date = new Date(date);
        else if (createdAt !== undefined) transaction.date = new Date(createdAt);

        await transaction.save({ session });
        await transaction.populate("category");
        if (transaction.linkedIncomeId) {
            await transaction.populate("linkedIncomeId", "description amount date type");
        }

        const responseData = {
            ...transaction.toObject(),
            date: transaction.date || transaction.createdAt,
        };

        return res.status(200).json(SuccessResponse(responseData, "Transaction updated successfully", 200));
    }

    static async deleteTransaction(req: Request, res: Response, session: mongoose.ClientSession) {
        const { transactionId } = req.params;
        const user = req.user!;

        const transaction = await TransactionModel.findOneAndDelete(
            { _id: transactionId, user: user.id_user },
            { session }
        );

        if (!transaction) {
            return res.status(404).json(ErrorResponse("Not Found", "Transaction not found", 404));
        }

        // EDGE CASE 3: If deleted transaction is an Income, unlink all child expenses
        if (transaction.type?.toLowerCase() === "income") {
            await TransactionModel.updateMany(
                { linkedIncomeId: transactionId },
                { $unset: { linkedIncomeId: "" } },
                { session }
            );
        }

        return res.status(200).json(SuccessResponse(null, "Transaction deleted successfully", 200));
    }

    static async getTransactionSummary(req: Request, res: Response) {
        try {
            if (isRequestCancelled(req, res)) return;

            const user = req.user!;
            const timezone = await resolveUserTimezone(req, user.id_user);
            const filter = TransactionService.buildFilter(req.query, user.id_user, timezone);

            if (isRequestCancelled(req, res)) return;

            const transactions = await TransactionModel.find(filter).lean();

            if (isRequestCancelled(req, res)) return;

            let incomeTotal = 0;
            let expenseTotal = 0;

            for (const t of transactions) {
                const isIncome = t.type?.toLowerCase() === "income";
                if (isIncome) {
                    incomeTotal += t.amount;
                } else {
                    expenseTotal += t.amount;
                }
            }

            const balance = incomeTotal - expenseTotal;
            const totalCount = transactions.length;

            return res.status(200).json(SuccessResponse({
                totalCount,
                transactionCount: totalCount,
                incomeTotal,
                expenseTotal,
                balance,
            }, "Transaction summary retrieved successfully", 200));
        } catch (error) {
            if (isRequestCancelled(req, res) || (error as any)?.name === "AbortError") {
                logger.info(`[CancelContext] getTransactionSummary cancelled by client (${req.method} ${req.originalUrl})`);
                return;
            }
            logger.error(error);
            return res.status(500).json(ErrorResponse("Internal server error", (error as Error).message, 500));
        }
    }

    static async getCalendarTransactions(req: Request, res: Response) {
        try {
            if (isRequestCancelled(req, res)) return;

            const user = req.user!;
            const timezone = await resolveUserTimezone(req, user.id_user);
            const { from, to, startDate, endDate, type, category, search, sort = "newest" } = req.query as any;

            const filter: Record<string, any> = { user: user.id_user };

            if (type && type !== "All") {
                filter.type = new RegExp(`^${type}$`, "i");
            }

            if (category && category !== "all") {
                filter.category = category;
            }

            if (search && String(search).trim()) {
                filter.description = { $regex: String(search).trim(), $options: "i" };
            }

            const rawFrom = from || startDate;
            const rawTo = to || endDate;

            if (rawFrom && rawTo) {
                const sStr = String(rawFrom).split("T")[0];
                const eStr = String(rawTo).split("T")[0];
                const s = fromZonedTime(new Date(`${sStr}T00:00:00.000`), timezone);
                const e = fromZonedTime(new Date(`${eStr}T23:59:59.999`), timezone);
                filter.$or = [
                    { date: { $gte: s, $lte: e } },
                    { date: { $exists: false }, createdAt: { $gte: s, $lte: e } },
                ];
            }

            let sortOptions: Record<string, any> = { date: -1, createdAt: -1, _id: -1 };
            if (sort === "oldest") {
                sortOptions = { date: 1, createdAt: 1, _id: 1 };
            } else if (sort === "highest") {
                sortOptions = { amount: -1, date: -1, createdAt: -1, _id: -1 };
            } else if (sort === "lowest") {
                sortOptions = { amount: 1, date: 1, createdAt: 1, _id: 1 };
            }

            if (isRequestCancelled(req, res)) return;

            const rawTransactions = await TransactionModel
                .find(filter)
                .populate("category")
                .populate("linkedIncomeId", "description amount date type")
                .sort(sortOptions as any)
                .lean();

            if (isRequestCancelled(req, res)) return;

            const transactions = rawTransactions.map((t: any) => ({
                ...t,
                date: t.date || t.createdAt,
            }));

            let totalIncome = 0;
            let totalExpense = 0;
            for (const t of transactions) {
                if (String(t.type || "").toLowerCase() === "income") {
                    totalIncome += t.amount || 0;
                } else {
                    totalExpense += t.amount || 0;
                }
            }

            return res.status(200).json(SuccessResponse({
                items: transactions,
                total: transactions.length,
                from: rawFrom,
                to: rawTo,
                summary: {
                    totalIncome,
                    totalExpense,
                    balance: totalIncome - totalExpense,
                    count: transactions.length,
                },
            }, "Calendar transactions retrieved successfully", 200));
        } catch (error) {
            if (isRequestCancelled(req, res) || (error as any)?.name === "AbortError") {
                logger.info(`[CancelContext] getCalendarTransactions cancelled by client (${req.method} ${req.originalUrl})`);
                return;
            }
            logger.error(error);
            return res.status(500).json(ErrorResponse("Internal server error", (error as Error).message, 500));
        }
    }

    static async handleN8nWebhook(req: Request, res: Response, session: mongoose.ClientSession) {
        try {
            validate(req.body, n8nWebhookBodySchema);

            const { amount, type, description, category, date, createdAt, user } = req.body;
            const transactionDate = date
                ? new Date(date)
                : (createdAt ? new Date(createdAt) : new Date());

            const transaction = new TransactionModel({
                user,
                amount,
                type,
                description,
                category: category || null,
                date: transactionDate,
            });

            await transaction.save({ session });

            logger.info(`N8N Webhook: Transaction created`, {
                transactionId: transaction._id,
                amount,
                type,
                description,
                date: transaction.date,
                createdAt: transaction.createdAt,
                user
            });

            return res.status(201).json(SuccessResponse({
                transactionId: transaction._id,
                status: "success",
                message: "Transaction created from webhook"
            }, "Webhook transaction created successfully", 201));

        } catch (error) {
            logger.error("N8N Webhook Error", error);

            if (error instanceof ZodError) {
                const message = formatErrorValidation(error);
                return res.status(400).json(ErrorResponse("Validation error", message, 400));
            }

            return res.status(500).json(ErrorResponse("Internal server error", (error as Error).message, 500));
        }
    }
}

export default TransactionService;
