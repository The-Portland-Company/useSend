-- DEFERRED. Not applied, not part of `prisma migrate deploy`'s migrations
-- directory (kept in prisma/migrations/deferred/ on purpose so tooling never
-- picks it up automatically). Run by hand, once, after every cloud user who
-- previously signed in with GitHub/Google/email has completed at least one
-- TPC Auth sign-in (linked automatically by matching email, since the "tpc"
-- provider is registered with allowDangerousEmailAccountLinking).
--
-- Before running: confirm with
--   select count(*) from "User" u
--   join "Account" a on a.userId = u.id
--   where a.provider in ('github','google') and u."tpcSub" is null;
-- is zero for the cloud database. Do not run this against a self-hosted
-- database -- self-hosted installs have no TPC Auth and still need these
-- sign-in methods.

-- Drop the now-redundant social OAuth account links; TPC Auth is the only
-- sign-in method for the hosted product.
DELETE FROM "Account" WHERE "provider" IN ('github', 'google');

-- Drop any outstanding email magic-link verification tokens; the email
-- provider is no longer registered for the cloud deployment.
DELETE FROM "VerificationToken";

-- Once confirmed unused, these columns/tables can be dropped outright in a
-- later migration:
--   ALTER TABLE "User" DROP COLUMN "isBetaUser";   -- superseded by TPC app grants
--   ALTER TABLE "User" DROP COLUMN "isWaitlisted"; -- superseded by TPC app grants
-- Left in place for now because self-hosted installs (no TPC Auth) still use
-- them for local invite/waitlist gating.
