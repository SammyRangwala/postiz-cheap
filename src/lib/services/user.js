import { prisma } from "../prisma";
import config from "../config";

export const UserService = {
  async getCredits(userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true },
    });
    return user ? user.credits : 0;
  },

  async addCredits(userId, amount, { force = false } = {}) {
    if (amount <= 0 || (!config.credits.enabled && !force)) return;
    return await prisma.user.update({
      where: { id: userId },
      data: {
        credits: {
          increment: amount,
        },
      },
    });
  },

  async deductCredits(userId, amount) {
    if (amount <= 0 || !config.credits.enabled) return;
    
    // Check if the user has enough credits
    const currentCredits = await this.getCredits(userId);
    if (currentCredits < amount) {
      throw new Error("Insufficient credits available");
    }

    return await prisma.user.update({
      where: { id: userId },
      data: {
        credits: {
          decrement: amount,
        },
      },
    });
  },
};
