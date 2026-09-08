-- Requires the source-owned public workforce resolver migration first. This
-- deliberate dependency makes existing Carbon deactivation immediately effective.
SET LOCAL ROLE knowledge_migrate;
CREATE OR REPLACE FUNCTION knowledge.actor_active(company text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT company=knowledge.company_id() AND EXISTS (
  SELECT 1 FROM knowledge."identityBinding" binding
  CROSS JOIN LATERAL (SELECT public.knowledge_resolve_workforce_identity(binding.issuer,binding.subject,binding."companyId") AS value) current_identity
  WHERE binding."companyId"=company AND binding."canonicalUserId"=knowledge.actor_id() AND binding.active
  AND current_identity.value->>'bindingActive'='true'
  AND current_identity.value->>'userActive'='true'
  AND current_identity.value->>'membershipActive'='true'
 );
$$;
RESET ROLE;
