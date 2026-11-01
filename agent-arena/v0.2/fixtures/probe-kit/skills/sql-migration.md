# Skill: SQL migration

Use when a database schema changes.

1. Add `migrations/NNN_<name>.sql` with forward and rollback sections.
2. Never edit a migration that has already shipped.
