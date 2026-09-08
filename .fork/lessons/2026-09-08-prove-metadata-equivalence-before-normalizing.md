# Prove metadata equivalence before normalizing

Context → Independent migration-built databases produced different Swagger
primary-key annotations for two aliases of the same `partner.id` column.

Problem → PostgREST 13.0.8 chooses the first duplicate alias from an unordered
aggregation. Ignoring description differences globally would also hide foreign-key
and other contract changes that downstream consumers use.

Rule → Correct only the known producer variation after verifying the actual view
definition and composite key through the same database service. Preserve other
metadata, reject changed assumptions, and retain strict artifact comparison.
Exercise both equivalent variants and negative cases, then repeat fresh/upgrade
generation. A generator or catalog-query change must select schema verification.

Applies to → `scripts/lib/swagger-schema.ts`, its catalog proof and regression
tests, the generated-artifact registry, and future generator compatibility fixes.
