import { PrismaAdapter } from "@auth/prisma-adapter";
import {
  getServerSession,
  type Account,
  type DefaultSession,
  type NextAuthOptions,
  type Profile,
} from "next-auth";
import { type Adapter, type AdapterUser } from "next-auth/adapters";
import GitHubProvider from "next-auth/providers/github";
import EmailProvider from "next-auth/providers/email";
import GoogleProvider from "next-auth/providers/google";
import { Provider } from "next-auth/providers/index";

import { sendSignUpEmail } from "~/server/mailer";
import { env } from "~/env";
import { db } from "~/server/db";

const GITHUB_OAUTH_ISSUER = "https://github.com/login/oauth";

/**
 * TPC Auth org slug for The Portland Company itself. Roles at or above
 * `TPC_ADMIN_MIN_ROLE` in this org make the person an useSend admin, replacing
 * the old `ADMIN_EMAIL` allowlist -- the role now lives in the token, not in
 * this codebase.
 */
const TPC_ORG_SLUG = "tpc";
const TPC_ADMIN_ROLES = new Set(["admin", "owner"]);

interface TpcOrgClaim {
  slug?: string;
  role?: string;
}

interface TpcProfile extends Profile {
  sub: string;
  picture?: string;
  orgs?: TpcOrgClaim[];
}

function isTpcAdmin(profile: TpcProfile): boolean {
  const orgs = profile.orgs ?? [];
  return orgs.some(
    (org) => org.slug === TPC_ORG_SLUG && TPC_ADMIN_ROLES.has(org.role ?? ""),
  );
}

/**
 * PostgreSQL advisory-lock namespace for self-hosted user creation.
 *
 * The lock serializes only transactions that request this same key; it does not
 * lock the User table or any rows. Because pg_advisory_xact_lock is scoped to
 * the current transaction, PostgreSQL releases it automatically on commit,
 * rollback, or connection loss. A concurrent registration may wait briefly for
 * the active registration transaction to finish.
 */
const SELF_HOSTED_REGISTRATION_LOCK_ID = 1431520590;

export class SelfHostedRegistrationError extends Error {
  constructor() {
    super("A team invitation is required to create an account");
    this.name = "SelfHostedRegistrationError";
  }
}

export async function canRegisterSelfHostedUser(
  email?: string | null,
  account?: Pick<Account, "provider" | "providerAccountId" | "type"> | null,
) {
  // TPC Auth already gated this sign-in: ENFORCE_APP_GRANTS is on in
  // production, so a person only gets here after TPC Auth granted them
  // access to the "usesend" app. Re-checking invites/waitlists for a TPC
  // sign-in would be duplicate authorization logic -- the grant is the
  // authorization.
  if (account?.provider === "tpc") {
    return true;
  }

  if (env.NEXT_PUBLIC_IS_CLOUD) {
    return true;
  }

  if (account?.type === "oauth") {
    const existingAccount = await db.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: account.provider,
          providerAccountId: account.providerAccountId,
        },
      },
      select: { id: true },
    });

    if (existingAccount) {
      return true;
    }
  }

  if (email) {
    const existingUser = await db.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      return true;
    }
  }

  const registeredUser = await db.user.findFirst({
    select: { id: true },
  });

  // An empty installation always allows its bootstrap account.
  if (!registeredUser) {
    return true;
  }

  if (!email) {
    return false;
  }

  const invite = await db.teamInvite.findFirst({
    where: { email },
    select: { id: true },
  });

  return Boolean(invite);
}

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */
declare module "next-auth" {
  // eslint-disable-next-line no-unused-vars
  interface Session extends DefaultSession {
    user: {
      id: number;
      isBetaUser: boolean;
      isAdmin: boolean;
      isWaitlisted: boolean;
      // ...other properties
      // role: UserRole;
    } & DefaultSession["user"];
  }

  // eslint-disable-next-line no-unused-vars
  interface User {
    id: number;
    isBetaUser: boolean;
    isAdmin: boolean;
    isWaitlisted: boolean;
  }
}

/**
 * Auth providers
 */

export function getProviders() {
  const providers: Provider[] = [];

  // GitHub/Google/email sign-in are for community self-hosted installs only,
  // which have no access to TPC Auth (it is closed and invite-only to The
  // Portland Company). The company's own hosted deployment
  // (NEXT_PUBLIC_IS_CLOUD) authenticates exclusively through TPC Auth below.
  if (env.NEXT_PUBLIC_IS_CLOUD) {
    return getTpcProviders();
  }

  if (env.GITHUB_ID && env.GITHUB_SECRET) {
    providers.push(
      GitHubProvider({
        clientId: env.GITHUB_ID,
        clientSecret: env.GITHUB_SECRET,
        // GitHub now includes `iss` on OAuth callbacks, so NextAuth needs the expected issuer.
        issuer: GITHUB_OAUTH_ISSUER,
        allowDangerousEmailAccountLinking: true,
        authorization: {
          params: {
            scope: "read:user user:email",
          },
        },
      }),
    );
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.push(
      GoogleProvider({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }

  const tpc = tpcProvider();
  if (tpc) {
    providers.push(tpc);
  }

  if (env.FROM_EMAIL) {
    providers.push(
      EmailProvider({
        from: env.FROM_EMAIL,
        async sendVerificationRequest({ identifier: email, url, token }) {
          await sendSignUpEmail(email, token, url);
        },
        async generateVerificationToken() {
          return Math.random().toString(36).substring(2, 7).toLowerCase();
        },
      }),
    );
  }

  if (providers.length === 0 && process.env.SKIP_ENV_VALIDATION !== "true") {
    throw new Error("No auth providers found, need atleast one");
  }

  return providers;
}

/**
 * The single sign-in method for the company's own hosted deployment: TPC
 * Auth, via OIDC discovery + authorization code + PKCE (all handled by
 * next-auth's generic OAuth provider). `resource` binds the returned access
 * token's audience to this app so it can only be replayed against useSend.
 */
function tpcProvider(): Provider | null {
  if (!(env.AUTH_TPC_ISSUER && env.AUTH_TPC_ID && env.AUTH_TPC_SECRET)) {
    return null;
  }

  const issuer = env.AUTH_TPC_ISSUER.replace(/\/$/, "");

  return {
    id: "tpc",
    name: "The Portland Company",
    type: "oauth",
    wellKnown: `${issuer}/.well-known/openid-configuration`,
    clientId: env.AUTH_TPC_ID,
    clientSecret: env.AUTH_TPC_SECRET,
    allowDangerousEmailAccountLinking: true,
    authorization: {
      params: {
        scope: "openid profile email offline_access",
        resource: env.AUTH_TPC_RESOURCE,
      },
    },
    idToken: true,
    checks: ["pkce", "state"],
    profile(profile: TpcProfile) {
      // isBetaUser / isWaitlisted are vestigial for TPC sign-ins: TPC Auth's
      // app grant (ENFORCE_APP_GRANTS) is the only gate now, so nobody who
      // reaches this callback is waitlisted. isAdmin is refreshed from
      // ctx.orgs on every sign-in in the `signIn` callback below, since a
      // role change shouldn't need a new account.
      return {
        // NextAuth only uses this as a placeholder until the Prisma adapter
        // creates/looks up the real (numeric, DB-assigned) user id; the
        // augmented `User.id: number` type doesn't reflect that, and the
        // inline-object providers elsewhere in this file get away with the
        // same mismatch only because object-literal methods are checked
        // bivariantly. Cast rather than change runtime behavior.
        id: profile.sub as unknown as number,
        email: profile.email,
        name: profile.name,
        image: profile.picture,
        isBetaUser: true,
        isAdmin: isTpcAdmin(profile),
        isWaitlisted: false,
      };
    },
  };
}

function getTpcProviders(): Provider[] {
  const provider = tpcProvider();
  if (!provider) {
    if (process.env.SKIP_ENV_VALIDATION === "true") {
      return [];
    }
    throw new Error(
      "AUTH_TPC_ISSUER/AUTH_TPC_ID/AUTH_TPC_SECRET are required when NEXT_PUBLIC_IS_CLOUD is set",
    );
  }
  return [provider];
}

/**
 * Options for NextAuth.js used to configure adapters, providers, callbacks, etc.
 *
 * @see https://next-auth.js.org/configuration/options
 */
export const authOptions: NextAuthOptions = {
  callbacks: {
    signIn: async ({ user, account, profile }) => {
      const allowed = await canRegisterSelfHostedUser(user.email, account);
      if (!allowed) {
        return false;
      }

      // Refresh isAdmin from the token's org role on every TPC sign-in, not
      // just at account creation, so a role change at the IdP takes effect
      // on the person's next login instead of needing a new local account.
      if (account?.provider === "tpc" && typeof user.id === "number") {
        await db.user.update({
          where: { id: user.id },
          data: { isAdmin: isTpcAdmin(profile as TpcProfile) },
        });
      }

      return true;
    },
    session: ({ session, user }) => ({
      ...session,
      user: {
        ...session.user,
        id: user.id,
        isBetaUser: user.isBetaUser,
        isAdmin: user.isAdmin,
        isWaitlisted: user.isWaitlisted,
      },
    }),
  },
  adapter: (() => {
    const prismaAdapter = PrismaAdapter(db);

    return {
      ...prismaAdapter,
      async createUser(user: AdapterUser) {
        if (env.NEXT_PUBLIC_IS_CLOUD) {
          if (!prismaAdapter.createUser) {
            throw new Error("Prisma adapter does not support user creation");
          }

          return prismaAdapter.createUser(user);
        }

        return db.$transaction(async (tx) => {
          // Acquire the lock before checking for the first user. Without this,
          // two concurrent callbacks could both observe an empty User table and
          // both create an account without an invitation.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SELF_HOSTED_REGISTRATION_LOCK_ID})`;

          const registeredUser = await tx.user.findFirst({
            select: { id: true },
          });

          if (registeredUser) {
            if (!user.email) {
              throw new SelfHostedRegistrationError();
            }

            const invite = await tx.teamInvite.findFirst({
              where: { email: user.email },
              select: { id: true },
            });

            if (!invite) {
              throw new SelfHostedRegistrationError();
            }
          }

          return tx.user.create({
            data: {
              name: user.name,
              email: user.email,
              emailVerified: user.emailVerified,
              image: user.image,
            },
          });
        });
      },
    } as Adapter;
  })(),
  pages: {
    signIn: "/login",
  },
  events: {
    createUser: async ({ user }) => {
      let invitesAvailable = false;

      if (user.email) {
        const invites = await db.teamInvite.findMany({
          where: { email: user.email },
        });

        invitesAvailable = invites.length > 0;
      }

      if (
        !env.NEXT_PUBLIC_IS_CLOUD ||
        env.NODE_ENV === "development" ||
        invitesAvailable
      ) {
        await db.user.update({
          where: { id: user.id },
          data: { isBetaUser: true },
        });
      } else {
        await db.user.update({
          where: { id: user.id },
          data: { isBetaUser: true, isWaitlisted: true },
        });
      }
    },
  },
  providers: getProviders(),
};

/**
 * Wrapper for `getServerSession` so that you don't need to import the `authOptions` in every file.
 *
 * @see https://next-auth.js.org/configuration/nextjs
 */
export const getServerAuthSession = () => getServerSession(authOptions);
