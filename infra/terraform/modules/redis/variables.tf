# Managed Redis.
#
# Never a system of record (02-technology-stack.md §4). Losing it costs throughput, not
# data — which is a design constraint on every feature that touches it.

variable "name" { type = string }
variable "environment" { type = string }

variable "persistence" {
  description = "Enabled so a restart does not drop every delayed job at once; the outbox makes recovery correct either way."
  type        = bool
  default     = true
}

variable "maxmemory_policy" {
  description = "allkeys-lru is wrong here: BullMQ job state is not a cache and must not be evicted under pressure."
  type        = string
  default     = "noeviction"

  validation {
    condition     = contains(["noeviction", "volatile-lru", "volatile-ttl"], var.maxmemory_policy)
    error_message = "Queue state must never be evicted; allkeys-* policies are not permitted."
  }
}
