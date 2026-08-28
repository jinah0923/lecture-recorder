import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";

// Shared between the NextAuth route handler (app/api/auth/[...nextauth])
// and every server-side getServerSession() call (e.g. app/api/sync) — both
// must use the exact same options for session/JWT validation to agree.
export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  callbacks: {
    // Google's OIDC profile always carries an email for this app's scope
    // (openid email profile, the provider default), but it only reaches the
    // token on first sign-in (`profile` is undefined on later JWT refreshes)
    // — so it's copied onto the token here to persist across those.
    async jwt({ token, profile }) {
      if (profile?.email) {
        token.email = profile.email;
      }
      return token;
    },
    // The default session callback already forwards token fields that share
    // a name with Session.user (email included), but this is spelled out
    // explicitly since cloud sync (app/api/sync) depends on session.user.email
    // always being present for a signed-in user.
    async session({ session, token }) {
      if (session.user && typeof token.email === "string") {
        session.user.email = token.email;
      }
      return session;
    },
  },
};
