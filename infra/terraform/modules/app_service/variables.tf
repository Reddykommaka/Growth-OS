# One containerised application.
#
# Provider-agnostic on purpose: these are the inputs any container platform needs, so the
# choice of platform is a change of implementation, not of interface.

variable "name" {
  description = "Service name, e.g. api, web, worker, link."
  type        = string
}

variable "image" {
  description = "Fully qualified, immutable image reference. A tag that can move is not deployable — roll back by redeploying a digest."
  type        = string

  validation {
    condition     = can(regex("@sha256:", var.image))
    error_message = "Image must be pinned by digest so a rollback is exact."
  }
}

variable "environment" {
  description = "development | test | staging | production"
  type        = string

  validation {
    condition     = contains(["development", "test", "staging", "production"], var.environment)
    error_message = "Unknown environment."
  }
}

variable "min_instances" {
  description = "Floor. Must be >= 2 in production so a single instance failure is not an outage."
  type        = number
  default     = 1
}

variable "max_instances" {
  type    = number
  default = 4
}

variable "cpu" {
  type    = string
  default = "0.5"
}

variable "memory_mb" {
  type    = number
  default = 512
}

variable "liveness_path" {
  description = "Checks nothing external. A failing dependency must not restart a healthy process."
  type        = string
  default     = "/healthz"
}

variable "readiness_path" {
  description = "Checks database, Redis and schema version. Removes an instance from the load balancer without killing it."
  type        = string
  default     = "/readyz"
}

variable "scale_metric" {
  description = <<-EOT
    Workers autoscale on queue depth and oldest-job age, not CPU
    (12-devops-architecture.md §2): a backlog of delayed publishing jobs consumes almost no
    CPU while being an urgent, customer-facing problem.
  EOT
  type        = string
  default     = "requests"

  validation {
    condition     = contains(["requests", "cpu", "queue_depth"], var.scale_metric)
    error_message = "scale_metric must be requests, cpu or queue_depth."
  }
}

variable "secret_names" {
  description = "Names only. Values are set out of band; a secret in Terraform state is a secret in a widely readable file."
  type        = list(string)
  default     = []
}

variable "environment_variables" {
  description = "Non-secret configuration, validated at boot by packages/platform/config."
  type        = map(string)
  default     = {}
}
