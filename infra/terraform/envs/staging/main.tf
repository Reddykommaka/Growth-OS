# Staging.
#
# Production-shaped, with SYNTHETIC data at production scale — never a copy of production
# (12-devops-architecture.md §1). Copying real data into a lower-trust environment is the
# most common way customer PII escapes its controls.

terraform {
  required_version = ">= 1.9"

  # Remote state with locking, one backend per environment. State holds connection strings
  # and is treated as secret. The backend block is intentionally empty: it is filled in via
  # `-backend-config` at init, so the provider choice (open question #7) does not have to be
  # made here to make the rest of this reviewable.
  backend "local" {}
}

locals {
  environment = "staging"

  # Non-secret configuration only. Every value is validated at boot by
  # packages/platform/config, which fails the process rather than surfacing a
  # misconfiguration later as a runtime surprise.
  common_env = {
    APP_ENV      = local.environment
    NODE_ENV     = "production"
    LOG_LEVEL    = "info"
    LOG_PRETTY   = "false"
    SERVICE_NAME = "growth-os"
  }

  # Names only. Values are set out of band in the secret store.
  common_secrets = [
    "DATABASE_URL",
    "REDIS_URL",
    "SESSION_COOKIE_SECRET",
    "ENCRYPTION_MASTER_KEY",
    "SENTRY_DSN",
  ]
}

variable "image_digest" {
  description = "Immutable image digest built by CI. Never a moving tag: a rollback must be exact."
  type        = string
}

variable "registry" {
  type = string
}

module "postgres" {
  source = "../../modules/postgres"

  name                        = "growth-os-staging"
  environment                 = local.environment
  postgres_version            = "16"
  point_in_time_recovery_days = 7
  connection_pooler           = "transaction"
  read_replica_count          = 0
}

module "redis" {
  source = "../../modules/redis"

  name        = "growth-os-staging"
  environment = local.environment
}

module "storage" {
  source = "../../modules/object_storage"

  environment              = local.environment
  application_bucket_name  = "growth-os-staging-app"
  user_content_bucket_name = "growth-os-staging-user-content"
  # A separate registrable domain, so a stored payload cannot reach application cookies.
  user_content_origin = "usercontent-staging.growth-os.dev"
}

# ---------------------------------------------------------------- applications

module "api" {
  source = "../../modules/app_service"

  name          = "api"
  environment   = local.environment
  image         = "${var.registry}/growth-os-api@${var.image_digest}"
  min_instances = 1
  max_instances = 3
  scale_metric  = "requests"
  secret_names  = local.common_secrets
  environment_variables = merge(local.common_env, {
    PORT                = "3000"
    USER_CONTENT_ORIGIN = "https://${module.storage.user_content_origin}"
  })
}

module "web" {
  source = "../../modules/app_service"

  name          = "web"
  environment   = local.environment
  image         = "${var.registry}/growth-os-web@${var.image_digest}"
  min_instances = 1
  max_instances = 3
  scale_metric  = "requests"
  secret_names  = local.common_secrets
  environment_variables = merge(local.common_env, { PORT = "3000" })
}

module "worker" {
  source = "../../modules/app_service"

  name        = "worker"
  environment = local.environment
  image       = "${var.registry}/growth-os-worker@${var.image_digest}"
  # Queue depth, not CPU: a backlog of delayed publishing jobs consumes almost no CPU while
  # being an urgent, customer-facing problem (12-devops-architecture.md §2).
  scale_metric  = "queue_depth"
  min_instances = 1
  max_instances = 4
  secret_names  = local.common_secrets
  environment_variables = local.common_env
}

module "link" {
  source = "../../modules/app_service"

  name        = "link"
  environment = local.environment
  image       = "${var.registry}/growth-os-link@${var.image_digest}"
  # Separated from web deliberately: it is the attribution spine's entry point, has a 50ms
  # p99 budget, and must survive a dashboard incident (09-analytics-architecture.md §3).
  min_instances = 1
  max_instances = 4
  scale_metric  = "requests"
  memory_mb     = 256
  secret_names  = ["DATABASE_URL", "REDIS_URL"]
  environment_variables = merge(local.common_env, { PORT = "3000" })
}
