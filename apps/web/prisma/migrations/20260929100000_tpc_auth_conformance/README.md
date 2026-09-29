# tpc_auth_conformance migration notes

Not executed as part of this change (migrate is not run here).

## Seeding `Team.tpcOrgId`

Once applied, existing teams need their TPC org id backfilled by hand (there is
no automatic mapping from a legacy usesend Team to a TPC org). Example seed for
a single team, for reference only — do not run without confirming the real
`tpcOrgId` value with the TPC org owner:

```sql
-- UPDATE "Team" SET "tpcOrgId" = '<tpc-org-id>' WHERE "id" = '<team-id>';
```
