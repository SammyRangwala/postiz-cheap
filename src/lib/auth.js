import { PrismaAdapter } from "@next-auth/prisma-adapter";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "./prisma";

export const authOptions = {
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "jwt",
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
    // The demo login accepts ANY email with no password, so anyone could sign
    // in as anyone. It is only switched on when ENABLE_DEMO_LOGIN=true.
    ...(process.env.ENABLE_DEMO_LOGIN === "true" ? [CredentialsProvider({
      name: "Demo / Admin Account",
      credentials: {
        email: { label: "Email", type: "email", placeholder: "demo@creator.local" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase() || "demo@creator.local";
        const name = email.split("@")[0].toUpperCase();

        try {
          // Attempt to find or create in DB if database is connected
          let user = await prisma.user.findUnique({ where: { email } });
          if (!user) {
            user = await prisma.user.create({
              data: {
                email,
                name,
                credits: 50,
              },
            });
          }
          return {
            id: user.id,
            name: user.name,
            email: user.email,
            credits: user.credits,
          };
        } catch (dbError) {
          console.warn("[AUTH_DB_FALLBACK] Database offline or unreachable, using local session user:", dbError.message);
          // Resilient fallback so users can always test and preview the application
          return {
            id: "demo-user-" + Buffer.from(email).toString("hex").slice(0, 12),
            name: name || "Demo User",
            email: email,
            credits: 50,
          };
        }
      },
    })] : []),
  ],
  callbacks: {
    // Every account shares the same MuAPI key (and so the same connected
    // social channels), so sign-in is restricted:
    //  - ALLOWED_EMAILS (comma-separated) if set, otherwise
    //  - only the first account ever created, plus accounts that already exist.
    async signIn({ user }) {
      const email = (user?.email || "").trim().toLowerCase();
      if (!email) return false;

      const allowList = (process.env.ALLOWED_EMAILS || "")
        .split(",")
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);
      if (allowList.length > 0) return allowList.includes(email);

      try {
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) return true;
        const count = await prisma.user.count();
        return count === 0;
      } catch (err) {
        console.error("[AUTH_SIGNIN_CHECK]", err);
        return false;
      }
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.credits = user.credits ?? 50;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id || token.sub;
        session.user.credits = token.credits ?? 50;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET || "free-ai-social-media-scheduler-fallback-secret-2025",
  pages: {
    signIn: "/login",
  },
};

