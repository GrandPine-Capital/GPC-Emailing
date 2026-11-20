-- Where the service connects as a different role from the one that runs these migrations, a
-- table created here is not readable by it until it is granted. Give `forms` (created in V3)
-- the same grants the older tables carry, to the same roles. Nothing to do where one role owns
-- and uses everything.
DO $$
DECLARE
    g record;
BEGIN
    FOR g IN
        SELECT DISTINCT grantee, privilege_type
        FROM information_schema.role_table_grants
        WHERE table_schema = current_schema() AND table_name = 'lists'
          AND grantee NOT IN (current_user, 'PUBLIC')
    LOOP
        EXECUTE format('GRANT %s ON TABLE forms TO %I', g.privilege_type, g.grantee);
    END LOOP;
END
$$;
