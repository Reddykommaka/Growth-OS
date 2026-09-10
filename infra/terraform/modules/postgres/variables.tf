# Managed PostgreSQL.

variable "name" { type = string }

variable "environment" { type = string }

variable "postgres_version" {
  description = "16+ is required: RLS FORCE, declarative partitioning and generated columns are all load-bearing (05-data-architecture.md)."
  type        = string
  default     = "16"

  validation {
    condition     = tonumber(split(".", var.postgres_version)[0]) >= 16
    error_message = "PostgreSQL 16 or later is required."
  }
}

variable "extensions" {
  description = <<-EOT
    pgvector is the one extension a default install does not provide, and migration 0001
    fails loudly without it. See docs/runbooks/database-prerequisites.md.
  EOT
  type        = list(string)
  default     = ["pgcrypto", "citext", "pg_trgm", "vector"]
}

variable "point_in_time_recovery_days" {
  description = "RPO <= 5 minutes, restore to any second within the window (12-devops-architecture.md §6)."
  type        = number
  default     = 30

  validation {
    condition     = var.point_in_time_recovery_days >= 7
    error_message = "A PITR window shorter than 7 days cannot satisfy the documented recovery targets."
  }
}

variable "read_replica_count" {
  description = "Reports and exports route here via an explicit readOnly flag, never inferred."
  type        = number
  default     = 0
}

variable "connection_pooler" {
  description = <<-EOT
    Transaction-mode pooling is REQUIRED before any horizontal app scaling. Tenant context
    uses SET LOCAL precisely because session-level SET leaks across pooled connections
    (06-identity-and-access.md §4) — enabling session mode would silently break isolation.
  EOT
  type        = string
  default     = "transaction"

  validation {
    condition     = contains(["transaction", "session", "none"], var.connection_pooler)
    error_message = "connection_pooler must be transaction, session or none."
  }
}
