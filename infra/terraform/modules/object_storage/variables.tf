# Object storage.
#
# TWO buckets, and the separation is a security control, not organisation
# (10-security-architecture.md §2): user content is served from a different origin so a
# stored payload cannot reach application cookies.

variable "environment" { type = string }

variable "application_bucket_name" {
  description = "Private. Exports, backups, internal artefacts. Never publicly readable."
  type        = string
}

variable "user_content_bucket_name" {
  description = "Uploads, served from a SEPARATE origin via short-lived presigned URLs."
  type        = string
}

variable "user_content_origin" {
  description = "The distinct hostname user content is served from. Must not share the application's registrable domain, or cookies are in scope."
  type        = string
}

variable "versioning" {
  description = "Enabled so an accidental overwrite is recoverable."
  type        = bool
  default     = true
}

variable "cold_storage_after_days" {
  description = "Detached analytics partitions are archived here as Parquet (05-data-architecture.md §10)."
  type        = number
  default     = 90
}
