import type { Adapter, AdapterUser } from "next-auth/adapters";
import type { PrismaClient } from "@/generated/prisma/client";

export function PrismaAdapter(prisma: PrismaClient): Adapter {
  return {
    async createUser(data) {
      const user = await prisma.user.create({
        data: { email: data.email, name: data.name, image: data.image },
      });
      return user as unknown as AdapterUser;
    },
    async getUser(id) {
      return prisma.user.findUnique({ where: { id } }) as any;
    },
    async getUserByEmail(email) {
      return prisma.user.findUnique({ where: { email } }) as any;
    },
    async getUserByAccount({ providerAccountId, provider }) {
      const account = await prisma.account.findUnique({
        where: { provider_providerAccountId: { provider, providerAccountId } },
        include: { user: true },
      });
      return (account?.user ?? null) as any;
    },
    async updateUser({ id, ...data }) {
      return prisma.user.update({ where: { id }, data }) as any;
    },
    async deleteUser(id) {
      await prisma.user.delete({ where: { id } });
    },
    async linkAccount(data) {
      await prisma.account.create({ data: data as any });
    },
    async unlinkAccount({ providerAccountId, provider }) {
      await prisma.account.delete({
        where: { provider_providerAccountId: { provider, providerAccountId } },
      });
    },
    async createSession(data) {
      return prisma.session.create({ data }) as any;
    },
    async getSessionAndUser(sessionToken) {
      const session = await prisma.session.findUnique({
        where: { sessionToken },
        include: { user: true },
      });
      if (!session) return null;
      const { user, ...rest } = session;
      return { session: rest, user } as any;
    },
    async updateSession(data) {
      return prisma.session.update({ where: { sessionToken: data.sessionToken }, data }) as any;
    },
    async deleteSession(sessionToken) {
      await prisma.session.delete({ where: { sessionToken } });
    },
  };
}
