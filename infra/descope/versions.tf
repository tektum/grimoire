terraform {
  required_version = ">= 1.9"

  required_providers {
    descope = {
      source  = "descope/descope"
      version = "1.2.0"
    }
  }
}

# The management key comes from the environment variable DESCOPE_MANAGEMENT_KEY.
# It is never written in a file.
provider "descope" {}
