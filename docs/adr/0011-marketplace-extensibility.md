# ADR-0011 — Listing types with typed attribute values

**Status:** Proposed · **Date:** 2026-09-10

## Context
The marketplace must span software, templates, content packs, playbooks, automation
workflows, services, experts, agencies, creators and digital products — and the directive
requires new categories without restructuring the database.

## Decision
A single `listings` table for shared concerns (ownership, status, slug, pricing plans,
media, ratings, moderation). Category-specific data is modelled as `listing_types` →
`attribute_definitions` → `listing_attribute_values`, where values are stored in **typed
columns** (`value_text`, `value_numeric`, `value_boolean`, `value_timestamp`, `value_json`)
rather than as untyped blobs. Each listing type declares a JSON Schema validated on write.

## Alternatives considered
- **A table per listing type.** Rejected: every new category becomes a migration, a set of
  queries and a code path. Cross-category search becomes a union that grows without bound.
- **A single `jsonb` attributes column.** Rejected: filtering and faceting over `jsonb`
  cannot use ordinary btree indexes well, values are unconstrained, and reporting degrades.
- **Fully generic EAV with all values as text.** Rejected: numeric and date range filters
  (price, delivery time, rating) become string comparisons.

## Consequences
**Positive:** a new category is configuration — rows, not migrations; facets are filterable
and indexable per category; one search path covers all categories.

**Negative:** queries join through an attribute table; the schema registry must be
maintained; some type safety moves from the database to validated schemas.

**Mitigation:** filterable attributes are indexed per `(listing_type_id,
attribute_definition_id, value_*)`; a search index materialises facets for discovery; rich
domains (e.g. services with SLAs and engagement models) may still get a dedicated detail
table when the complexity justifies it.
