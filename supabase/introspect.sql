-- ============================================================================
-- Supabase Schema Introspection Query
--
-- Instructions:
-- 1. Open the Supabase Dashboard -> SQL Editor.
-- 2. Paste and run this entire query.
-- 3. Click "Export to CSV" (or "Download as CSV") in the results panel.
-- 4. Save the file to: supabase/live-schema.csv
-- ============================================================================

SELECT
  'COLUMN' AS section,
  c.table_name AS object_name,
  c.column_name AS property_name,
  c.data_type || CASE 
    WHEN c.character_maximum_length IS NOT NULL THEN '(' || c.character_maximum_length || ')'
    WHEN c.udt_name = 'citext' THEN ' (citext)'
    ELSE ''
  END AS detail_1,
  c.is_nullable AS detail_2,
  COALESCE(c.column_default, '') AS detail_3
FROM information_schema.columns c
WHERE c.table_schema = 'public'

UNION ALL

SELECT
  'POLICY' AS section,
  p.tablename AS object_name,
  p.policyname AS property_name,
  p.cmd || ' (' || p.permissive || ')' AS detail_1,
  array_to_string(p.roles, ', ') AS detail_2,
  COALESCE(p.qual, '') || CASE 
    WHEN p.with_check IS NOT NULL THEN ' [CHECK: ' || p.with_check || ']' 
    ELSE '' 
  END AS detail_3
FROM pg_policies p
WHERE p.schemaname = 'public'

UNION ALL

SELECT
  'ROUTINE_PRIVILEGE' AS section,
  r.routine_name AS object_name,
  r.grantee AS property_name,
  r.privilege_type AS detail_1,
  r.is_grantable AS detail_2,
  COALESCE(r.specific_name, '') AS detail_3
FROM information_schema.routine_privileges r
WHERE r.routine_schema = 'public'

ORDER BY section, object_name, property_name;
