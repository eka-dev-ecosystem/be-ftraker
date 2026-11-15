import { Request, Response } from "express";
import mongoose from "mongoose";
import CategoryModel from "./categoryModel";
import { createCategorySchema, updateCategorySchema } from "./categorySchema";
import { validate } from "../../utils/validation";
import { ErrorResponse, SuccessResponse } from "../../utils/response";
import TransactionModel from "../transaction/transactionModel";

export const defaultCategories = [
    { name: "Makanan & Minuman", type: "expense", color: "#F43F5E", icon: "fastfood" },
    { name: "Transportasi", type: "expense", color: "#3B82F6", icon: "directions_car" },
    { name: "Belanja", type: "expense", color: "#8B5CF6", icon: "shopping_bag" },
    { name: "Tagihan & Utilitas", type: "expense", color: "#F59E0B", icon: "receipt_long" },
    { name: "Gaji & Pendapatan", type: "income", color: "#10B981", icon: "account_balance_wallet" },
    { name: "Investasi & Tabungan", type: "income", color: "#06B6D4", icon: "trending_up" },
    { name: "Bonus & Lain-lain", type: "income", color: "#6366F1", icon: "card_giftcard" },
];

class CategoryService {
    static async getCategories(req: Request, res: Response) {
        const user = req.user!;
        let categories = await CategoryModel.find({ user: user.id_user }).sort({ createdAt: -1 });

        // Auto-seed default categories if user has none
        if (categories.length === 0) {
            const seedDocs = defaultCategories.map(cat => ({
                ...cat,
                user: new mongoose.Types.ObjectId(user.id_user),
            }));
            categories = (await CategoryModel.insertMany(seedDocs as any)) as any;
        }

        return res.status(200).json(
            SuccessResponse(categories, "Categories retrieved successfully", 200)
        );
    }

    static async createCategory(req: Request, res: Response, session: mongoose.ClientSession) {
        validate(req.body, createCategorySchema);
        const user = req.user!;
        const { name, type, color, icon } = req.body;

        const category = new CategoryModel({
            user: user.id_user,
            name,
            type: type || null,
            color: color || "#10b981",
            icon: icon || "tag",
        });

        await category.save({ session });

        return res.status(201).json(
            SuccessResponse(category, "Category created successfully", 201)
        );
    }

    static async updateCategory(req: Request, res: Response, session: mongoose.ClientSession) {
        validate(req.body, updateCategorySchema);
        const { categoryId } = req.params;
        const user = req.user!;

        const category = await CategoryModel.findOne({ _id: categoryId, user: user.id_user });
        if (!category) {
            return res.status(404).json(ErrorResponse("Category not found", null, 404));
        }

        const { name, type, color, icon } = req.body;
        if (name !== undefined) category.name = name;
        if (type !== undefined) category.type = type;
        if (color !== undefined) category.color = color;
        if (icon !== undefined) category.icon = icon;

        await category.save({ session });

        return res.status(200).json(
            SuccessResponse(category, "Category updated successfully", 200)
        );
    }

    static async deleteCategory(req: Request, res: Response, session: mongoose.ClientSession) {
        const { categoryId } = req.params;
        const user = req.user!;

        const category = await CategoryModel.findOne(
            { _id: categoryId, user: user.id_user },
            null,
            { session }
        );

        if (!category) {
            return res.status(404).json(ErrorResponse("Category not found", null, 404));
        }

        const usedCount = await TransactionModel.countDocuments({
            user: user.id_user,
            category: categoryId,
        }).session(session);

        if (usedCount > 0) {
            return res.status(400).json(
                ErrorResponse(
                    `Cannot delete category "${category.name}": it is currently used by ${usedCount} transaction${usedCount > 1 ? "s" : ""}. Please reassign or delete those transactions first.`,
                    null,
                    400
                )
            );
        }

        await CategoryModel.deleteOne(
            { _id: categoryId, user: user.id_user },
            { session }
        );

        return res.status(200).json(
            SuccessResponse(null, "Category deleted successfully", 200)
        );
    }
}

export default CategoryService;
