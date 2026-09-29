-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "tpcOrgId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Team_tpcOrgId_key" ON "Team"("tpcOrgId");

-- CreateTable: backing store for TPC-Auth's postgresCounterStore, keyed by
-- the composite cap key ("cap:email.send:<actor>:<yyyy-mm-dd>") the SDK
-- builds in rate-limit.ts's dailyCap().
CREATE TABLE "TpcRateLimitCounter" (
    "key"       TEXT NOT NULL,
    "count"     INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TpcRateLimitCounter_pkey" PRIMARY KEY ("key")
);

-- postgresCounterStore(query) calls `select incr_quota_counter($1, $2) as count`
-- with ($1 = key, $2 = ttlSec). This atomically upserts the row, resets the
-- count if the previous window expired, and returns the post-increment count.
CREATE OR REPLACE FUNCTION incr_quota_counter(p_key TEXT, p_ttl_sec INTEGER)
RETURNS INTEGER AS $$
DECLARE
    v_count INTEGER;
BEGIN
    INSERT INTO "TpcRateLimitCounter" ("key", "count", "expiresAt", "updatedAt")
    VALUES (p_key, 1, now() + (p_ttl_sec || ' seconds')::interval, now())
    ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
            WHEN "TpcRateLimitCounter"."expiresAt" < now() THEN 1
            ELSE "TpcRateLimitCounter"."count" + 1
        END,
        "expiresAt" = CASE
            WHEN "TpcRateLimitCounter"."expiresAt" < now() THEN now() + (p_ttl_sec || ' seconds')::interval
            ELSE "TpcRateLimitCounter"."expiresAt"
        END,
        "updatedAt" = now()
    RETURNING "count" INTO v_count;

    RETURN v_count;
END;
$$ LANGUAGE plpgsql;
