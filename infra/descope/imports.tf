# Both resources are singletons whose id is the project id. Importing them on every
# run lets a run with empty state plan the real difference instead of a create.
import {
  to = descope_project_settings.dev
  id = var.project_id
}

import {
  to = descope_otp_settings.dev
  id = var.project_id
}
