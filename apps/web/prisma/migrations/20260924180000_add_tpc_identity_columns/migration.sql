-- Additive only. Adds TPC Auth identity columns alongside the existing local
-- identity columns; nothing is dropped or backfilled here. See
-- prisma/deferred-migrations/20260924180100_drop_legacy_identity.sql
-- for the (unapplied) follow-up that removes the local columns once every
-- User/Team row has been linked to its TPC `sub` / org id.

-- User.tpcSub: the TPC Auth person id ("sub" claim). Nullable until every
-- existing user has signed in through TPC Auth at least once (self-hosted
-- installs without TPC Auth configured will simply never populate it).
ALTER TABLE "User" ADD COLUMN "isAdmin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "tpcSub" TEXT;
CREATE UNIQUE INDEX "User_tpcSub_key" ON "User"("tpcSub");

-- Team.tpcOrgId: the TPC Auth org id that owns this team's resources, once
-- re-keyed. Not backfilled or enforced by this migration.
ALTER TABLE "Team" ADD COLUMN "tpcOrgId" TEXT;
CREATE INDEX "Team_tpcOrgId_idx" ON "Team"("tpcOrgId");
